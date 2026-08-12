import * as vscode from 'vscode';
import * as path from 'path';

export interface AgentRunOptions {
  model: vscode.LanguageModelChat;
  /** Conversation so far. The runner appends assistant/tool turns as it loops. */
  messages: vscode.LanguageModelChatMessage[];
  /** Tools to expose to the model this turn. */
  tools: vscode.LanguageModelChatTool[];
  /** Ties tool invocations to this chat request so confirmations render inline. */
  toolInvocationToken: vscode.ChatParticipantToolToken;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  justification: string;
  /** Safety valve so a misbehaving model can't loop forever. */
  maxRounds?: number;
  /**
   * The original user request. When set and the loop stops at the step limit, the runner
   * renders an in-chat **Continue** button that re-runs this query through @codegraph so
   * the agent can pick the task back up — instead of forcing the user to retype it.
   */
  continueQuery?: string;
}

export interface AgentRunResult {
  /** How many model round-trips were made. */
  rounds: number;
  /** Total number of tool calls invoked across all rounds. */
  toolCalls: number;
  /** True if the loop stopped because it hit maxRounds rather than the model finishing. */
  hitMaxRounds: boolean;
  /**
   * Total input tokens sent to the model across every round (counted with the model's real
   * tokenizer). Each round re-sends the full conversation, so this reflects true end-to-end
   * input cost, not just the first context. Best-effort: 0 if token counting failed.
   */
  inputTokens: number;
  /**
   * Total output (completion) tokens the model generated across the loop, counted with the
   * model's tokenizer. Best-effort: 0 if token counting failed.
   */
  outputTokens: number;
}

const DEFAULT_MAX_ROUNDS = 8;

/**
 * Drives the agentic tool-calling loop: send the conversation to the model with
 * the available tools, stream any text it produces, and whenever it asks to call
 * a tool, invoke that tool (which may show an inline confirmation), feed the
 * result back, and repeat until the model answers without requesting a tool.
 *
 * This is the piece that turns CodeGraph from a read-only responder into an
 * agent that can actually run commands and edit files — the same loop Copilot's
 * built-in agent runs, but here under CodeGraph's own control.
 */
