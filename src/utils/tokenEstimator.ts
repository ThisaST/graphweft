export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function clampTokenBudget(requested: number, modelMaxInputTokens?: number): number {
  if (!modelMaxInputTokens || modelMaxInputTokens <= 0) {
    return requested;
  }

  return Math.max(1000, Math.min(requested, Math.floor(modelMaxInputTokens * 0.6)));
}
