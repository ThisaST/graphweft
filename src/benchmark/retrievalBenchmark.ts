/**
 * Three-way retrieval benchmark:
 *
 *   A) NO GRAPHWEFT  — grep-style: rank files by lexical keyword hits, read the
 *      full text of the top matches (what an agent without an index does).
 *   B) GRAPHWEFT     — graph/lexical retrieval only (no embedding index): the
 *      compact context package from GraphRetriever + buildContextMarkdown.
 *   C) GRAPHWEFT+EMB — hybrid: chunk-level embedding similarities fused into the
 *      same retriever via reciprocal-rank fusion (exactly what `graphweft search`
 *      and the MCP `graphweft_context` tool do when an embedding index exists).
 *
 * For each query with known ground-truth files we measure:
 *   - retrieval quality: hit@1, hit@5, MRR (rank of the first ground-truth file)
 *   - token cost of the context an agent would send (real o200k_base BPE counts)
 *   - retrieval latency (mode C includes query embedding; model load excluded
 *     via a warm-up embed)
 *
 * Requires an existing embedding index for mode C — build one first:
 *   node out/node/cli.js embed <dir> [--model <hf-id>]
 * and run with the same GRAPHWEFT_EMBED_MODEL so the provider id matches.
 *
 * Usage:
 *   node out/benchmark/retrievalBenchmark.js [dir] [--json out.json] [--md out.md]
 */
import * as fs from 'fs';
import * as nodePath from 'path';
import { GraphweftEngine } from '../node/graphweftEngine';
import { GraphRetriever } from '../graph/graphRetriever';
import { buildContextMarkdown } from '../compressor/contextCompressor';
import { scanDirectory } from '../node/nodeScanner';
import { HeadlessSemanticIndex, toFileMatches } from '../semantic/headlessSemanticIndex';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { countTokens } = require('gpt-tokenizer/encoding/o200k_base') as { countTokens: (text: string) => number };

// ------------------------------------------------------------------------------------
// Query set with ground truth. `kind` records whether the phrasing shares vocabulary
// with the target code (lexical) or deliberately avoids it (conceptual) — conceptual
// queries are where embeddings are expected to help.
// ------------------------------------------------------------------------------------

export interface QuerySpec {
  query: string;
  /** Any of these workspace-relative paths counts as a correct hit. */
  expected: string[];
  kind: 'lexical' | 'conceptual';
}

export const QUERIES: QuerySpec[] = [
  // --- lexical: query words appear in the target files ---
  {
    query: 'where is the file watcher debounce implemented',
    expected: ['src/indexer/fileWatcher.ts'],
    kind: 'lexical',
  },
  {
    query: 'reciprocal rank fusion of ranking signals',
    expected: ['src/graph/graphRanker.ts', 'src/graph/graphRetriever.ts'],
    kind: 'lexical',
  },
  {
    query: 'louvain community detection on the import graph',
    expected: ['src/graph/graphAlgorithms.ts'],
    kind: 'lexical',
  },
  {
    query: 'sqlite vector store for embeddings',
    expected: ['src/semantic/sqliteVectorStore.ts'],
    kind: 'lexical',
  },
  {
    query: 'chunk source files per top-level symbol for embedding',
    expected: ['src/semantic/codeChunker.ts'],
    kind: 'lexical',
  },
  // --- conceptual: deliberately no shared identifiers with the target ---
  {
    query: 'coalesce rapid bursts of disk change notifications before rebuilding',
    expected: ['src/indexer/fileWatcher.ts'],
    kind: 'conceptual',
  },
  {
    query: 'make sure the AI endpoint we talk to is running on this machine and not somewhere remote',
    expected: ['src/semantic/embeddingProvider.ts'],
    kind: 'conceptual',
  },
  {
    query: 'keep the prompt small enough to fit what the model can accept',
    expected: ['src/context/contextBudgeter.ts', 'src/utils/tokenEstimator.ts'],
    kind: 'conceptual',
  },
  {
    query: 'blast radius of editing one source file across the project',
    expected: ['src/graph/graphAlgorithms.ts'],
    kind: 'conceptual',
  },
  {
    query: 'suggest a cheaper AI model when the job looks simple',
    expected: ['src/chat/modelRecommender.ts', 'src/chat/complexityClassifier.ts', 'src/chat/modelAdvisor.ts'],
    kind: 'conceptual',
  },
  {
    query: 'apply a code edit even when indentation or line endings differ slightly',
    expected: ['src/chat/textReplace.ts'],
    kind: 'conceptual',
  },
  {
    query: 'user consent gate before anything leaves the machine',
    expected: ['src/privacy/privacyManager.ts'],
    kind: 'conceptual',
  },
];