export async function runAgentLoop(options: AgentRunOptions): Promise<AgentRunResult> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const messages = options.messages;
  let rounds = 0;
  let totalToolCalls = 0;
  let inputTokens = 0;
  let outputText = '';

  // Signatures (name + arguments) of tool calls already executed this turn. The model
  // sometimes re-requests the exact same call it just made — answering it again wastes a
  // round and is how a trivial task (e.g. one findFiles) can silently exhaust the step
  // budget. We short-circuit repeats instead of re-running them.
  const seenCalls = new Set<string>();
  let stuck = false;

  while (rounds < maxRounds) {
    rounds += 1;
    if (options.token.isCancellationRequested) break;

    // Count what this round actually sends (the full conversation so far) with the model's
    // real tokenizer, so end-to-end input cost reflects every tool round, not just round one.
    inputTokens += await countMessagesTokens(options.model, messages, options.token);

    const response = await options.model.sendRequest(
      messages,
      { tools: options.tools, justification: options.justification },
      options.token,
    );

    const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        options.stream.markdown(part.value);
        assistantParts.push(part);
        outputText += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
        assistantParts.push(part);
      }
    }

    // Model produced a final answer with no tool requests — we're done.
    if (toolCalls.length === 0) {
      const outputTokens = await countTextTokens(options.model, outputText, options.token);
      return { rounds, toolCalls: totalToolCalls, hitMaxRounds: false, inputTokens, outputTokens };
    }

    // Record the assistant's turn (text + the tool calls it requested) so the
    // model has a coherent transcript on the next round.
    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    let didNewWork = false;
    for (const call of toolCalls) {
      const signature = `${call.name}(${stableStringify(call.input)})`;

      // Identical call already executed — return a nudge instead of re-running it,
      // so the model stops spinning and either tries something new or answers.
      if (seenCalls.has(signature)) {
        resultParts.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(
              `You already called "${call.name}" with these exact arguments earlier in this turn and the result has not changed. ` +
                'Do not call it again — use the earlier result, then either call a different tool or give your final answer.',
            ),
          ]),
        );
        continue;
      }
      seenCalls.add(signature);
      didNewWork = true;
      totalToolCalls += 1;
      options.stream.progress(`${friendlyName(call.name)}…`);
      try {
        const result = await vscode.lm.invokeTool(
          call.name,
          { input: call.input, toolInvocationToken: options.toolInvocationToken },
          options.token,
        );
        renderToolActivity(options.stream, call, result);
        resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stream.markdown(`\n\n> ⚠️ \`${call.name}\` could not run: ${message}\n`);
        resultParts.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(`Tool "${call.name}" failed or was declined: ${message}`),
          ]),
        );
      }
    }

    // Feed the tool results back as a user turn and loop.
    messages.push(vscode.LanguageModelChatMessage.User(resultParts));

    // The whole round was repeats — the model is stuck. Stop early and let it answer
    // with what it has rather than burning the remaining rounds on the same calls.
    if (!didNewWork) {
      stuck = true;
      break;
    }
  }

  // We stopped without a clean final answer (hit the step limit or detected a stuck loop).
  // Make one last tool-free request so the user still gets an answer from what was gathered,
  // instead of a dead end. Best-effort: any failure just falls through to the notice below.
  if (!options.token.isCancellationRequested) {
    const flush = await flushFinalAnswer(options, messages);
    inputTokens += flush.inputTokens;
    outputText += flush.outputText;
  }

  options.stream.markdown(
    stuck
      ? `\n\n> ℹ️ CodeGraph stopped early — the model kept repeating the same tool call. Answered with what was gathered so far.\n`
      : `\n\n> ℹ️ CodeGraph reached the ${maxRounds}-step tool limit for this request. Answered with what was gathered so far.\n`,
  );
  // Offer a one-click Continue. We submit a short "continue" prompt rather than the
  // verbatim original question, so the chat doesn't show a confusing duplicate of what the
  // user already asked — the conversation history (threaded into the request) gives the
  // model everything it needs to resume. Only shown when we have a session to continue.
  if (options.continueQuery && options.continueQuery.trim().length > 0) {
    options.stream.button({
      command: 'workbench.action.chat.open',
      title: '▶ Continue',
      arguments: [{ query: '@codegraph continue the previous request' }],
    });
  } else {
    options.stream.markdown('> Ask a follow-up to continue.\n');
  }
  const outputTokens = await countTextTokens(options.model, outputText, options.token);
  return { rounds, toolCalls: totalToolCalls, hitMaxRounds: true, inputTokens, outputTokens };
}

/** Count the tokens of a set of messages with the model's tokenizer. Best-effort: 0 on failure. */
async function countMessagesTokens(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  token: vscode.CancellationToken,
): Promise<number> {
  let total = 0;
  for (const message of messages) {
    try {
      total += await model.countTokens(message, token);
    } catch {
      // Tokenizer unavailable for this part — skip it rather than failing the whole turn.
    }
  }
  return total;
}

/**
 * Final no-tools request. When the loop bails (step limit or a stuck repeat-loop) the model
 * has usually gathered enough to say something useful but never got to write the answer.
 * We ask it once more with NO tools available, so it must produce prose, and stream that out.
 */
async function flushFinalAnswer(
  options: AgentRunOptions,
  messages: vscode.LanguageModelChatMessage[],
): Promise<{ inputTokens: number; outputText: string }> {
  try {
    messages.push(
      vscode.LanguageModelChatMessage.User(
        'You have reached the tool-call limit for this turn. Do not request any more tools. ' +
          'Give the best possible answer now using the information already gathered above, ' +
          'and briefly note anything you could not verify.',
      ),
    );
    const sentTokens = await countMessagesTokens(options.model, messages, options.token);
    const response = await options.model.sendRequest(messages, { justification: options.justification }, options.token);
    let outputText = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        options.stream.markdown(part.value);
        outputText += part.value;
      }
    }
    return { inputTokens: sentTokens, outputText };
  } catch {
    // Best-effort only — the step-limit notice still renders below.
    return { inputTokens: 0, outputText: '' };
  }
}

