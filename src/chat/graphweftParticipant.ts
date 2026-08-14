import * as vscode from 'vscode';
import { buildGraphweftContextPackage } from '../context/contextCompressor';
import { classifyTask } from '../context/taskClassifier';
import { getGitDiffContext } from '../git/gitDiffProvider';
import { GraphRetriever } from '../graph/graphRetriever';
import { GraphStore } from '../graph/graphStore';
import { WorkspaceIndexer } from '../indexer/workspaceIndexer';
import { AuditLog } from '../privacy/auditLog';
import { PrivacyManager } from '../privacy/privacyManager';
import { computeNaiveBaselineBytes, computeNaiveBaselineTokens } from '../privacy/baselineComputer';
import { clampTokenBudget } from '../utils/tokenEstimator';
import { handleSlashLocally, parseSlash } from './slashCommands';
import { buildGraphweftPrompt } from './promptBuilder';
import { contextFooter, fallbackAnswer, modelErrorMessage, noWorkspaceMessage } from './responsePolicy';
import { runAgentLoop } from './agentRunner';
import { GRAPHWEFT_TOOL_NAMES } from './agentTools';
import { TaskType } from '../context/taskClassifier';
import { ComplexityTier } from '../context/complexityScorer';
import { GraphweftContextPackage } from '../context/contextPackage';
import { classifyComplexity } from './complexityClassifier';
import { ModelPreferenceStore } from '../privacy/modelPreferenceStore';
import { listChatModels } from './modelAdvisor';
import { SemanticIndexer } from '../semantic/semanticIndexer';
import { profileModels } from './modelRegistry';
import { deriveRequirement, recommendModels, roleBadge, Recommendation } from './modelRecommender';
import { estimateTokens } from '../utils/tokenEstimator';

export const graphweftParticipantId = 'graphweft.chat';

/** Command fired by the in-chat model-switch buttons; re-runs the query with a forced model. */
const ANSWER_WITH_COMMAND = 'graphweft.answerWith';

interface AnswerWithPayload {
  query: string;
  modelId: string;
  modelName: string;
  tier: ComplexityTier;
}

/**
 * Queries the user asked to answer with a specific model (set when a switch button is
 * clicked, consumed on the next participant turn). Keyed by normalized query hash.
 * In-memory only — it's a one-shot hand-off between the button click and the re-run.
 */
const pendingModelOverrides = new Map<string, string>();

/**
 * Models that `selectChatModels()` advertised but that turned out to be unusable this session
 * (couldn't be resolved when clicked, or errored on first send — e.g. catalog entries the user
 * isn't actually entitled to). We never suggest these again, so a bad pick can't keep breaking.
 * In-memory only; cleared on reload.
 */
const unusableModelIds = new Set<string>();

export interface ParticipantDeps {
  store: GraphStore;
  indexer: WorkspaceIndexer;
  privacy: PrivacyManager;
  audit: AuditLog;
  modelPrefs: ModelPreferenceStore;
  /** Opt-in local semantic index; when absent or disabled, retrieval stays lexical+graph. */
  semantic?: SemanticIndexer;
  iconUri?: vscode.Uri;
}

