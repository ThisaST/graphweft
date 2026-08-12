/**
 * Multi-axis model recommender. Given the task's assessed complexity tier, type, and prompt
 * size, scores every available model (profiled by modelRegistry) and produces a ranked list
 * of distinct, role-labelled suggestions — best fit, cheapest that fits, most capable, largest
 * context — each with a short rationale. Pure module (no vscode), unit-testable.
 */
import { ComplexityTier } from '../context/complexityScorer';
import { TaskType } from '../context/taskClassifier';
import { ProfiledModel } from './modelRegistry';

export type RecommendationRole = 'best' | 'cheapest' | 'strongest' | 'longContext' | 'fastest';

export interface Recommendation {
  model: ProfiledModel;
  /** Overall fit for this task (0–100). */
  fit: number;
  /** Why this model is being surfaced. */
  role: RecommendationRole;
  rationale: string[];
}

export interface TaskRequirement {
  tier: ComplexityTier;
  wantsReasoning: boolean;
  wantsLongContext: boolean;
  preferCheap: boolean;
  /** Tokens the assembled prompt needs to fit (so we never suggest a model that can't hold it). */
  promptTokens: number;
}

const TIER_TARGET: Record<ComplexityTier, number> = { light: 45, standard: 72, heavy: 90 };
const REASONING_TASKS: ReadonlySet<TaskType> = new Set<TaskType>(['bug_fix', 'code_review']);
const LONG_CONTEXT_THRESHOLD = 16000;

/** Translate the classifier output + prompt size into concrete model requirements. */
export function deriveRequirement(tier: ComplexityTier, taskType: TaskType, promptTokens: number): TaskRequirement {
  return {
    tier,
    wantsReasoning: tier === 'heavy' || REASONING_TASKS.has(taskType),
    wantsLongContext: promptTokens > LONG_CONTEXT_THRESHOLD,
    preferCheap: tier === 'light',
    promptTokens,
  };
}

/** True when a model's context window can comfortably hold the prompt (10% headroom). */
function fitsContext(model: ProfiledModel, promptTokens: number): boolean {
  return model.axes.contextTokens * 0.9 >= promptTokens;
}

/** Score one model against the requirement. Models that can't hold the prompt score ~0. */
export function scoreModel(model: ProfiledModel, req: TaskRequirement): { fit: number; rationale: string[] } {
  const rationale: string[] = [];
  if (!fitsContext(model, req.promptTokens)) {
    return { fit: 0, rationale: ['context window too small for this prompt'] };
  }

  const target = TIER_TARGET[req.tier];
  const { capability, cost, speed, reasoning, contextTokens } = model.axes;
  let fit = 100;

  const gap = capability - target;
  if (gap < 0) {
    fit -= -gap * 1.6; // under-powered for the task — penalise hard
    rationale.push('may be under-powered for this task');
  } else {
    // Over-powered: mild penalty, larger when the task is light (paying for unused capability).
    fit -= gap * (req.preferCheap ? 0.6 : 0.15);
  }

  if (req.tier === 'heavy') {
    fit += (capability - 70) * 0.3;
    if (capability >= 88) rationale.push('top-tier capability for hard work');
  }

  if (req.preferCheap) {
    fit -= cost * 0.3;
    if (cost <= 25) rationale.push('low cost');
    fit += (speed - 70) * 0.15;
    if (speed >= 90) rationale.push('very fast');
  }

  if (req.wantsReasoning) {
    if (reasoning) {
      fit += 8;
      rationale.push('strong multi-step reasoning');
    } else {
      fit -= 10;
      rationale.push('limited reasoning for a complex task');
    }
  }

  if (req.wantsLongContext && contextTokens >= req.promptTokens * 2) {
    fit += 6;
    rationale.push('roomy context window');
  }

  return { fit: Math.max(0, Math.min(100, Math.round(fit))), rationale };
}

export interface RecommendationSet {
  /** All available models ranked by fit (best first), excluding ones that can't hold the prompt. */
  ranked: Recommendation[];
  /** Distinct, role-labelled suggestions to surface (best first), capped to `limit`. */
  suggestions: Recommendation[];
  /** Fit of the model the user currently has selected (undefined if it can't hold the prompt). */
  currentFit?: number;
}

/**
 * Rank models and pick a small, diverse set of suggestions covering different roles, so the user
 * gets several meaningful options rather than a single up/down nudge.
 */