/** Count tokens of a plain string with the model tokenizer. Best-effort: 0 on failure or empty. */
async function countTextTokens(
  model: vscode.LanguageModelChat,
  text: string,
  token: vscode.CancellationToken,
): Promise<number> {
  if (!text) return 0;
  try {
    return await model.countTokens(text, token);
  } catch {
    return 0;
  }
}

/** Deterministic JSON for tool-call inputs so repeated calls produce an identical signature. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function friendlyName(toolName: string): string {
  const map: Record<string, string> = {
    codegraph_runInTerminal: 'Running command',
    codegraph_readFile: 'Reading file',
    codegraph_writeFile: 'Writing file',
    codegraph_replaceInFile: 'Editing file',
    codegraph_listDirectory: 'Listing directory',
    codegraph_findFiles: 'Searching for files',
    codegraph_impact: 'Computing impact set',
    codegraph_dependencyPath: 'Tracing dependency path',
    codegraph_godNodes: 'Finding hub files',
  };
  return map[toolName] ?? `Using ${toolName}`;
}

/**
 * Render a tidy, modern view of a tool's result. VS Code already shows a native chip for the
 * call itself ("Reading `path`", "Running `cmd`"), so we deliberately do NOT repeat the tool
 * name/arguments — we summarize the outcome, surface clickable file links where it helps, and
 * keep it small. The model still receives the full result separately; this is purely what the
 * user sees. Dispatches to a per-tool renderer so each result type gets the right treatment.
 */
