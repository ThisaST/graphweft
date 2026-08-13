import { AuditEntry } from './auditLog';

const charsPerToken = 4;

export interface SavingsSummary {
  requests: number;
  actualBytes: number;
  baselineBytes: number;
  savedBytes: number;
  actualTokens: number;
  baselineTokens: number;
  savedTokens: number;
  savingsPercent: number;
  avgSavedTokensPerCall: number;
  /** Total input tokens across all agent loops (end-to-end), when recorded. */
  totalLoopTokens: number;
  /** Total output (completion) tokens generated across all calls, when recorded. */
  totalOutputTokens: number;
  /** End-to-end spend = input loop tokens + output tokens. */
  totalTokens: number;
  /** True when at least one counted call used real tokenizer figures rather than bytes/4. */
  measured: boolean;
  worstCaseRequest?: { id: string; task: string; baselineTokens: number; actualTokens: number };
  bestSavingsRequest?: { id: string; task: string; savedTokens: number; savingsPercent: number };
  /** Dollar value of the context tokens saved, at a given input price per 1M tokens. */
  costAtPricePerMillionTokens: (usd: number) => number;
  /** End-to-end spend in dollars at given input/output prices per 1M tokens. */
  spendAtPricePerMillionTokens: (inputUsd: number, outputUsd: number) => number;
}

/** Actual context tokens for an entry: real tokenizer count if present, else bytes/4 estimate. */
function actualTokensOf(entry: AuditEntry): number {
  return entry.promptTokens ?? bytesToTokens(entry.promptBytes);
}

/** Naive-baseline tokens for an entry: real tokenizer count if present, else bytes/4 estimate. */
function baselineTokensOf(entry: AuditEntry): number {
  return entry.baselineTokens ?? bytesToTokens(entry.naiveBaselineBytes ?? 0);
}

export function summarizeSavings(entries: AuditEntry[]): SavingsSummary {
  const sent = entries.filter(
    (e) => e.outcome === 'sent' && (typeof e.naiveBaselineBytes === 'number' || typeof e.baselineTokens === 'number'),
  );
  let actualBytes = 0;
  let baselineBytes = 0;
  let actualTokens = 0;
  let baselineTokens = 0;
  let totalLoopTokens = 0;
  let totalOutputTokens = 0;
  let measured = false;
  let worst: SavingsSummary['worstCaseRequest'];
  let best: SavingsSummary['bestSavingsRequest'];

  for (const entry of sent) {
    actualBytes += entry.promptBytes;
    baselineBytes += entry.naiveBaselineBytes ?? 0;

    const entryActual = actualTokensOf(entry);
    const entryBaseline = baselineTokensOf(entry);
    actualTokens += entryActual;
    baselineTokens += entryBaseline;
    totalLoopTokens += entry.totalInputTokens ?? entryActual;
    totalOutputTokens += entry.outputTokens ?? 0;
    if (entry.promptTokens !== undefined || entry.baselineTokens !== undefined) {
      measured = true;
    }

    const savedTokens = entryBaseline - entryActual;
    const savingsPct = entryBaseline > 0 ? (savedTokens / entryBaseline) * 100 : 0;

    if (!worst || entryBaseline > worst.baselineTokens) {
      worst = { id: entry.id, task: entry.task, baselineTokens: entryBaseline, actualTokens: entryActual };
    }
    if (savedTokens > 0 && (!best || savedTokens > best.savedTokens)) {
      best = { id: entry.id, task: entry.task, savedTokens, savingsPercent: savingsPct };
    }
  }

  const requests = sent.length;
  const savedTokens = baselineTokens - actualTokens;
  const savingsPercent = baselineTokens > 0 ? (savedTokens / baselineTokens) * 100 : 0;
  const avgSavedTokensPerCall = requests > 0 ? Math.round(savedTokens / requests) : 0;

  return {
    requests,
    actualBytes,
    baselineBytes,
    savedBytes: baselineBytes - actualBytes,
    actualTokens,
    baselineTokens,
    savedTokens,
    savingsPercent,
    avgSavedTokensPerCall,
    totalLoopTokens,
    totalOutputTokens,
    totalTokens: totalLoopTokens + totalOutputTokens,
    measured,
    worstCaseRequest: worst,
    bestSavingsRequest: best,
    costAtPricePerMillionTokens: (usd) => (savedTokens / 1_000_000) * usd,
    spendAtPricePerMillionTokens: (inputUsd, outputUsd) =>
      (totalLoopTokens / 1_000_000) * inputUsd + (totalOutputTokens / 1_000_000) * outputUsd,
  };
}

