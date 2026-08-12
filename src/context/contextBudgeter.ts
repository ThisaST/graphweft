import { estimateTokens } from '../utils/tokenEstimator';

export class ContextBudgeter {
  private usedTokens = 0;

  public constructor(private readonly maxTokens: number) {}

  public tryUse(text: string): boolean {
    const cost = estimateTokens(text);
    if (this.usedTokens + cost > this.maxTokens) {
      return false;
    }

    this.usedTokens += cost;
    return true;
  }

  public get used(): number {
    return this.usedTokens;
  }

  public get max(): number {
    return this.maxTokens;
  }
}