function renderToolActivity(
  stream: vscode.ChatResponseStream,
  call: vscode.LanguageModelToolCallPart,
  result: vscode.LanguageModelToolResult,
): void {
  const text = extractText(result);

  if (!text) {
    stream.markdown('\n> _↳ no output_\n');
    return;
  }

  // Errors / declines → one clean warning line, never a big block.
  if (/^(error\b|command failed|tool ")/iu.test(text)) {
    stream.markdown(`\n> ⚠️ _${firstLine(text)}_\n`);
    return;
  }

  switch (call.name) {
    case 'codegraph_runInTerminal':
      renderTerminal(stream, text);
      return;
    case 'codegraph_readFile':
      renderRead(stream, call, text);
      return;
    case 'codegraph_findFiles':
      renderFileList(stream, text);
      return;
    case 'codegraph_writeFile':
    case 'codegraph_replaceInFile':
      renderEdit(stream, call, text);
      return;
    default:
      renderGeneric(stream, text);
  }
}

/**
 * Terminal output, rendered like a modern terminal card: a status header line that shows the
 * command and whether it succeeded (✓ / ✗ exit N), followed by a ```console fenced block of the
 * clipped output. The tool's text format is:
 *   `$ <command>\n(cwd: <rel>, exit code: <X>)<note>\n\n<output or (no output)>`
 */
function renderTerminal(stream: vscode.ChatResponseStream, text: string): void {
  const lines = text.split('\n');
  const commandLine = lines.find((l) => l.startsWith('$ '));
  const command = commandLine ? commandLine.slice(2).trim() : undefined;
  const exitMatch = text.match(/exit code:\s*(\d+)/iu);
  const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;

  // Body is everything after the first blank line (the actual stdout/stderr).
  const blankIdx = lines.findIndex((l) => l.trim().length === 0);
  let body = blankIdx >= 0 ? lines.slice(blankIdx + 1).join('\n').trim() : '';
  if (/^\(no output\)$/iu.test(body)) body = '';

  const status =
    exitCode === undefined ? '' : exitCode === 0 ? ' ✓' : ` ✗ exit ${exitCode}`;
  const header = command ? `\n**\`$ ${command}\`**${status}\n` : `\n**Terminal**${status}\n`;
  stream.markdown(header);

  if (body) {
    stream.markdown(`\n\`\`\`console\n${clip(body, 800, 18)}\n\`\`\`\n`);
  }
}

/**
 * A file read. The model already has the content, so we only show a compact, clickable headline
 * that opens the file in the editor. The tool headline is "# <rel> (lines a-b of N)".
 */
function renderRead(
  stream: vscode.ChatResponseStream,
  call: vscode.LanguageModelToolCallPart,
  text: string,
): void {
  const rel = relPathFromInput(call.input);
  const headline = firstLine(text).replace(/^#\s*/u, '');
  const uri = resolveWorkspaceUri(rel);
  if (uri) {
    stream.markdown('\n> 📄 ');
    stream.anchor(uri, rel ? basename(rel) : headline);
    const detail = headline.replace(rel ?? '', '').trim();
    if (detail) stream.markdown(` _${detail}_`);
    stream.markdown('\n');
    return;
  }
  stream.markdown(`\n> 📄 _${headline}_\n`);
}

/**
 * A file-search result. The tool format is "# Files matching <glob> (N)\n- path\n- path…".
 * We render the count and then a capped list of clickable anchors, one per line.
 */
function renderFileList(stream: vscode.ChatResponseStream, text: string): void {
  const lines = text.split('\n');
  const heading = lines.find((l) => l.startsWith('#'))?.replace(/^#\s*/u, '');
  const paths = lines
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.trim().slice(2).trim())
    .filter((p) => p.length > 0);

  if (heading) stream.markdown(`\n> **${heading}**\n`);
  if (paths.length === 0) return;

  const MAX = 12;
  for (const p of paths.slice(0, MAX)) {
    const uri = resolveWorkspaceUri(p);
    stream.markdown('> • ');
    if (uri) stream.anchor(uri, p);
    else stream.markdown(`\`${p}\``);
    stream.markdown('\n');
  }
  if (paths.length > MAX) {
    stream.markdown(`> _…and ${paths.length - MAX} more_\n`);
  }
}

/**
 * A successful write/edit. Confirm with a check + a clickable link to the changed file so the
 * user can jump straight to the result.
 */
function renderEdit(
  stream: vscode.ChatResponseStream,
  call: vscode.LanguageModelToolCallPart,
  text: string,
): void {
  const rel = relPathFromInput(call.input);
  const uri = resolveWorkspaceUri(rel);
  stream.markdown('\n> ✅ ');
  if (uri && rel) stream.anchor(uri, basename(rel));
  else stream.markdown(`_${firstLine(text)}_`);
  const detail = rel ? firstLine(text).replace(rel, '').trim() : '';
  if (detail) stream.markdown(` _${detail}_`);
  stream.markdown('\n');
}

/** Everything else (directory listings, graph queries): a short, trimmed blockquote. */
function renderGeneric(stream: vscode.ChatResponseStream, text: string): void {
  const body = clip(text, 600, 12).replace(/^#\s*/u, '');
  stream.markdown(`\n> ${body.split('\n').join('\n> ')}\n`);
}

/** Pull a likely relative path out of a tool call's input (`path`/`file`/`relativePath`). */
function relPathFromInput(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['path', 'file', 'relativePath', 'relPath', 'filePath']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Last path segment, for a tidy anchor label. */
function basename(p: string): string {
  return p.split(/[\\/]/u).filter(Boolean).pop() ?? p;
}

/**
 * Resolve a workspace-relative (or absolute) path to a URI we can hand to `stream.anchor`.
 * Returns undefined when there's no workspace or no usable path, so callers fall back to text.
 */
function resolveWorkspaceUri(relPath?: string): vscode.Uri | undefined {
  if (!relPath) return undefined;
  if (path.isAbsolute(relPath)) return vscode.Uri.file(relPath);
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return vscode.Uri.joinPath(folders[0].uri, relPath);
}

/** First non-empty line of a block of text. */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0) ?? text;
}

/** Clip text to at most `maxLines` lines and `maxChars` characters, marking truncation. */
function clip(text: string, maxChars: number, maxLines: number): string {
  let lines = text.split('\n');
  let truncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }
  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return truncated ? out.replace(/\n+$/u, '') + '\n…' : out;
}

function extractText(result: vscode.LanguageModelToolResult): string {
  return result.content
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
    .join('')
    .trim();
}