export function registerGraphweftParticipant(deps: ParticipantDeps): vscode.Disposable {
  const { store, indexer, privacy, audit, modelPrefs, semantic } = deps;

  const participant = vscode.chat.createChatParticipant(graphweftParticipantId, async (request, context, stream, token) => {
    const task = request.prompt.trim();

    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      stream.markdown(noWorkspaceMessage());
      return;
    }

    // Registered participant commands (the `/savings` chip in the input box) arrive in
    // `request.command`, with any extra text in `request.prompt`. Handle those first;
    // they all run locally and never call the model.
    if (request.command) {
      const handled = await handleSlashLocally(
        { command: request.command.toLowerCase(), args: task ? task.split(/\s+/u) : [], rest: task },
        { store, privacy, audit, stream, currentModelId: request.model.id },
      );
      if (handled) return;
    }

    if (!task) {
      stream.markdown('Ask Graphweft what you want to understand, fix, test, review, or analyze. Try `/help` for slash commands.');
      return;
    }

    // Also support slash commands typed literally into the prompt (e.g. unregistered ones).
    const slash = parseSlash(task);
    if (slash) {
      const handled = await handleSlashLocally(slash, { store, privacy, audit, stream, currentModelId: request.model.id });
      if (handled) return;
    }

    let indexingError: string | undefined;
    try {
      if (!store.hasIndex()) {
        stream.progress('Building local Graphweft index...');
        const result = await indexer.ensureFresh();
        if (result) {
          if (result.filesIndexed === 0) {
            stream.markdown(
              'Graphweft found no indexable source files in this workspace. ' +
              'Files inside `node_modules`, `dist`, `build`, `coverage`, `.git`, `__pycache__`, and `.venv` are excluded. ' +
              'To trigger a manual rebuild, run **Graphweft: Build Local Index** from the Command Palette.',
            );
            return;
          }
          stream.progress(`Indexed ${result.filesIndexed} files and ${result.symbolsIndexed} symbols locally.`);
        }
      } else if (indexer.hasPendingChanges()) {
        // Reconcile watcher-queued file changes (agent writes, git ops, terminal
        // commands) so retrieval never runs against a stale graph.
        await indexer.ensureFresh();
      }
    } catch (error) {
      indexingError = error instanceof Error ? error.message : String(error);
      stream.progress(`Indexing failed; continuing with available context. ${indexingError}`);
    }

    const taskType = classifyTask(task);
    const gitDiff = await getGitDiffContext();
    // Code/files the user explicitly attached to the message (selection chips, file refs).
    // These arrive in request.references, NOT request.prompt — without resolving them the
    // model never sees "this" and asks the user to paste the code.
    const attachedRefs = await resolveChatReferences(request);
    if (attachedRefs.length > 0) {
      // Confirm to the user (and make it observable) that the attached code was captured.
      stream.markdown(
        `> 📎 Using your attached ${attachedRefs.length === 1 ? 'selection' : 'attachments'}: ${attachedRefs.map((r) => `\`${r.label}\``).join(', ')}\n\n`,
      );
    }
    const retriever = new GraphRetriever(store);
    const tokenBudget = clampTokenBudget(6000, request.model.maxInputTokens);
    // Opt-in local semantic search: one loopback embedding call for the query (never the
    // code), then cosine search over locally stored vectors. Quietly [] when off/unbuilt.
    const semanticMatches = semantic ? await semantic.search(task) : [];
    const referencePaths = attachedRefs.map((r) => r.path).filter((p): p is string => Boolean(p));
    const retrieval = retriever.retrieve(task, tokenBudget, {
      activeFilePath: getActiveFilePath(),
      openFilePaths: [...getOpenFilePaths(), ...referencePaths],
      changedFilePaths: gitDiff.changedFiles,
      semanticMatches,
    });
    const contextPackage = buildGraphweftContextPackage({
      task,
      taskType,
      retrieval,
      gitDiff,
      maxTokens: tokenBudget,
      indexingError,
    });
    const prompt = buildGraphweftPrompt({
      contextPackage,
      indexingError,
      gitError: gitDiff.error,
      attachedReferences: renderAttachedReferences(attachedRefs),
    });

    const naiveBaselineBytes = await computeNaiveBaselineBytes(
      contextPackage.relevantFiles.map((f) => f.path),
    );

    if (privacy.isLocalOnly()) {
      stream.markdown(
        [
          '> 🔒 **Local-only mode is on** — Graphweft will not send anything to the language model.',
          '',
          'Below is the local context that *would* have been sent if local-only were off. Switch the mode in the Privacy Center (`/privacy`) to enable model calls.',
          '',
          '```json',
          JSON.stringify(contextPackage, null, 2),
          '```',
        ].join('\n'),
      );
      await audit.append({
        task,
        taskType,
        modelId: request.model.id,
        modelVendor: request.model.vendor,
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
        promptSha256: AuditLog.hashPrompt(prompt),
        filesIncluded: contextPackage.relevantFiles.map((f) => f.path),
        symbolsIncluded: contextPackage.importantSymbols.map((s) => s.name),
        snippetsIncluded: contextPackage.snippets.length,
        outcome: 'blocked',
        naiveBaselineBytes,
      });
      return;
    }

    if (privacy.requiresPreview()) {
      const filesPreview = contextPackage.relevantFiles.slice(0, 8).map((f) => `- ${f.path}`).join('\n') || '- (none)';
      const choice = await vscode.window.showInformationMessage(
        `Graphweft is about to send ${Buffer.byteLength(prompt, 'utf8')} bytes of local context to ${request.model.vendor}/${request.model.id}.`,
        { modal: true, detail: `Files included:\n${filesPreview}\n\nSwitch mode in the Privacy Center to change this prompt behavior.` },
        'Send',
        'Cancel',
      );
      if (choice !== 'Send') {
        stream.markdown('Request cancelled. Nothing was sent to the model.');
        await audit.append({
          task,
          taskType,
          modelId: request.model.id,
          modelVendor: request.model.vendor,
          promptBytes: Buffer.byteLength(prompt, 'utf8'),
          promptSha256: AuditLog.hashPrompt(prompt),
          filesIncluded: contextPackage.relevantFiles.map((f) => f.path),
          symbolsIncluded: contextPackage.importantSymbols.map((s) => s.name),
          snippetsIncluded: contextPackage.snippets.length,
          outcome: 'cancelled',
          naiveBaselineBytes,
        });
        return;
      }
    }

    // Decide which model actually answers. If the user previously clicked an in-chat
    // switch button for this exact query, honour that forced choice and skip the prompt.
    // Otherwise classify the query and (on a mismatch) post switch buttons, deferring the
    // answer until one is clicked.
    let activeModel = request.model;
    const overrideKey = ModelPreferenceStore.hashQuery(task);
    const forcedModelId = pendingModelOverrides.get(overrideKey);
    if (forcedModelId) {
      pendingModelOverrides.delete(overrideKey);
      // Re-fetch the current available-models list and answer only with a model that is
      // actually in it right now — never with a stale/phantom pick.
      const available = await listChatModels();
      const resolved =
        forcedModelId === request.model.id ? request.model : available.find((m) => m.id === forcedModelId);
      if (resolved) {
        activeModel = resolved;
        if (activeModel.id !== request.model.id) {
          stream.markdown(`> 🔀 Answering with **${activeModel.name}** (your pick). Global model picker unchanged.\n\n`);
        }
      } else {
        // Not in the available list — don't silently answer with a different model. Say so,
        // remember it so we stop suggesting it, and use the model you currently have.
        unusableModelIds.add(forcedModelId);
        activeModel = request.model;
        stream.markdown(`> ⚠️ That model isn't in your available models, so Graphweft is answering with **${request.model.name}** instead. It won't be suggested again this session.\n\n`);
      }
    } else {
      const decision = await decideActiveModel({
        task,
        taskType,
        contextPackage,
        prompt,
        request,
        prefs: modelPrefs,
        privacy,
        stream,
        token,
      });
      if (decision.kind === 'awaiting') {
        // Switch buttons were posted; the answer is generated when the user clicks one.
        return;
      }
      activeModel = decision.model;
    }

    const startedAt = Date.now();
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    try {
      // Thread prior turns of THIS chat session so follow-ups like "edit these with the
      // above analysis" resolve against what was already said — without this the model
      // sees only the current question and has no memory of the conversation.
      const history = historyToMessages(context, request.model.maxInputTokens);
      const loopResult = await runAgentLoop({
        model: activeModel,
        messages: [...history, vscode.LanguageModelChatMessage.User(prompt)],
        tools: collectAgentTools(),
        toolInvocationToken: request.toolInvocationToken,
        stream,
        token,
        maxRounds: agentStepBudget(),
        continueQuery: task,
        justification:
          'Graphweft sends compact local code graph context to the Copilot model selected by the user, and lets that model run workspace tools (with confirmation) to fulfil the request.',
      });

      // Measure with the model's real tokenizer (not bytes/4): the actual first-context tokens
      // and the naive "dump every relevant file" baseline, plus the whole-loop input total.
      const promptTokens = await safeCountTokens(activeModel, prompt, token);
      const baselineTokens = await computeNaiveBaselineTokens(
        activeModel,
        contextPackage.relevantFiles.map((f) => f.path),
        token,
      );
      const totalInputTokens = loopResult.inputTokens > 0 ? loopResult.inputTokens : undefined;
      const outputTokens = loopResult.outputTokens > 0 ? loopResult.outputTokens : undefined;

      stream.markdown(contextFooter(contextPackage));
      stream.markdown(
        savingsFooter({ promptBytes, naiveBaselineBytes, promptTokens, baselineTokens, totalInputTokens, outputTokens }),
      );
      privacy.recordRequest(promptBytes);
      await audit.append({
        task,
        taskType,
        modelId: activeModel.id,
        modelVendor: activeModel.vendor,
        promptBytes,
        promptSha256: AuditLog.hashPrompt(prompt),
        filesIncluded: contextPackage.relevantFiles.map((f) => f.path),
        symbolsIncluded: contextPackage.importantSymbols.map((s) => s.name),
        snippetsIncluded: contextPackage.snippets.length,
        outcome: 'sent',
        durationMs: Date.now() - startedAt,
        naiveBaselineBytes,
        promptTokens,
        baselineTokens,
        totalInputTokens,
        modelRounds: loopResult.rounds,
        outputTokens,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // If a non-default (user-picked) model failed with a model-level error, it likely isn't
      // usable in this setup — remember it so we stop suggesting it, and tell the user.
      const isModelError = error instanceof vscode.LanguageModelError;
      if (isModelError && activeModel.id !== request.model.id) {
        unusableModelIds.add(activeModel.id);
        stream.markdown(`> ⚠️ **${activeModel.name}** couldn't be used (it may not be enabled for your account). Graphweft won't suggest it again this session — try **${request.model.name}** or another model.\n\n`);
      }
      stream.markdown(fallbackAnswer(contextPackage, modelErrorMessage(error)));
      await audit.append({
        task,
        taskType,
        modelId: activeModel.id,
        modelVendor: activeModel.vendor,
        promptBytes,
        promptSha256: AuditLog.hashPrompt(prompt),
        filesIncluded: contextPackage.relevantFiles.map((f) => f.path),
        symbolsIncluded: contextPackage.importantSymbols.map((s) => s.name),
        snippetsIncluded: contextPackage.snippets.length,
        outcome: 'error',
        errorMessage: message,
        durationMs: Date.now() - startedAt,
        naiveBaselineBytes,
      });
    }
  });

  if (deps.iconUri) {
    participant.iconPath = deps.iconUri;
  }

  // Fired by the in-chat model-switch buttons. Stashes the forced model for the query and
  // re-opens chat with it, so the next participant turn answers with the chosen model.
  const answerWith = vscode.commands.registerCommand(ANSWER_WITH_COMMAND, async (payload: AnswerWithPayload) => {
    if (!payload?.query || !payload.modelId) return;
    pendingModelOverrides.set(ModelPreferenceStore.hashQuery(payload.query), payload.modelId);
    if (payload.tier) {
      await modelPrefs.recordChoice(payload.tier, payload.modelId, payload.modelName ?? payload.modelId);
    }
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: `@graphweft ${payload.query}` });
  });

  return vscode.Disposable.from(participant, answerWith);
}

