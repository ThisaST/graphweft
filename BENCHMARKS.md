# CodeGraph Token-Savings Benchmark

_Generated 2026-08-12T18:24:30.811Z · tokenizer: **o200k_base (GPT-4o / o-series)** · budget: 6000 tokens_

Indexed **91 files**, 620 symbols, 217 edges from `C:\Users\dtp\Development\ElementLogic\copilot-worktrees\codegraph-copilet-chat-main\thisara-sturdy-doodle`.

**Method.** For each task: (A) the exact compact context package the MCP `codegraph_context` tool returns;
(B) *naive RAG* — the full text of the same files CodeGraph ranked relevant; (C) *grep-style* — the full text
of every file lexically matching the query keywords (what an unranked agent reads). Token counts are real BPE
counts, not estimates.

| Task | CodeGraph | Naive RAG | Grep-style | vs naive | vs grep |
| --- | ---: | ---: | ---: | ---: | ---: |
| explain how the login flow works | 2,724 | 29,087 (16f) | 17,772 (10f) | **90.6%** | **84.7%** |
| add a new slash command to the chat participant | 3,614 | 31,851 (16f) | 51,861 (21f) | **88.7%** | **93%** |
| fix a bug where the graph does not refresh after files change | 2,995 | 26,177 (16f) | 111,540 (63f) | **88.6%** | **97.3%** |
| add tests for the retrieval ranking | 2,650 | 25,061 (16f) | 34,096 (16f) | **89.4%** | **92.2%** |
| how are token savings calculated | 2,779 | 37,987 (16f) | 42,446 (15f) | **92.7%** | **93.5%** |
| refactor the sqlite persistence layer | 2,461 | 27,184 (16f) | 17,103 (6f) | **90.9%** | **85.6%** |
| trace how an import statement becomes a graph edge | 3,123 | 33,488 (16f) | 115,834 (66f) | **90.7%** | **97.3%** |
| where is the privacy mode enforced before sending prompts | 3,046 | 29,528 (16f) | 62,296 (26f) | **89.7%** | **95.1%** |
| **Total** | **23,392** | **240,363** | **452,948** | **90.3%** | **94.8%** |

## Reproduce

```bash
pnpm run compile
node out/benchmark/tokenBenchmark.js [dir] [--json results.json] [--md BENCHMARKS.md]
```

`dir` defaults to the current directory. The harness indexes headlessly (same engine as the
MCP server), runs the 8 tasks above, and counts tokens with the real `o200k_base` BPE.

## Honest caveats

- Baselines are reproducible strawmen, not "what tool X would send" — every agent selects context differently.
- The compact package trades full bodies for references + signatures + ≤3 snippets; complex edits still require
  the agent to read specific files afterwards (but *targeted* ones, not everything).
- Savings apply to the context-assembly step; multi-turn tool loops add their own costs on both sides.

---

# Retrieval Quality Benchmark — no index vs graph vs graph + embeddings

_Generated 2026-08-13 · harness: `out/benchmark/retrievalBenchmark.js` · tokenizer: o200k_base · budget: 6,000 tokens_

Where the token benchmark above measures **cost**, this one measures **whether the right files
are found at all**, across three retrieval modes on this repo (102 files, 726 symbols,
250 import edges; embedding index: 695 chunks):

- **A · No CodeGraph** — grep-style term-frequency ranking; the agent reads the full text of
  the top 5 matches. (Generous: real unranked grep does worse.)
- **B · CodeGraph** — graph/lexical retrieval (keyword + PageRank + RRF), compact context package.
- **C · CodeGraph + embeddings** — the same retriever with chunk-level embedding similarity
  fused in. Fully local: `jinaai/jina-embeddings-v2-base-code`, quantized ONNX, in-process.

