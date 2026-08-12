/**
 * Token-savings benchmark: CodeGraph compact context vs naive full-file RAG.
 *
 * Fully offline and reproducible:
 *  - Indexes a directory with the same headless engine the CLI/MCP server use.
 *  - For each realistic dev-task query:
 *      A) CodeGraph: GraphRetriever + buildContextMarkdown (the exact payload the
 *         MCP `codegraph_context` tool returns).
 *      B) Naive RAG baseline: dump the FULL text of the files CodeGraph deemed
 *         relevant — what an agent does when it greps and reads whole files.
 *      C) Grep-style baseline: dump the full text of every file whose content
 *         lexically matches the query keywords (agents without ranking do this).
 *  - Counts tokens with gpt-tokenizer (o200k_base — GPT-4o/o-series encoding),
 *    a real BPE tokenizer, not a bytes/4 estimate.
 *
 * Usage:
 *   node out/benchmark/tokenBenchmark.js [dir] [--json <out.json>] [--md <out.md>]
 */
import * as fs from 'fs';
import * as nodePath from 'path';
import { CodeGraphEngine } from '../node/codegraphEngine';
import { GraphRetriever } from '../graph/graphRetriever';
import { buildContextMarkdown } from '../compressor/contextCompressor';
import { scanDirectory } from '../node/nodeScanner';

// gpt-tokenizer resolves via package.json subpath exports, which our node10
// moduleResolution can't type-check — require it with an explicit signature.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { countTokens } = require('gpt-tokenizer/encoding/o200k_base') as { countTokens: (text: string) => number };

interface TaskResult {
  task: string;
  codegraphTokens: number;
  naiveTokens: number;      // full text of CodeGraph's own relevant files
  grepTokens: number;       // full text of keyword-matched files
  filesInContext: number;
  naiveFiles: number;
  grepFiles: number;
  savingsVsNaivePct: number;
  savingsVsGrepPct: number;
}

export interface BenchmarkReport {
  generatedAt: string;
  root: string;
  encoding: string;
  tokenBudget: number;
  indexed: { files: number; symbols: number; edges: number };
  tasks: TaskResult[];
  totals: {
    codegraphTokens: number;
    naiveTokens: number;
    grepTokens: number;
    savingsVsNaivePct: number;
    savingsVsGrepPct: number;
  };
}

/** Realistic dev tasks phrased the way agent users phrase them. */
export const DEFAULT_TASKS = [
  'explain how the login flow works',
  'add a new slash command to the chat participant',
  'fix a bug where the graph does not refresh after files change',
  'add tests for the retrieval ranking',
  'how are token savings calculated',
  'refactor the sqlite persistence layer',
  'trace how an import statement becomes a graph edge',
  'where is the privacy mode enforced before sending prompts',
];

const TOKEN_BUDGET = 6000;

export async function runBenchmark(root: string, tasks: string[] = DEFAULT_TASKS): Promise<BenchmarkReport> {
  const engine = new CodeGraphEngine();
  const summary = await engine.indexDirectory(root);
  const sources = await scanDirectory(root);
  const textByPath = new Map(sources.map((s) => [s.workspaceRelativePath, s.text]));

  const results: TaskResult[] = [];
  for (const task of tasks) {
    const retrieval = new GraphRetriever(engineStore(engine)).retrieve(task, TOKEN_BUDGET);
    const contextMarkdown = buildContextMarkdown(task, retrieval, TOKEN_BUDGET);
    const codegraphTokens = countTokens(contextMarkdown);

    // Baseline A: naive RAG = full contents of the files CodeGraph flagged relevant.
    const relevantPaths = retrieval.files.map((r) => r.file.path);
    const naiveTokens = relevantPaths.reduce((sum, p) => sum + countTokens(textByPath.get(p) ?? ''), 0);

    // Baseline B: grep-style = full contents of every file lexically matching query terms.
    const grepPaths = grepMatchedPaths(task, textByPath);
    const grepTokens = grepPaths.reduce((sum, p) => sum + countTokens(textByPath.get(p) ?? ''), 0);

    results.push({
      task,
      codegraphTokens,
      naiveTokens,
      grepTokens,
      filesInContext: relevantPaths.length,
      naiveFiles: relevantPaths.length,
      grepFiles: grepPaths.length,
      savingsVsNaivePct: pct(codegraphTokens, naiveTokens),
      savingsVsGrepPct: pct(codegraphTokens, grepTokens),
    });
  }

  const totalCg = results.reduce((s, r) => s + r.codegraphTokens, 0);
  const totalNaive = results.reduce((s, r) => s + r.naiveTokens, 0);
  const totalGrep = results.reduce((s, r) => s + r.grepTokens, 0);

  return {
    generatedAt: new Date().toISOString(),
    root: nodePath.resolve(root),
    encoding: 'o200k_base (GPT-4o / o-series)',
    tokenBudget: TOKEN_BUDGET,
    indexed: summary,
    tasks: results,
    totals: {
      codegraphTokens: totalCg,
      naiveTokens: totalNaive,
      grepTokens: totalGrep,
      savingsVsNaivePct: pct(totalCg, totalNaive),
      savingsVsGrepPct: pct(totalCg, totalGrep),
    },
  };
}