/**
 * Models reject a request with more than this many tools. Copilot and other
 * extensions can register dozens (sometimes hundreds) of tools, so we always
 * keep Graphweft's own tools and fill the rest of the budget with externals.
 */
const MODEL_TOOL_LIMIT = 128;

/**
 * Build the list of tools to expose to the model this turn. Always includes
 * Graphweft's own tools; optionally tops up with other tools registered in the
 * window (Copilot's and other extensions') so @graphweft is not capability-limited
 * compared with the built-in agent — but never exceeds the model's tool cap.
 * Controlled by `graphweft.enableAgentTools`, `graphweft.includeExternalTools`,
 * and `graphweft.maxTools`.
 */
function collectAgentTools(): vscode.LanguageModelChatTool[] {
  const config = vscode.workspace.getConfiguration('graphweft');
  if (!config.get<boolean>('enableAgentTools', true)) {
    return [];
  }
  const includeExternal = config.get<boolean>('includeExternalTools', true);
  const cap = Math.min(Math.max(config.get<number>('maxTools', MODEL_TOOL_LIMIT), 1), MODEL_TOOL_LIMIT);
  const graphweftNames = new Set<string>(GRAPHWEFT_TOOL_NAMES);

  const toTool = (tool: vscode.LanguageModelToolInformation): vscode.LanguageModelChatTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });

  // Graphweft's own tools always come first so they survive the cap.
  const own = vscode.lm.tools.filter((tool) => graphweftNames.has(tool.name)).map(toTool);
  if (!includeExternal) {
    return own.slice(0, cap);
  }
  const external = vscode.lm.tools.filter((tool) => !graphweftNames.has(tool.name)).map(toTool);
  return [...own, ...external].slice(0, cap);
}