12 queries with hand-labelled ground-truth files: 5 **lexical** (query words appear in the
target) and 7 **conceptual** (deliberately no shared vocabulary — e.g. *"coalesce rapid bursts
of disk change notifications"* → `fileWatcher.ts`).

## Headline

| Metric | A · no CodeGraph | B · CodeGraph | C · CodeGraph + embeddings |
| --- | ---: | ---: | ---: |
| hit@1 | 17% | 33% | **50%** |
| hit@5 | 67% | 42% | **67%** |
| MRR | 0.381 | 0.382 | **0.547** |
| context tokens (12 queries) | 213,332 | 36,720 | 36,969 |
| avg retrieval latency | ~14 ms | ~71 ms | ~152 ms |

**Read it as:** embeddings **1.4× the MRR** and **1.5× the hit@1** of graph-only retrieval at
essentially **zero added token cost** (+0.7%), and match the grep baseline's recall while using
**83% fewer tokens**. Grep's decent hit@5 comes from dumping ~17,800 tokens per query — its
hits are buried in whole-file dumps the model still has to dig through.

## By query kind

| Kind | Metric | A | B | C |
| --- | --- | ---: | ---: | ---: |
| lexical | hit@5 | 80% | 80% | **100%** |
| lexical | MRR | 0.579 | 0.7 | **1.0** |
| conceptual | hit@5 | 57% | **14%** | 43% |
| conceptual | MRR | 0.241 | 0.155 | 0.224 |

Graph-only retrieval **collapses on conceptual queries** (14% hit@5) — when the user's words
don't appear in the code, keyword ranking has nothing to grip. Embeddings recover most of that
gap (43%) while keeping the compact package.

## The raw embedding signal is even stronger

Diagnostic column: rank of the correct file in the **raw embedding results** before fusion.
The embedding alone put a ground-truth file at **#1 on 9 of 12 queries** — including 4 of 7
conceptual ones. The chunk-level hits (exact symbol + line range) are exposed directly via
`codegraph semantic` / MCP `codegraph_semantic_search`:

| Query (conceptual subset) | B rank | C rank | emb only |
| --- | ---: | ---: | ---: |
| coalesce rapid bursts of disk change notifications | 12 | 6 | **1** |
| AI endpoint … on this machine, not somewhere remote | miss | miss | **1** |
| user consent gate before anything leaves the machine | miss | 5 | **1** |
| suggest a cheaper AI model when the job looks simple | 1 | 1 | **1** |
| apply a code edit even when indentation differs | miss | 5 | 3 |

Takeaway: for conceptual questions, agents get the best results from the dedicated
`codegraph_semantic_search` tool (raw chunk hits), while `codegraph_context` / `search` give
the balanced hybrid package. The current RRF fusion is conservative — a known tuning
opportunity, since the pure embedding signal is frequently correct on its own.

## Model comparison

Same harness, both bundled model options:

| Model | Size | Conceptual hit@5 (C) | Lexical MRR (C) | Overall MRR (C) |
| --- | --- | ---: | ---: | ---: |
| `Xenova/all-MiniLM-L6-v2` (fast) | ~25 MB | 29% | 1.0 | 0.536 |
| `jinaai/jina-embeddings-v2-base-code` (default) | ~160 MB | **43%** | 1.0 | **0.547** |

Both are perfect on lexical queries; the code-specific default is markedly better on
conceptual phrasing — worth its one-time download.

## Reproduce

```bash
pnpm run compile
node out/node/cli.js embed <dir>                       # build the embedding index once
node out/benchmark/retrievalBenchmark.js <dir> [--json out.json] [--md out.md]
```

## Honest caveats

- Ground truth is hand-labelled by the repo authors; other judges might accept different files.
- 12 queries on one repo — indicative, not a standardized IR benchmark.
- Mode C latency includes in-process query embedding (model already loaded); index build
  (~1–2 min for this repo) and the one-time model download are excluded.
- The grep baseline is ranked term-frequency — kinder than real unranked grep sessions.
- Token counts are context-assembly cost only; every mode still reads files afterwards for edits.