export function renderSavingsMarkdown(summary: SavingsSummary): string {
  if (summary.requests === 0) {
    return [
      '### Token Savings',
      '',
      '_No completed model calls yet. Once `@graphweft` makes a request, this section will compare what Graphweft actually sent vs. what a naive "dump the relevant files" RAG would have sent._',
    ].join('\n');
  }

  const pct = summary.savingsPercent.toFixed(1);
  const basis = summary.measured
    ? 'Counts use the model’s real tokenizer (`model.countTokens`).'
    : `Tokens ≈ bytes / ${charsPerToken} (estimated — no tokenizer counts recorded yet).`;
  const lines = [
    `### Token Savings (across ${summary.requests} model call${summary.requests === 1 ? '' : 's'})`,
    '',
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Context tokens actually sent | **${summary.actualTokens.toLocaleString()}** |`,
    `| Tokens a naive baseline would have sent | ${summary.baselineTokens.toLocaleString()} |`,
    `| **Context tokens saved** | **${summary.savedTokens.toLocaleString()} (${pct}%)** |`,
    `| Avg saved per call | ${summary.avgSavedTokensPerCall.toLocaleString()} tokens |`,
    `| End-to-end input tokens (incl. agent loop) | ${summary.totalLoopTokens.toLocaleString()} |`,
    `| Output tokens generated | ${summary.totalOutputTokens.toLocaleString()} |`,
    `| **Total spend (input + output)** | **${summary.totalTokens.toLocaleString()}** |`,
    `| Bytes actually sent | ${(summary.actualBytes / 1024).toFixed(1)} KB |`,
    `| Baseline bytes | ${(summary.baselineBytes / 1024).toFixed(1)} KB |`,
    ``,
    `_Baseline = every file the retriever flagged as relevant, dumped in full, plus a small prompt-scaffolding overhead — what a naive "dump these files into the prompt" RAG would have cost. ${basis}_`,
    ``,
    `_"Context tokens saved" compares the first assembled context against that baseline. "End-to-end input tokens" is the honest total across all agent-loop rounds (each round re-sends the conversation), so it can exceed the first-context number._`,
    ``,
    `**Estimated dollar savings (context input tokens avoided vs. baseline):**`,
    `- $3 / 1M input tokens → **$${summary.costAtPricePerMillionTokens(3).toFixed(4)}**`,
    `- $5 / 1M input tokens → **$${summary.costAtPricePerMillionTokens(5).toFixed(4)}**`,
    `- $15 / 1M input tokens → **$${summary.costAtPricePerMillionTokens(15).toFixed(4)}**`,
    ``,
    `**Estimated actual spend (end-to-end input + output):**`,
    `- at $3 in / $15 out per 1M → **$${summary.spendAtPricePerMillionTokens(3, 15).toFixed(4)}**`,
    `- at $5 in / $15 out per 1M → **$${summary.spendAtPricePerMillionTokens(5, 15).toFixed(4)}**`,
    ``,
  ];

  if (summary.bestSavingsRequest) {
    lines.push(`**Best single call:** saved ${summary.bestSavingsRequest.savedTokens.toLocaleString()} tokens (${summary.bestSavingsRequest.savingsPercent.toFixed(1)}%) on _"${truncate(summary.bestSavingsRequest.task, 80)}"_`);
  }
  if (summary.worstCaseRequest) {
    lines.push(`**Most expensive baseline:** _"${truncate(summary.worstCaseRequest.task, 80)}"_ — would have been ${summary.worstCaseRequest.baselineTokens.toLocaleString()} tokens dumped; Graphweft sent ${summary.worstCaseRequest.actualTokens.toLocaleString()}.`);
  }

  return lines.join('\n');
}

export function bytesToTokens(bytes: number): number {
  return Math.ceil(bytes / charsPerToken);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}
