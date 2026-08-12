import * as assert from 'assert';
import { AuditEntry } from '../privacy/auditLog';
import { bytesToTokens, summarizeSavings } from '../privacy/tokenSavingsAnalyzer';

function entry(partial: Partial<AuditEntry> & { promptBytes: number; naiveBaselineBytes?: number; outcome?: AuditEntry['outcome'] }): AuditEntry {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    timestamp: partial.timestamp ?? new Date().toISOString(),
    task: partial.task ?? 'task',
    taskType: partial.taskType ?? 'explain',
    modelId: partial.modelId ?? 'm',
    modelVendor: partial.modelVendor ?? 'v',
    promptBytes: partial.promptBytes,
    promptSha256: partial.promptSha256 ?? 'x',
    filesIncluded: partial.filesIncluded ?? [],
    symbolsIncluded: partial.symbolsIncluded ?? [],
    snippetsIncluded: partial.snippetsIncluded ?? 0,
    outcome: partial.outcome ?? 'sent',
    naiveBaselineBytes: partial.naiveBaselineBytes,
    promptTokens: partial.promptTokens,
    baselineTokens: partial.baselineTokens,
    totalInputTokens: partial.totalInputTokens,
    modelRounds: partial.modelRounds,
    outputTokens: partial.outputTokens,
  };
}

function approx(actual: number, expected: number, delta = 1): void {
  assert.ok(Math.abs(actual - expected) <= delta, `expected ~${expected}, got ${actual}`);
}

(function emptyLog(): void {
  const summary = summarizeSavings([]);
  assert.strictEqual(summary.requests, 0);
  assert.strictEqual(summary.savedTokens, 0);
  assert.strictEqual(summary.savingsPercent, 0);
  assert.strictEqual(summary.costAtPricePerMillionTokens(3), 0);
})();

(function ignoresEntriesWithoutBaseline(): void {
  const summary = summarizeSavings([entry({ promptBytes: 4000 })]);
  assert.strictEqual(summary.requests, 0, 'entries missing naiveBaselineBytes should be skipped');
})();

(function ignoresNonSentOutcomes(): void {
  const summary = summarizeSavings([
    entry({ promptBytes: 4000, naiveBaselineBytes: 40000, outcome: 'blocked' }),
    entry({ promptBytes: 4000, naiveBaselineBytes: 40000, outcome: 'cancelled' }),
    entry({ promptBytes: 4000, naiveBaselineBytes: 40000, outcome: 'error' }),
  ]);
  assert.strictEqual(summary.requests, 0, 'only sent calls should count toward savings');
})();

(function computesSavingsAcrossMultipleSentCalls(): void {
  const entries = [
    entry({ promptBytes: 4000, naiveBaselineBytes: 40000, task: 'A' }),
    entry({ promptBytes: 8000, naiveBaselineBytes: 80000, task: 'B' }),
    entry({ promptBytes: 2000, naiveBaselineBytes: 6000, task: 'C' }),
  ];
  const summary = summarizeSavings(entries);

  assert.strictEqual(summary.requests, 3);
  approx(summary.actualBytes, 14000);
  approx(summary.baselineBytes, 126000);
  approx(summary.savedBytes, 112000);
  approx(summary.actualTokens, bytesToTokens(14000));
  approx(summary.baselineTokens, bytesToTokens(126000));
  approx(summary.savedTokens, bytesToTokens(126000) - bytesToTokens(14000));
  assert.ok(summary.savingsPercent > 80, `expected >80% savings, got ${summary.savingsPercent}`);
})();

(function picksHighestAbsoluteSavingsAsBest(): void {
  const entries = [
    entry({ promptBytes: 1000, naiveBaselineBytes: 4000, task: 'tiny win' }),       // saves 3000B
    entry({ promptBytes: 10000, naiveBaselineBytes: 100000, task: 'big win' }),     // saves 90000B
    entry({ promptBytes: 5000, naiveBaselineBytes: 5000, task: 'zero' }),           // saves 0
  ];
  const summary = summarizeSavings(entries);
  assert.ok(summary.bestSavingsRequest, 'expected a best request');
  assert.strictEqual(summary.bestSavingsRequest!.task, 'big win');
})();