/**
 * Convert this chat session's prior turns into model messages so follow-up questions
 * ("edit these with the above analysis") have conversational memory. Only Graphweft's own
 * turns are threaded (so we don't replay other participants' content), and we keep only the
 * most recent turns that fit a slice of the context window — history must never crowd out
 * the freshly-assembled code context or the current question.
 */
function historyToMessages(
  context: vscode.ChatContext,
  maxInputTokens?: number,
): vscode.LanguageModelChatMessage[] {
  // Reserve roughly a quarter of the window (capped) for history; the rest is for the
  // assembled code context + the current question + room for the answer.
  const tokenBudget = Math.min(maxInputTokens ? Math.floor(maxInputTokens * 0.25) : 4000, 4000);

  // Walk newest → oldest, accumulating until the budget runs out, then restore order.
  const collected: vscode.LanguageModelChatMessage[] = [];
  let used = 0;
  for (let i = context.history.length - 1; i >= 0; i -= 1) {
    const turn = context.history[i];
    if (turn.participant !== graphweftParticipantId) continue;

    let text: string;
    let message: vscode.LanguageModelChatMessage;
    if (turn instanceof vscode.ChatRequestTurn) {
      text = turn.prompt.trim();
      if (!text) continue;
      message = vscode.LanguageModelChatMessage.User(text);
    } else if (turn instanceof vscode.ChatResponseTurn) {
      text = responseTurnText(turn).trim();
      if (!text) continue;
      message = vscode.LanguageModelChatMessage.Assistant(text);
    } else {
      continue;
    }

    used += estimateTokens(text);
    if (used > tokenBudget) break;
    collected.push(message);
  }
  return collected.reverse();
}