/** Store accessor kept separate so the type stays aligned with CodeGraphEngine internals. */
function engineStore(engine: CodeGraphEngine): ConstructorParameters<typeof GraphRetriever>[0] {
  return (engine as unknown as { store: ConstructorParameters<typeof GraphRetriever>[0] }).store;
}

function pct(actual: number, baseline: number): number {
  if (baseline <= 0) return 0;
  return Math.round(((baseline - actual) / baseline) * 1000) / 10;
}

/** Files whose content contains ≥2 significant query terms (or 1 for short queries). */
function grepMatchedPaths(task: string, textByPath: Map<string, string>): string[] {
  const terms = task
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 3 && !STOPWORDS.has(t));
  const required = Math.min(2, terms.length);
  const matched: string[] = [];
  for (const [path, text] of textByPath) {
    const lower = text.toLowerCase();
    let hits = 0;
    for (const term of terms) {
      if (lower.includes(term)) hits++;
      if (hits >= required) break;
    }
    if (hits >= required && required > 0) matched.push(path);
  }
  return matched;
}

const STOPWORDS = new Set(['does', 'after', 'where', 'when', 'what', 'with', 'that', 'this', 'have', 'from', 'into', 'works', 'how']);

export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('# CodeGraph Token-Savings Benchmark');
  lines.push('');
  lines.push(`_Generated ${report.generatedAt} · tokenizer: **${report.encoding}** · budget: ${report.tokenBudget} tokens_`);
  lines.push('');
  lines.push(`Indexed **${report.indexed.files} files**, ${report.indexed.symbols} symbols, ${report.indexed.edges} edges from \`${report.root}\`.`);
  lines.push('');
  lines.push('**Method.** For each task: (A) the exact compact context package the MCP `codegraph_context` tool returns;');
  lines.push('(B) *naive RAG* — the full text of the same files CodeGraph ranked relevant; (C) *grep-style* — the full text');
  lines.push('of every file lexically matching the query keywords (what an unranked agent reads). Token counts are real BPE');
  lines.push('counts, not estimates.');
  lines.push('');
  lines.push('| Task | CodeGraph | Naive RAG | Grep-style | vs naive | vs grep |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const t of report.tasks) {
    lines.push(
      `| ${t.task} | ${fmt(t.codegraphTokens)} | ${fmt(t.naiveTokens)} (${t.naiveFiles}f) | ${fmt(t.grepTokens)} (${t.grepFiles}f) | **${t.savingsVsNaivePct}%** | **${t.savingsVsGrepPct}%** |`,
    );
  }
  lines.push(
    `| **Total** | **${fmt(report.totals.codegraphTokens)}** | **${fmt(report.totals.naiveTokens)}** | **${fmt(report.totals.grepTokens)}** | **${report.totals.savingsVsNaivePct}%** | **${report.totals.savingsVsGrepPct}%** |`,
  );
  lines.push('');
  lines.push('## Honest caveats');
  lines.push('');
  lines.push('- Baselines are reproducible strawmen, not "what tool X would send" — every agent selects context differently.');
  lines.push('- The compact package trades full bodies for references + signatures + ≤3 snippets; complex edits still require');
  lines.push('  the agent to read specific files afterwards (but *targeted* ones, not everything).');
  lines.push('- Savings apply to the context-assembly step; multi-turn tool loops add their own costs on both sides.');
  lines.push('');
  return lines.join('\n');
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args[0] && !args[0].startsWith('--') ? args[0] : '.';
  const jsonOut = valueAfter(args, '--json');
  const mdOut = valueAfter(args, '--md');

  runBenchmark(dir)
    .then((report) => {
      const md = renderMarkdown(report);
      if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
      if (mdOut) fs.writeFileSync(mdOut, md);
      process.stdout.write(md + '\n');
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
