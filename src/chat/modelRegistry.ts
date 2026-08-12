/**
 * Curated model capability registry.
 *
 * The VS Code language-model API only exposes id/name/vendor/family/maxInputTokens — no cost,
 * quality, speed, or reasoning information. To recommend models on more than a coarse 3-tier
 * guess, we maintain this small, hand-tuned table of well-known families and merge it with the
 * live model list. Numbers are deliberately approximate and relative (0–100); the goal is a
 * sensible *ordering*, not a precise spec sheet. Update the rules as new models ship.
 *
 * This module is pure (no vscode import) so it can be unit-tested outside the extension host.
 */

export interface ModelAxes {
  /** General coding + reasoning ability (0–100, higher = stronger). */
  capability: number;
  /** Relative input price class (0–100, higher = more expensive). */
  cost: number;
  /** Relative responsiveness (0–100, higher = faster / lower latency). */
  speed: number;
  /** True for models with strong multi-step / "thinking" reasoning. */
  reasoning: boolean;
  /** Effective input context window in tokens. */
  contextTokens: number;
}

export interface ModelMeta {
  id: string;
  name: string;
  vendor: string;
  family: string;
  maxInputTokens?: number;
}

export interface ProfiledModel extends ModelMeta {
  axes: ModelAxes;
  /** 'registry' when a curated rule matched; 'heuristic' when we fell back to name signals. */
  source: 'registry' | 'heuristic';
}

interface RegistryRule {
  /** Matched against the lowercased `"<family> <id> <name>"` haystack. */
  test: RegExp;
  axes: Omit<ModelAxes, 'contextTokens'> & { contextTokens?: number };
}

// Ordered, specific-first. The first rule whose pattern matches wins, so e.g. a "-mini"
// reasoning model is matched before the generic full-size family.
const RULES: RegistryRule[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  { test: /opus/u, axes: { capability: 95, cost: 92, speed: 38, reasoning: true, contextTokens: 200000 } },
  { test: /haiku/u, axes: { capability: 60, cost: 18, speed: 95, reasoning: false, contextTokens: 200000 } },
  { test: /sonnet/u, axes: { capability: 85, cost: 55, speed: 70, reasoning: true, contextTokens: 200000 } },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  { test: /\bo[134]-?mini\b|o4-?mini|o3-?mini/u, axes: { capability: 80, cost: 35, speed: 58, reasoning: true, contextTokens: 200000 } },
  { test: /\bo1\b|\bo3\b|\bo4\b/u, axes: { capability: 93, cost: 85, speed: 32, reasoning: true, contextTokens: 200000 } },
  { test: /gpt-?5-?(mini|nano)/u, axes: { capability: 64, cost: 20, speed: 90, reasoning: false, contextTokens: 256000 } },
  { test: /gpt-?5/u, axes: { capability: 93, cost: 80, speed: 45, reasoning: true, contextTokens: 256000 } },
  { test: /gpt-?4\.?1-?mini|gpt-?4o-?mini/u, axes: { capability: 60, cost: 18, speed: 92, reasoning: false, contextTokens: 128000 } },
  { test: /gpt-?4\.?1/u, axes: { capability: 82, cost: 50, speed: 70, reasoning: false, contextTokens: 1000000 } },
  { test: /gpt-?4o/u, axes: { capability: 80, cost: 50, speed: 72, reasoning: false, contextTokens: 128000 } },
  { test: /gpt-?4/u, axes: { capability: 76, cost: 60, speed: 50, reasoning: false, contextTokens: 128000 } },
  { test: /gpt-?3\.?5/u, axes: { capability: 55, cost: 15, speed: 95, reasoning: false, contextTokens: 16000 } },

  // ── Google ─────────────────────────────────────────────────────────────────
  { test: /gemini.*(flash-?lite)/u, axes: { capability: 58, cost: 10, speed: 97, reasoning: false, contextTokens: 1000000 } },
  { test: /gemini.*flash/u, axes: { capability: 70, cost: 18, speed: 95, reasoning: false, contextTokens: 1000000 } },
  { test: /gemini.*pro/u, axes: { capability: 88, cost: 60, speed: 58, reasoning: true, contextTokens: 1000000 } },
  { test: /gemini/u, axes: { capability: 72, cost: 30, speed: 75, reasoning: false, contextTokens: 1000000 } },

  // ── Open models / others ────────────────────────────────────────────────────
  { test: /deepseek.*r1|deepseek-reason/u, axes: { capability: 85, cost: 35, speed: 45, reasoning: true, contextTokens: 128000 } },
  { test: /llama.*(70b|405b|maverick)/u, axes: { capability: 74, cost: 28, speed: 62, reasoning: false, contextTokens: 128000 } },
  { test: /mistral.*large|mixtral/u, axes: { capability: 72, cost: 30, speed: 66, reasoning: false, contextTokens: 128000 } },
  { test: /\bphi\b|phi-?\d/u, axes: { capability: 55, cost: 12, speed: 94, reasoning: false, contextTokens: 128000 } },
  { test: /qwen.*(72b|coder)/u, axes: { capability: 73, cost: 25, speed: 64, reasoning: false, contextTokens: 128000 } },
];

// Fallback signals when no curated rule matches an unknown model.
const LIGHT_SIGNALS = /mini|haiku|flash|lite|nano|small|\bphi\b|8b|tiny/u;
const HEAVY_SIGNALS = /opus|o1|o3|gpt-?5|thinking|reason|pro\b|ultra|large/u;

/** Build a full capability profile for a model, preferring the curated registry. */
export function profileModel(meta: ModelMeta): ProfiledModel {
  const hay = `${meta.family} ${meta.id} ${meta.name}`.toLowerCase();

  for (const rule of RULES) {
    if (rule.test.test(hay)) {
      const contextTokens = meta.maxInputTokens ?? rule.axes.contextTokens ?? 128000;
      return { ...meta, source: 'registry', axes: { ...rule.axes, contextTokens } };
    }
  }

  // Unknown model: derive a reasonable profile from name signals + the real context window.
  const contextTokens = meta.maxInputTokens ?? 128000;
  if (LIGHT_SIGNALS.test(hay)) {
    return { ...meta, source: 'heuristic', axes: { capability: 56, cost: 18, speed: 92, reasoning: false, contextTokens } };
  }
  if (HEAVY_SIGNALS.test(hay)) {
    return { ...meta, source: 'heuristic', axes: { capability: 90, cost: 82, speed: 40, reasoning: true, contextTokens } };
  }
  return { ...meta, source: 'heuristic', axes: { capability: 75, cost: 50, speed: 70, reasoning: false, contextTokens } };
}

export function profileModels(models: ModelMeta[]): ProfiledModel[] {
  return models.map(profileModel);
}