/** Flatten a response turn's markdown parts back into plain text for the transcript. */
function responseTurnText(turn: vscode.ChatResponseTurn): string {
  let out = '';
  for (const part of turn.response) {
    if (part instanceof vscode.ChatResponseMarkdownPart) {
      out += part.value.value;
    }
  }
  return out;
}

/**
 * How many model round-trips the agent loop may take before it stops and offers Continue.
 * The old default (8) was too small for ordinary multi-file work — "read 4 files then apply
 * 3 edits" hit the cap mid-task and forced a confusing re-submit — so we default higher and
 * let users tune it via `graphweft.maxAgentSteps`. Clamped to a sane range.
 */
function agentStepBudget(): number {
  const configured = vscode.workspace.getConfiguration('graphweft').get<number>('maxAgentSteps', 16);
  return Math.min(Math.max(Math.floor(configured), 1), 50);
}

function getActiveFilePath(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri ? toWorkspacePath(uri) : undefined;
}

function getOpenFilePaths(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => {
      if (tab.input instanceof vscode.TabInputText) {
        return toWorkspacePath(tab.input.uri);
      }

      return undefined;
    })
    .filter((filePath): filePath is string => Boolean(filePath));
}

function toWorkspacePath(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file') {
    return undefined;
  }

  return vscode.workspace.asRelativePath(uri, false);
}

