import * as vscode from 'vscode';
import { assessComplexity, ComplexityTier } from '../context/complexityScorer';
import { CodeGraphContextPackage } from '../context/contextPackage';
import { TaskType } from '../context/taskClassifier';
import { ModelPreferenceStore } from '../privacy/modelPreferenceStore';
import { cheapestModel, listChatModels } from './modelAdvisor';

export type ClassificationSource = 'heuristic' | 'cache' | 'model';

export interface ClassificationResult {
  tier: ComplexityTier;
  score: number;
  /** Human-readable factors (from the heuristic) for the banner's "why" clause. */
  signals: string[];
  /** How the tier was decided — useful for the banner and the audit trail. */
  source: ClassificationSource;
  /** When source === 'model', the name of the cheap model that graded the query. */
  graderModel?: string;
}

// Scores in this band are genuinely borderline; only here do we spend a model call.
const AMBIGUOUS_LOW = 25;
const AMBIGUOUS_HIGH = 65;

// Representative score for each tier the model returns (so downstream logic stays numeric).
const TIER_SCORE: Record<ComplexityTier, number> = { light: 15, standard: 45, heavy: 80 };

export interface ClassifyOptions {
  task: string;
  taskType: TaskType;
  contextPackage: CodeGraphContextPackage;
  /** `codegraph.suggestModelUsesLLM` — allow the cheap-model tiebreak at all. */
  useModel: boolean;
  /** When true (local-only privacy mode) we never make a model call. */
  localOnly: boolean;
  prefs: ModelPreferenceStore;
  token: vscode.CancellationToken;
}

/**
 * Decide a query's difficulty tier with a cost-aware, privacy-aware pipeline:
 *
 *   1. Free local heuristic (always).
 *   2. If the heuristic is confident (clearly light or clearly heavy) → stop. No call.
 *   3. If the model path is disabled, or we're in local-only mode → stop at the heuristic.
 *   4. If we've graded this exact question before → use the cache. No call.
 *   5. Otherwise grade it with the *cheapest available* model, sending the query text
 *      only (never the assembled context), and cache the answer.
 *
 * Any failure in the model path silently falls back to the heuristic — a difficulty
 * grade is never allowed to break the actual answer.
 */
export async function classifyComplexity(options: ClassifyOptions): Promise<ClassificationResult> {
  const heuristic = assessComplexity({
    task: options.task,
    taskType: options.taskType,
    contextPackage: options.contextPackage,
  });

  const confident = heuristic.score < AMBIGUOUS_LOW || heuristic.score > AMBIGUOUS_HIGH;
  if (!options.useModel || options.localOnly || confident) {
    return { ...heuristic, source: 'heuristic' };
  }

  const cached = options.prefs.getCachedClassification(options.task);
  if (cached) {
    return { tier: cached.tier, score: cached.score, signals: heuristic.signals, source: 'cache' };
  }

  try {
    const graded = await gradeWithModel(options.task, options.token);
    if (graded) {
      await options.prefs.cacheClassification(options.task, graded.tier, TIER_SCORE[graded.tier]);
      return {
        tier: graded.tier,
        score: TIER_SCORE[graded.tier],
        signals: heuristic.signals,
        source: 'model',
        graderModel: graded.modelName,
      };
    }
  } catch {
    // fall through to heuristic
  }

  return { ...heuristic, source: 'heuristic' };
}

const GRADER_INSTRUCTION = [
  'You are a difficulty grader for coding requests. Classify the request below by how much',
  'reasoning and code context an assistant needs to answer it well:',
  '- LIGHT: a quick lookup, a single command (run/build/start), or a trivial mechanical edit.',
  '- STANDARD: a focused change or explanation touching a small, well-defined area.',
  '- HEAVY: multi-file refactoring, debugging an unclear failure, or architecture/design work.',
  'Reply with EXACTLY one word: LIGHT, STANDARD, or HEAVY. No punctuation, no explanation.',
  '',
  'Request:',
].join('\n');

/** One tiny, query-only call to the cheapest model. Returns the parsed tier + model name, or undefined. */
async function gradeWithModel(
  task: string,
  token: vscode.CancellationToken,
): Promise<{ tier: ComplexityTier; modelName: string } | undefined> {
  const model = cheapestModel(await listChatModels());
  if (!model) return undefined;

  const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(`${GRADER_INSTRUCTION}\n${task}`)],
    { justification: 'CodeGraph grades a query\'s difficulty locally to suggest a cost-appropriate model.' },
    token,
  );

  let text = '';
  for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }
  const tier = parseTier(text);
  return tier ? { tier, modelName: model.name } : undefined;
}

function parseTier(raw: string): ComplexityTier | undefined {
  const upper = raw.toUpperCase();
  if (upper.includes('HEAVY')) return 'heavy';
  if (upper.includes('LIGHT')) return 'light';
  if (upper.includes('STANDARD')) return 'standard';
  return undefined;
}