const TOKEN_BUDGET = 6000;
const GREP_TOP_FILES = 5; // an agent typically opens the first handful of matches

// ------------------------------------------------------------------------------------
// Result shapes
// ------------------------------------------------------------------------------------

interface ModeResult {
  rank: number | undefined; // 1-based rank of first ground-truth file, undefined = miss
  tokens: number;
  ms: number;
  rankedTop: string[]; // top-5 paths, for the report
}

interface QueryResult {
  query: string;
  kind: QuerySpec['kind'];
  expected: string[];
  grep: ModeResult;
  graph: ModeResult;
  hybrid: ModeResult;
  /** Diagnostic: rank in the raw embedding result alone (no graph fusion). */
  semanticOnlyRank: number | undefined;
}

interface Aggregate {
  hitAt1: number;
  hitAt5: number;
  mrr: number;
  tokens: number;
  avgMs: number;
}

export interface RetrievalBenchmarkReport {
  generatedAt: string;
  root: string;
  encoding: string;
  tokenBudget: number;
  embeddingProvider: string;
  indexed: { files: number; symbols: number; edges: number };
  vectorChunks: number;
  queries: QueryResult[];
  totals: { grep: Aggregate; graph: Aggregate; hybrid: Aggregate };
  totalsByKind: Record<QuerySpec['kind'], { grep: Aggregate; graph: Aggregate; hybrid: Aggregate }>;
}

// ------------------------------------------------------------------------------------
// Benchmark
// ------------------------------------------------------------------------------------

export async function runRetrievalBenchmark(root: string, queries: QuerySpec[] = QUERIES): Promise<RetrievalBenchmarkReport> {
  const engine = new GraphweftEngine();
  const summary = await engine.indexDirectory(root);
  const store = engineStore(engine);
  const sources = await scanDirectory(root);
  const textByPath = new Map(sources.map((s) => [s.workspaceRelativePath, s.text]));

  const semantic = await HeadlessSemanticIndex.open(nodePath.resolve(root));
  if (!semantic.canEmbed() || !semantic.hasVectors()) {
    throw new Error(
      'Mode C needs an embedding index whose provider matches the current config. ' +
        'Run `node out/node/cli.js embed <dir>` first (same GRAPHWEFT_EMBED_MODEL).',
    );
  }
  await semantic.trySearch('warm up the pipeline', 1); // load the model outside timings

  const results: QueryResult[] = [];
  for (const spec of queries) {
    // --- A) grep-style, no Graphweft ---
    const grepStart = performance.now();
    const grepRanked = grepRank(spec.query, textByPath);
    const grepMs = performance.now() - grepStart;
    const grepRead = grepRanked.slice(0, GREP_TOP_FILES);
    const grepTokens = grepRead.reduce((sum, p) => sum + countTokens(textByPath.get(p) ?? ''), 0);

    // --- B) Graphweft, graph/lexical only ---
    const graphStart = performance.now();
    const graphRetrieval = new GraphRetriever(store).retrieve(spec.query, TOKEN_BUDGET);
    const graphMs = performance.now() - graphStart;
    const graphMarkdown = buildContextMarkdown(spec.query, graphRetrieval, TOKEN_BUDGET);
    const graphRanked = graphRetrieval.files.map((r) => r.file.path);

    // --- C) Graphweft + embeddings (hybrid) ---
    const hybridStart = performance.now();
    const chunkMatches = await semantic.trySearch(spec.query, 24);
    const hints = chunkMatches.length > 0 ? { semanticMatches: toFileMatches(chunkMatches) } : {};
    const hybridRetrieval = new GraphRetriever(store).retrieve(spec.query, TOKEN_BUDGET, hints);
    const hybridMs = performance.now() - hybridStart;
    const hybridMarkdown = buildContextMarkdown(spec.query, hybridRetrieval, TOKEN_BUDGET);
    const hybridRanked = hybridRetrieval.files.map((r) => r.file.path);

    const semanticRanked = toFileMatches(chunkMatches).map((m) => m.path);
    const semanticIdx = semanticRanked.findIndex((p) => spec.expected.includes(p));

    results.push({
      query: spec.query,
      kind: spec.kind,
      expected: spec.expected,
      grep: mode(grepRanked, spec.expected, grepTokens, grepMs),
      graph: mode(graphRanked, spec.expected, countTokens(graphMarkdown), graphMs),
      hybrid: mode(hybridRanked, spec.expected, countTokens(hybridMarkdown), hybridMs),
      semanticOnlyRank: semanticIdx >= 0 ? semanticIdx + 1 : undefined,
    });
  }

  const providerId = semantic.providerId() ?? 'unknown';
  return {
    generatedAt: new Date().toISOString(),
    root: nodePath.resolve(root),
    encoding: 'o200k_base (GPT-4o / o-series)',
    tokenBudget: TOKEN_BUDGET,
    embeddingProvider: providerId,
    indexed: summary,
    vectorChunks: semantic.stats().chunks,
    queries: results,
    totals: {
      grep: aggregate(results.map((r) => r.grep)),
      graph: aggregate(results.map((r) => r.graph)),
      hybrid: aggregate(results.map((r) => r.hybrid)),
    },
    totalsByKind: {
      lexical: kindAggregate(results, 'lexical'),
      conceptual: kindAggregate(results, 'conceptual'),
    },
  };
}