interface SavingsFooterInput {
  promptBytes: number;
  naiveBaselineBytes: number;
  /** Real tokenizer count of the assembled context (preferred over bytes/4 when present). */
  promptTokens?: number;
  /** Real tokenizer count of the naive file-dump baseline. */
  baselineTokens?: number;
  /** Whole-loop input tokens (every round), for the honest end-to-end figure. */
  totalInputTokens?: number;
  /** Output (completion) tokens the model generated across the loop. */
  outputTokens?: number;
}

function savingsFooter(input: SavingsFooterInput): string {
  // Prefer real tokenizer counts; fall back to the bytes/4 estimate for either side.
  const actual = input.promptTokens ?? Math.ceil(input.promptBytes / 4);
  const baseline = input.baselineTokens ?? Math.ceil(input.naiveBaselineBytes / 4);
  const counted = input.promptTokens !== undefined && input.baselineTokens !== undefined;

  if (baseline <= actual) return '';
  const saved = baseline - actual;
  const pct = ((saved / baseline) * 100).toFixed(0);
  const basis = counted ? 'measured with the model tokenizer' : 'estimated';

  let footer =
    `\n\n_💡 Token savings (${basis}): this call's context was **${actual.toLocaleString()} tokens** vs a naive ` +
    `"dump the relevant files" baseline of **${baseline.toLocaleString()}** — about **${saved.toLocaleString()} tokens (${pct}%) saved**.`;
  if (input.totalInputTokens !== undefined && input.totalInputTokens > 0) {
    const out = input.outputTokens ?? 0;
    const total = input.totalInputTokens + out;
    footer +=
      ` End-to-end this request used **${input.totalInputTokens.toLocaleString()} input** + ` +
      `**${out.toLocaleString()} output** = **${total.toLocaleString()} tokens** across the agent loop.`;
  }
  footer += ' Run `/savings` for the lifetime breakdown._';
  return footer;
}

interface ResolvedReference {
  /** Human label, e.g. "src/Foo.razor.cs:23-28" or a file path. */
  label: string;
  /** Workspace-relative path, when the reference is a file/selection (for retrieval hints). */
  path?: string;
  /** The attached code/text. */
  content: string;
}

/**
 * Resolve the context the user explicitly attached to their message (selection chips, file
 * references, `#`-variables). VS Code delivers these via `request.references` with a `value`
 * that may be a Location (file + range), a Uri (whole file), or a string — never in the prompt
 * text. Best-effort: unreadable/unknown references are skipped rather than failing the turn.
 */
async function resolveChatReferences(request: vscode.ChatRequest): Promise<ResolvedReference[]> {
  const resolved: ResolvedReference[] = [];
  for (const ref of request.references ?? []) {
    const value = ref.value as unknown;
    try {
      if (value instanceof vscode.Location) {
        const rel = vscode.workspace.asRelativePath(value.uri, false);
        const doc = await vscode.workspace.openTextDocument(value.uri);
        const start = value.range.start.line + 1;
        const end = value.range.end.line + 1;
        resolved.push({ label: `${rel}:${start}-${end}`, path: rel, content: clipText(doc.getText(value.range)) });
      } else if (value instanceof vscode.Uri) {
        const rel = vscode.workspace.asRelativePath(value, false);
        const doc = await vscode.workspace.openTextDocument(value);
        resolved.push({ label: rel, path: rel, content: clipText(doc.getText()) });
      } else if (typeof value === 'string') {
        resolved.push({ label: ref.id || 'attached text', content: clipText(value) });
      } else if (value && typeof value === 'object' && 'uri' in value && 'range' in value) {
        // Defensive: a Location-shaped object that didn't pass instanceof (cross-realm, etc.).
        const loc = value as { uri: vscode.Uri; range: vscode.Range };
        const rel = vscode.workspace.asRelativePath(loc.uri, false);
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        resolved.push({ label: rel, path: rel, content: clipText(doc.getText(loc.range)) });
      }
    } catch {
      // Skip references we can't read; the rest of the turn proceeds normally.
    }
  }
  return resolved;
}

