import * as vscode from 'vscode';
import { ComplexityTier } from '../context/complexityScorer';

const TIER_RANK: Record<ComplexityTier, number> = { light: 0, standard: 1, heavy: 2 };

// Substring signals that place a model family into a cost/capability tier.
// Checked light-first so e.g. "o4-mini" lands in `light`, not `heavy`.
const LIGHT_SIGNALS = ['mini', 'haiku', 'flash', 'lite', 'nano', 'small', 'phi', '8b'];
const HEAVY_SIGNALS = ['opus', 'o1', 'o3', 'gpt-5', 'gpt5', 'thinking', 'reasoning', 'pro'];

export interface ModelTierInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
  tier: ComplexityTier;
  /** Context window, when known (available models expose it; the current-model stub may not). */
  maxInputTokens?: number;
}

export interface ModelSuggestion {
  /** The tier the query was assessed to need. */
  neededTier: ComplexityTier;
  /** The model the user currently has selected. */
  current: ModelTierInfo;
  /** A cheaper available model that likely suffices (only set when downgrading helps). */
  cheaper?: ModelTierInfo;
  /** A stronger available model (only set when the task looks under-powered). */
  stronger?: ModelTierInfo;
}

export function classifyModelTier(family: string, id: string): ComplexityTier {
  const hay = `${family} ${id}`.toLowerCase();
  if (LIGHT_SIGNALS.some((s) => hay.includes(s))) return 'light';
  if (HEAVY_SIGNALS.some((s) => hay.includes(s))) return 'heavy';
  return 'standard';
}

/** All chat models available in this window (empty on failure — never throws). */
export async function listChatModels(): Promise<vscode.LanguageModelChat[]> {
  try {
    return await vscode.lm.selectChatModels();
  } catch {
    return [];
  }
}

/** Resolve a concrete chat model by id so we can send a request to it. */
export async function resolveModelById(id: string): Promise<vscode.LanguageModelChat | undefined> {
  return (await listChatModels()).find((m) => m.id === id);
}

/** Cheapest-tier model available (used for the lightweight classification call). */
export function cheapestModel(models: vscode.LanguageModelChat[]): vscode.LanguageModelChat | undefined {
  return [...models]
    .sort((a, b) => TIER_RANK[classifyModelTier(a.family, a.id)] - TIER_RANK[classifyModelTier(b.family, b.id)])
    .at(0);
}

function toInfo(model: { id: string; name: string; vendor: string; family: string; maxInputTokens?: number }): ModelTierInfo {
  return {
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    family: model.family,
    tier: classifyModelTier(model.family, model.id),
    maxInputTokens: model.maxInputTokens,
  };
}

/**
 * Given the tier a query needs and the model the user picked, look at the models
 * actually available in this window and decide whether to nudge the user toward a
 * cheaper (token-saving) or stronger model. Returns `undefined` when the current
 * pick is already a good fit, or when no better-matched model is installed.
 *
 * Enumerating models is the only async step; it never sends anything to a model.
 */
export async function suggestModel(
  neededTier: ComplexityTier,
  currentModel: { id: string; name: string; vendor: string; family: string },
): Promise<ModelSuggestion | undefined> {
  const current = toInfo(currentModel);
  const neededRank = TIER_RANK[neededTier];
  const currentRank = TIER_RANK[current.tier];

  let available: ModelTierInfo[];
  try {
    const models = await vscode.lm.selectChatModels();
    available = models.map(toInfo).filter((m) => m.id !== current.id);
  } catch {
    return undefined;
  }
  if (available.length === 0) {
    return undefined;
  }

  // Task is lighter than the user's pick → suggest the cheapest model that still
  // meets the needed tier (saves tokens / premium requests).
  if (currentRank > neededRank) {
    const candidates = available
      .filter((m) => TIER_RANK[m.tier] >= neededRank && TIER_RANK[m.tier] < currentRank)
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
    const cheaper = candidates[0];
    if (cheaper) {
      return { neededTier, current, cheaper };
    }
    return undefined;
  }

  // Task looks heavier than the user's pick → optionally flag a stronger model.
  if (currentRank < neededRank) {
    const stronger = available
      .filter((m) => TIER_RANK[m.tier] >= neededRank)
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])[0];
    if (stronger) {
      return { neededTier, current, stronger };
    }
  }

  return undefined;
}

/** Render the suggestion as a one-line chat banner, or '' when there is nothing to say. */
export function renderModelBanner(suggestion: ModelSuggestion | undefined, signals: string[]): string {
  if (!suggestion) return '';
  const why = signals.length > 0 ? ` _(why: ${signals.join(', ')})_` : '';

  if (suggestion.cheaper) {
    return [
      `> 💡 **Model tip:** this looks like a **${suggestion.neededTier}** task. You're on **${suggestion.current.name}** — a cheaper model like **${suggestion.cheaper.name}** could likely handle it. Switch in the model picker to save tokens; your choice always wins.${why}`,
      '',
    ].join('\n');
  }

  if (suggestion.stronger) {
    return [
      `> 💡 **Model tip:** this looks like a **${suggestion.neededTier}** task. You're on **${suggestion.current.name}** — a stronger model like **${suggestion.stronger.name}** may give a more reliable answer.${why}`,
      '',
    ].join('\n');
  }

  return '';
}