export function recommendModels(
  models: ProfiledModel[],
  req: TaskRequirement,
  currentId: string,
  limit = 3,
): RecommendationSet {
  const fittable = models.filter((m) => fitsContext(m, req.promptTokens));

  const ranked: Recommendation[] = fittable
    .map((model) => {
      const { fit, rationale } = scoreModel(model, req);
      return { model, fit, role: 'best' as RecommendationRole, rationale };
    })
    .sort((a, b) => b.fit - a.fit || b.model.axes.capability - a.model.axes.capability);

  const currentFit = ranked.find((r) => r.model.id === currentId)?.fit;

  // Candidate pool for role picks excludes the current model (we add a "keep current" separately).
  const pool = ranked.filter((r) => r.model.id !== currentId);
  const minCapability = TIER_TARGET[req.tier];
  const meetsBar = pool.filter((r) => r.model.axes.capability >= minCapability - 5);

  const picks = new Map<string, Recommendation>();
  const add = (rec: Recommendation | undefined, role: RecommendationRole, reason: string): void => {
    if (!rec) return;
    const existing = picks.get(rec.model.id);
    if (existing) return; // keep the first (higher-priority) role for a model
    picks.set(rec.model.id, { ...rec, role, rationale: dedupe([reason, ...rec.rationale]) });
  };

  // 1. Best overall fit.
  add(pool[0], 'best', 'best overall fit');

  // 2. Cheapest model that still clears the capability bar.
  const cheapest = [...(meetsBar.length ? meetsBar : pool)].sort((a, b) => a.model.axes.cost - b.model.axes.cost)[0];
  add(cheapest, 'cheapest', 'cheapest that fits the task');

  // 3. Most capable available (worth it for heavy / reasoning tasks).
  if (req.tier !== 'light') {
    const strongest = [...pool].sort((a, b) => b.model.axes.capability - a.model.axes.capability)[0];
    add(strongest, 'strongest', 'most capable available');
  }

  // 4. Largest context window, when the prompt is big.
  if (req.wantsLongContext) {
    const longest = [...pool].sort((a, b) => b.model.axes.contextTokens - a.model.axes.contextTokens)[0];
    add(longest, 'longContext', 'largest context window');
  }

  // 5. Fastest acceptable model for light tasks.
  if (req.tier === 'light') {
    const fastest = [...(meetsBar.length ? meetsBar : pool)].sort((a, b) => b.model.axes.speed - a.model.axes.speed)[0];
    add(fastest, 'fastest', 'fastest for a quick task');
  }

  // Order suggestions by fit and cap.
  const suggestions = [...picks.values()].sort((a, b) => b.fit - a.fit).slice(0, limit);

  return { ranked, suggestions, currentFit };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

const ROLE_LABEL: Record<RecommendationRole, { emoji: string; label: string }> = {
  best: { emoji: '🥇', label: 'Best fit' },
  cheapest: { emoji: '⚡', label: 'Cheapest' },
  strongest: { emoji: '🚀', label: 'Most capable' },
  longContext: { emoji: '📏', label: 'Largest context' },
  fastest: { emoji: '💨', label: 'Fastest' },
};

export function roleBadge(role: RecommendationRole): { emoji: string; label: string } {
  return ROLE_LABEL[role];
}

function costLabel(cost: number): string {
  if (cost <= 25) return '$';
  if (cost <= 60) return '$$';
  return '$$$';
}

function ctxLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return `${tokens}`;
}

/**
 * Render a transparency "benchmark" table of every available model with its scored axes,
 * sorted by capability, marking the user's current pick. Pure — used by the `/models` command.
 */
export function renderModelTable(models: ProfiledModel[], currentId?: string): string {
  if (models.length === 0) {
    return '### Available models\n\n_No chat models are available in this window._';
  }
  const sorted = [...models].sort((a, b) => b.axes.capability - a.axes.capability);
  const rows = sorted.map((m) => {
    const here = m.id === currentId ? ' ◄ current' : '';
    const src = m.source === 'heuristic' ? '~' : '';
    return `| ${m.name}${here} | ${m.vendor} | ${m.axes.capability}${src} | ${costLabel(m.axes.cost)} | ${m.axes.speed} | ${m.axes.reasoning ? '✓' : '—'} | ${ctxLabel(m.axes.contextTokens)} |`;
  });
  return [
    `### Available models (${models.length}) — capability benchmark`,
    '',
    '| Model | Vendor | Capability | Cost | Speed | Reasoning | Context |',
    '| --- | --- | ---: | :--: | ---: | :--: | ---: |',
    ...rows,
    '',
    '_Capability/cost/speed are relative (0–100) from a curated registry, since the model API exposes no cost or quality data. `~` marks a value estimated from the model name (not in the registry). Context is the real `maxInputTokens` when the API reports it._',
  ].join('\n');
}