function mode(ranked: string[], expected: string[], tokens: number, ms: number): ModeResult {
  const idx = ranked.findIndex((p) => expected.includes(p));
  return {
    rank: idx >= 0 ? idx + 1 : undefined,
    tokens,
    ms: Math.round(ms * 10) / 10,
    rankedTop: ranked.slice(0, 5),
  };
}

function aggregate(modes: ModeResult[]): Aggregate {
  const n = modes.length || 1;
  return {
    hitAt1: round(modes.filter((m) => m.rank === 1).length / n),
    hitAt5: round(modes.filter((m) => m.rank !== undefined && m.rank <= 5).length / n),
    mrr: round(modes.reduce((s, m) => s + (m.rank ? 1 / m.rank : 0), 0) / n),
    tokens: modes.reduce((s, m) => s + m.tokens, 0),
    avgMs: Math.round((modes.reduce((s, m) => s + m.ms, 0) / n) * 10) / 10,
  };
}

function kindAggregate(results: QueryResult[], kind: QuerySpec['kind']) {
  const subset = results.filter((r) => r.kind === kind);
  return {
    grep: aggregate(subset.map((r) => r.grep)),
    graph: aggregate(subset.map((r) => r.graph)),
    hybrid: aggregate(subset.map((r) => r.hybrid)),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Store accessor kept separate so the type stays aligned with GraphweftEngine internals. */
function engineStore(engine: GraphweftEngine): ConstructorParameters<typeof GraphRetriever>[0] {
  return (engine as unknown as { store: ConstructorParameters<typeof GraphRetriever>[0] }).store;
}

// ------------------------------------------------------------------------------------
// Mode A: grep-style ranking — term-frequency score over significant query words.
// This is a *generous* baseline: real grep sessions don't rank at all.
// ------------------------------------------------------------------------------------

function grepRank(query: string, textByPath: Map<string, string>): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 3 && !STOPWORDS.has(t));
  const scored: Array<{ path: string; score: number }> = [];
  for (const [path, text] of textByPath) {
    const lower = text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let at = lower.indexOf(term);
      let hits = 0;
      while (at >= 0 && hits < 50) {
        hits++;
        at = lower.indexOf(term, at + term.length);
      }
      // Distinct-term coverage matters more than raw frequency.
      if (hits > 0) score += 10 + Math.min(hits, 10);
    }
    if (score > 0) scored.push({ path, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.path);
}

const STOPWORDS = new Set([
  'does', 'after', 'where', 'when', 'what', 'with', 'that', 'this', 'have', 'from',
  'into', 'works', 'how', 'before', 'make', 'sure', 'even', 'looks', 'small', 'enough',
  'running', 'somewhere', 'anything', 'slightly',
]);

// ------------------------------------------------------------------------------------
// Markdown report
// ------------------------------------------------------------------------------------

export function renderRetrievalMarkdown(report: RetrievalBenchmarkReport): string {
  const lines: string[] = [];
  lines.push('# Graphweft Retrieval Benchmark — no index vs graph vs graph+embeddings');
  lines.push('');
  lines.push(`_Generated ${report.generatedAt} · tokenizer: **${report.encoding}** · budget: ${report.tokenBudget} tokens_`);
  lines.push('');
  lines.push(
    `Corpus: \`${report.root}\` — ${report.indexed.files} files, ${report.indexed.symbols} symbols, ` +
      `${report.indexed.edges} edges; embedding index: ${report.vectorChunks} chunks (\`${report.embeddingProvider}\`).`,
  );
  lines.push('');
  lines.push('**Modes.** (A) *No Graphweft* — grep-style term-frequency ranking, agent reads the full text of the top');
  lines.push(`${GREP_TOP_FILES} matches. (B) *Graphweft* — graph/lexical retrieval, compact context package. (C) *Graphweft +`);
  lines.push('embeddings* — same retriever with chunk-level embedding similarity fused in (hybrid RRF). Quality is scored');
  lines.push('against hand-labelled ground-truth files; a hit means a correct file appears in the ranked output.');
  lines.push('');

  lines.push('## Headline');
  lines.push('');
  lines.push('| Metric | A · no Graphweft | B · Graphweft | C · Graphweft + embeddings |');
  lines.push('| --- | ---: | ---: | ---: |');
  const t = report.totals;
  lines.push(`| hit@1 | ${pctFmt(t.grep.hitAt1)} | ${pctFmt(t.graph.hitAt1)} | **${pctFmt(t.hybrid.hitAt1)}** |`);
  lines.push(`| hit@5 | ${pctFmt(t.grep.hitAt5)} | ${pctFmt(t.graph.hitAt5)} | **${pctFmt(t.hybrid.hitAt5)}** |`);
  lines.push(`| MRR | ${t.grep.mrr} | ${t.graph.mrr} | **${t.hybrid.mrr}** |`);
  lines.push(`| context tokens (total) | ${fmt(t.grep.tokens)} | ${fmt(t.graph.tokens)} | ${fmt(t.hybrid.tokens)} |`);
  lines.push(`| avg retrieval latency | ${t.grep.avgMs} ms | ${t.graph.avgMs} ms | ${t.hybrid.avgMs} ms |`);
  lines.push('');

  lines.push('## By query kind');
  lines.push('');
  lines.push('| Kind | Metric | A | B | C |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  for (const kind of ['lexical', 'conceptual'] as const) {
    const k = report.totalsByKind[kind];
    lines.push(`| ${kind} | hit@5 | ${pctFmt(k.grep.hitAt5)} | ${pctFmt(k.graph.hitAt5)} | ${pctFmt(k.hybrid.hitAt5)} |`);
    lines.push(`| ${kind} | MRR | ${k.grep.mrr} | ${k.graph.mrr} | ${k.hybrid.mrr} |`);
  }
  lines.push('');

  lines.push('## Per query (rank of first correct file · context tokens)');
  lines.push('');
  lines.push('_"emb only" is diagnostic: the rank in the raw embedding results before graph fusion._');
  lines.push('');
  lines.push('| Query | Kind | A rank | B rank | C rank | emb only | A tokens | B tokens | C tokens |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const q of report.queries) {
    lines.push(
      `| ${q.query} | ${q.kind} | ${rankFmt(q.grep.rank)} | ${rankFmt(q.graph.rank)} | ${rankFmt(q.hybrid.rank)} | ` +
        `${rankFmt(q.semanticOnlyRank)} | ${fmt(q.grep.tokens)} | ${fmt(q.graph.tokens)} | ${fmt(q.hybrid.tokens)} |`,
    );
  }
  lines.push('');
  lines.push('## Honest caveats');
  lines.push('');
  lines.push('- Ground truth is hand-labelled by the repo authors; other judges might accept different files.');
  lines.push('- The grep baseline is generous (ranked term-frequency); real unranked grep sessions do worse.');
  lines.push('- Mode C latency includes embedding the query in-process (model already loaded); the one-off index');
  lines.push('  build and model download are excluded from all timings.');
  lines.push('- Token counts are context-assembly cost only; every mode still needs follow-up file reads for edits.');
  lines.push('');
  return lines.join('\n');
}

function pctFmt(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function rankFmt(rank: number | undefined): string {
  if (rank === undefined) return 'miss';
  return rank === 1 ? '**1**' : String(rank);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args[0] && !args[0].startsWith('--') ? args[0] : '.';
  const jsonOut = valueAfter(args, '--json');
  const mdOut = valueAfter(args, '--md');

  runRetrievalBenchmark(dir)
    .then((report) => {
      const md = renderRetrievalMarkdown(report);
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