/** Render attached references into a prominent prompt block so the model treats them as "this". */
function renderAttachedReferences(refs: ResolvedReference[]): string {
  if (refs.length === 0) return '';
  const lang = (label: string): string => label.split('.').pop()?.split(':')[0] ?? '';
  const blocks = refs.map((ref) => `Attached \`${ref.label}\`:\n\`\`\`${lang(ref.label)}\n${ref.content}\n\`\`\``);
  return [
    'The user attached the following code/files to their message. Treat this as the PRIMARY subject of the request —',
    'when they say "this", "these", or "the above", they mean the attached content below (not files from the context package):',
    '',
    ...blocks,
  ].join('\n');
}

/** Clip attached content so a large file/selection can't blow the prompt budget. */
function clipText(text: string, maxChars = 6000): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

/** Count tokens with the model tokenizer; returns undefined if unavailable. */
async function safeCountTokens(
  model: vscode.LanguageModelChat,
  text: string,
  token: vscode.CancellationToken,
): Promise<number | undefined> {
  try {
    return await model.countTokens(text, token);
  } catch {
    return undefined;
  }
}

interface DecideModelArgs {
  task: string;
  taskType: TaskType;
  contextPackage: GraphweftContextPackage;
  prompt: string;
  request: vscode.ChatRequest;
  prefs: ModelPreferenceStore;
  privacy: PrivacyManager;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
}

/**
 * The outcome of deciding which model answers this turn:
 *  - `answer`  → proceed now with `model`.
 *  - `awaiting` → Graphweft posted in-chat switch buttons; do NOT answer this turn.
 *               The answer is generated when the user clicks a button (which re-runs
 *               the query with the chosen model forced).
 */
type ModelDecision =
  | { kind: 'answer'; model: vscode.LanguageModelChat }
  | { kind: 'awaiting' };

/**
 * Decide which model answers this turn. Runs the (cost/privacy-aware) complexity
 * classifier; when a different tier of model fits better it either renders in-chat
 * switch buttons (`graphweft.modelSwitchPrompt`) — deferring the answer until the user
 * clicks — or just shows an advisory banner. Never throws; defaults to the user's model.
 */