(function picksLargestBaselineAsWorstCase(): void {
  const entries = [
    entry({ promptBytes: 1000, naiveBaselineBytes: 4000, task: 'small' }),
    entry({ promptBytes: 1000, naiveBaselineBytes: 200000, task: 'huge baseline' }),
  ];
  const summary = summarizeSavings(entries);
  assert.ok(summary.worstCaseRequest);
  assert.strictEqual(summary.worstCaseRequest!.task, 'huge baseline');
})();

(function costScalesLinearlyWithPrice(): void {
  const entries = [entry({ promptBytes: 4_000, naiveBaselineBytes: 4_000_004 })];
  const summary = summarizeSavings(entries);
  const cost3 = summary.costAtPricePerMillionTokens(3);
  const cost15 = summary.costAtPricePerMillionTokens(15);
  approx(cost15 / cost3, 5, 0.01);
})();

(function avgSavedPerCallMatches(): void {
  const entries = [
    entry({ promptBytes: 1000, naiveBaselineBytes: 5000 }),
    entry({ promptBytes: 1000, naiveBaselineBytes: 5000 }),
  ];
  const summary = summarizeSavings(entries);
  approx(summary.avgSavedTokensPerCall, summary.savedTokens / 2, 1);
})();

(function prefersRealTokenizerCountsOverBytes(): void {
  // promptBytes/naiveBaselineBytes would estimate 250/2500 tokens, but the recorded
  // tokenizer counts (300 actual, 3000 baseline) must take precedence.
  const summary = summarizeSavings([
    entry({ promptBytes: 1000, naiveBaselineBytes: 10000, promptTokens: 300, baselineTokens: 3000 }),
  ]);
  assert.strictEqual(summary.actualTokens, 300, 'should use promptTokens, not bytes/4');
  assert.strictEqual(summary.baselineTokens, 3000, 'should use baselineTokens, not bytes/4');
  assert.strictEqual(summary.savedTokens, 2700);
  assert.strictEqual(summary.measured, true);
})();

(function aggregatesEndToEndLoopTokens(): void {
  const summary = summarizeSavings([
    entry({ promptBytes: 1000, naiveBaselineBytes: 10000, promptTokens: 300, baselineTokens: 3000, totalInputTokens: 1200 }),
    entry({ promptBytes: 1000, naiveBaselineBytes: 10000, promptTokens: 300, baselineTokens: 3000, totalInputTokens: 800 }),
  ]);
  assert.strictEqual(summary.totalLoopTokens, 2000, 'end-to-end loop tokens should sum across calls');
})();

(function loopTokensFallBackToContextWhenMissing(): void {
  // Old entries without totalInputTokens should contribute their context tokens instead.
  const summary = summarizeSavings([entry({ promptBytes: 4000, naiveBaselineBytes: 40000 })]);
  assert.strictEqual(summary.totalLoopTokens, summary.actualTokens);
  assert.strictEqual(summary.measured, false, 'bytes-only entries are estimated, not measured');
})();

(function aggregatesOutputTokensAndTotalSpend(): void {
  const summary = summarizeSavings([
    entry({ promptBytes: 1000, naiveBaselineBytes: 10000, promptTokens: 300, baselineTokens: 3000, totalInputTokens: 1200, outputTokens: 400 }),
    entry({ promptBytes: 1000, naiveBaselineBytes: 10000, promptTokens: 300, baselineTokens: 3000, totalInputTokens: 800, outputTokens: 100 }),
  ]);
  assert.strictEqual(summary.totalOutputTokens, 500);
  assert.strictEqual(summary.totalTokens, 2000 + 500, 'total spend = input loop + output');
})();

(function spendScalesWithInputAndOutputPrices(): void {
  const summary = summarizeSavings([
    entry({ promptBytes: 1000, naiveBaselineBytes: 10000, promptTokens: 300, baselineTokens: 3000, totalInputTokens: 1_000_000, outputTokens: 1_000_000 }),
  ]);
  // 1M input @ $3 + 1M output @ $15 = $18.
  approx(summary.spendAtPricePerMillionTokens(3, 15), 18, 0.001);
})();

console.log('tokenSavings.test.ts passed');