async function decideActiveModel(args: DecideModelArgs): Promise<ModelDecision> {
  const config = vscode.workspace.getConfiguration('graphweft');
  if (!config.get<boolean>('suggestModel', true)) {
    return { kind: 'answer', model: args.request.model };
  }

  try {
    const classification = await classifyComplexity({
      task: args.task,
      taskType: args.taskType,
      contextPackage: args.contextPackage,
      useModel: config.get<boolean>('suggestModelUsesLLM', true),
      localOnly: args.privacy.isLocalOnly(),
      prefs: args.prefs,
      token: args.token,
    });

    // Transparency: tell the user when an extra (lightweight) model call was spent to grade
    // the query, and which model graded it — so the cost is never hidden.
    if (classification.source === 'model' && classification.graderModel) {
      args.stream.markdown(
        `> 🔎 Graded this query as **${classification.tier}** via one lightweight call to **${classification.graderModel}** (query text only; cached for next time).\n\n`,
      );
    }

    // Profile every available model and rank them for this task across multiple axes
    // (capability / cost / speed / reasoning / context) — not just a 3-tier guess.
    // Only consider models VS Code currently advertises, minus any that proved unusable this
    // session — so we never surface a model that will fail when the user clicks it.
    const models = (await listChatModels()).filter((m) => !unusableModelIds.has(m.id));
    const promptTokens = estimateTokens(args.prompt);
    const requirement = deriveRequirement(classification.tier, args.taskType, promptTokens);
    const profiled = profileModels(
      models.map((m) => ({ id: m.id, name: m.name, vendor: m.vendor, family: m.family, maxInputTokens: m.maxInputTokens })),
    );
    const { suggestions, currentFit } = recommendModels(profiled, requirement, args.request.model.id);

    const alternatives = suggestions.filter((s) => s.model.id !== args.request.model.id);
    const best = alternatives[0];
    // Only nudge when an alternative meaningfully out-fits the current pick (avoids noise).
    const worthSwitching = best && (currentFit === undefined || best.fit >= currentFit + 8);
    if (!best || !worthSwitching) {
      return { kind: 'answer', model: args.request.model };
    }

    // Advisory-only mode: name the top options, keep the user's model, answer now.
    if (!config.get<boolean>('modelSwitchPrompt', true)) {
      args.stream.markdown(renderRecommendationBanner(classification.tier, alternatives, classification.signals));
      return { kind: 'answer', model: args.request.model };
    }

    // Render the ranked options as in-chat buttons + keep-current; defer the answer until clicked.
    args.stream.markdown(renderRecommendationIntro(classification.tier, alternatives, currentFit, args.request.model.name));
    for (const rec of alternatives) {
      const badge = roleBadge(rec.role);
      args.stream.button({
        command: ANSWER_WITH_COMMAND,
        title: `${badge.emoji} ${rec.model.name} · ${badge.label} (fit ${rec.fit})`,
        arguments: [{ query: args.task, modelId: rec.model.id, modelName: rec.model.name, tier: classification.tier } satisfies AnswerWithPayload],
      });
    }
    args.stream.button({
      command: ANSWER_WITH_COMMAND,
      title: `✓ Keep ${args.request.model.name}${currentFit !== undefined ? ` (fit ${currentFit})` : ''}`,
      arguments: [{ query: args.task, modelId: args.request.model.id, modelName: args.request.model.name, tier: classification.tier } satisfies AnswerWithPayload],
    });
    return { kind: 'awaiting' };
  } catch {
    // A model suggestion must never block the actual answer.
    return { kind: 'answer', model: args.request.model };
  }
}

/** Markdown intro listing the ranked model options with rationale (buttons render below it). */
function renderRecommendationIntro(
  tier: string,
  recs: Recommendation[],
  currentFit: number | undefined,
  currentName: string,
): string {
  const lines = [
    `> 💡 This looks like a **${tier}** task. Ranked picks for it (your global model picker stays unchanged):`,
    '>',
  ];
  for (const rec of recs) {
    const badge = roleBadge(rec.role);
    lines.push(`> - ${badge.emoji} **${rec.model.name}** · _${badge.label}_ — fit ${rec.fit}. ${rec.rationale.join('; ')}`);
  }
  lines.push(`>`, `> _On **${currentName}**${currentFit !== undefined ? ` (fit ${currentFit})` : ''}. Pick a button below — your choice always wins._`);
  return lines.join('\n') + '\n';
}

/** One-line advisory banner (non-interactive mode). */
function renderRecommendationBanner(tier: string, recs: Recommendation[], signals: string[]): string {
  const top = recs[0];
  if (!top) return '';
  const badge = roleBadge(top.role);
  const why = signals.length > 0 ? ` _(why: ${signals.join(', ')})_` : '';
  return `> 💡 **Model tip:** this looks like a **${tier}** task. ${badge.emoji} **${top.model.name}** may fit better (${top.rationale.join('; ')}). Switch in the model picker; your choice always wins.${why}\n\n`;
}
