# CodeGraph — Algorithms & Token-Savings Methodology

This document explains **every algorithm** in CodeGraph (and where it lives), then **exactly how
the token-savings number is computed** and what it does and does not mean.

CodeGraph is a pipeline:

```
index → build graph → analyze → retrieve & rank → compress (budget) → measure
```

Each stage uses specific, inspectable algorithms — there is no opaque model deciding relevance.

---

## Part A — Algorithms by pipeline stage

### 1. Indexing (source files → structured nodes)

| Algorithm | File | What it does |
|---|---|---|
| TypeScript compiler AST walk | `src/indexer/typescriptAstIndexer.ts` | `ts.createSourceFile` + recursive `visit` extracts classes, functions, methods, React/NestJS constructs, imports, and decorators precisely for `.ts/.tsx/.js/.jsx`. |
| Regex symbol extraction | `src/indexer/genericIndexer.ts` | Per-extension pattern tables (`patternsByExtension`) extract classes/functions/etc. for Python, Go, Rust, Java, C#, PHP, Kotlin, and more. |
| Namespace / package extraction | `src/indexer/moduleDeclarations.ts` | Captures `namespace` (C#/VB), `package` (Java/Kotlin/Scala), PHP `namespace` — normalized to dot form. |
| Import extraction | `src/indexer/multiLangImports.ts` | Regex capture of `import`/`using`/`require`/`#include`/`use` per language. |
| Artifact filtering | `src/utils/fileFilters.ts` | Excludes build/dependency dirs (`node_modules`, `obj`, `bin`, `_framework`, `target`, `.venv`, …) and generated files (`*.g.cs`, `*.min.js`, `dotnet.*.js`, lockfiles). |

### 2. Graph construction (the edges)

| Algorithm | File / function | Details |
|---|---|---|
| Multi-strategy import resolution | `src/graph/graphAlgorithms.ts` → `resolveImports` | For each import, tries in order: **(1)** relative-path candidates (`./x` + ~25 extensions + index files), **(2)** namespace/package match against declaring files, **(3)** path-suffix match (`net/socket.h`, dotted module paths), **(4)** unique base-name fallback. Ambiguous names are intentionally left unlinked. |
| Lookup-index build | `buildFileIndex` | Builds `byPath`, `byModule` (namespace → files), and `byBaseName` maps so resolution is O(1) per candidate. |

### 3. Graph analytics

| Algorithm | Function | Classic name / complexity |
|---|---|---|
| Degree centrality | `computeDegrees` | in/out/total degree per node → "god nodes" (hubs). O(V+E). |
| Community detection | `communityLabels` | **Label propagation** — each node adopts the majority label among neighbors, 8 iterations, then labels are compacted. Near-linear; deterministic tie-break by lowest label. |
| Shortest path | `shortestPath` | **Breadth-first search** over the undirected view of the adjacency. O(V+E). |
| Impact set | `impactSet` | **Reverse BFS** (depth-bounded) over `reverseAdjacency` — "everything that transitively depends on this file" = blast radius. |

### 4. Retrieval & ranking (selects what's relevant — basis of token savings)

The retriever (`src/graph/graphRetriever.ts`) blends **lexical** signals, **graph structure**, and
**workspace context** into a single score per file/symbol.

**Lexical file scoring** — `scoreFile`, additive per query term:

| Match | Weight |
|---|---:|
| File path contains term | +10 |
| Decorator matches term | +8 |
| Symbol in file matches term | +6 |
| Import specifier matches term | +4 |

**Symbol scoring** — `scoreSymbol`: exact name match **+25**, exact token **+18**, partial **+9**,
plus inherits ¼ of its file's score (capped at 8), with decorator/tag/import bonuses.

**Graph-structure boosts** — `applyFileBoosts`:

| Signal | Weight |
|---|---:|
| File imports a file that already matched | +7 |
| File is imported by a file that already matched | +7 |
| Test file when the task is test-related | +45 |

**Contextual boosts** — `src/graph/graphRanker.ts` → `applyContextualFileBoosts`:

| Signal | Weight |
|---|---:|
| Git-diff (changed) file | +30 |
| Active editor file | +25 |
| Open tab | +12 |
| Semantic similarity (opt-in) | `round(similarity × 40)` |

**Expansion & merge:** `expandOneHop` pulls direct graph neighbors of the top hits (so the model
sees collaborators), and `mergeRankedFiles` sums scores for files matched by multiple signals.

### 5. Semantic layer (opt-in, local)

| Algorithm | File | Details |
|---|---|---|
| Cosine similarity top-K | `src/semantic/vectorIndex.ts` | `similarity = dot(q,v) / (‖q‖·‖v‖)`, filtered by `minSimilarity`, sorted, top-K. One vector per file → sub-millisecond even on thousands of files. |
| Graph-aware document | `src/semantic/semanticDoc.ts` | Embeds a **structured summary** (path + namespace + symbol signatures + imports), not raw text — so one small vector captures what a file is *and* how it connects. Content-hashed for incremental re-embedding. |

### 6. Context compression / budgeting (produces the "compact" context)

| Algorithm | File | Details |
|---|---|---|
| Greedy budget fill | `src/context/contextBudgeter.ts` + `src/context/contextCompressor.ts` | A **greedy knapsack**: walk ranked items high→low; `tryUse(text)` admits an item only while `usedTokens + cost ≤ maxTokens`, otherwise stops. What's admitted is mostly references + symbol signatures + ≤3 snippets — not full file bodies. |
| Budget cap | `src/utils/tokenEstimator.ts` → `clampTokenBudget` | `max(1000, min(6000, modelMaxInputTokens × 0.6))`. |

### 7. Decision algorithms

| Algorithm | File | Details |
|---|---|---|
| Complexity scoring | `src/context/complexityScorer.ts` | Weighted heuristic → 0–100 → `light` / `standard` / `heavy` tier (drives model suggestions). |
| Model recommendation | `src/chat/modelRecommender.ts` + `modelRegistry.ts` | Multi-axis fit scoring (capability, cost, speed, reasoning, context window) vs a curated registry; surfaces several role-labelled options. |
| Tolerant edit matching | `src/chat/textReplace.ts` | 3-tier match: exact → line-ending-normalized → per-line whitespace-flexible, preserving the file's original EOL. |

---

## Part B — How the token-savings number is computed

The claim is precise and is **not** "vs GitHub Copilot." It is:

> **How many tokens did CodeGraph's compact, ranked context use, versus a naive RAG that dumps
> the full text of the same relevant files?**

### Step 1 — What CodeGraph actually sends (numerator)

The retriever picks relevant files/symbols; the **budgeter** admits only what fits (~6000 tokens),
and what's admitted is mostly references and signatures, not full bodies:

```
contextPackage = {
  task,
  relevantFiles: [{ path, reason, score }],
  importantSymbols: [...],
  dependencyFlow: [...],
  relatedTests: [...],
  snippets: [≤3]
}
```

Actual sent tokens:
- `promptTokens = model.countTokens(prompt)` — the model's **real tokenizer** count, or
- fallback `Buffer.byteLength(prompt) / 4`.

### Step 2 — The baseline (denominator)

`src/privacy/baselineComputer.ts`:

```
naiveBaselineBytes  = Σ (byte size of every file in relevantFiles) + 600   // "dump them raw"
naiveBaselineTokens = Σ model.countTokens(full text of each relevant file) // tokenizer-accurate
```

i.e. *what a dumb RAG would have spent injecting the entire contents of the files we flagged
relevant.*

### Step 3 — Savings per call

```
saved   = baselineTokens − actualTokens
percent = saved / baselineTokens × 100
```

Shown live in the chat footer; `model.countTokens` makes both sides tokenizer-exact.

### Step 4 — Lifetime aggregation (`/savings`, sidebar headline)

`src/privacy/tokenSavingsAnalyzer.ts` → `summarizeSavings(auditEntries)`:

- Filters to `outcome === 'sent'` calls.
- Per entry: `actualTokensOf = promptTokens ?? bytesToTokens(promptBytes)`;
  `baselineTokensOf = baselineTokens ?? bytesToTokens(naiveBaselineBytes)`.
- `savedTokens = Σbaseline − Σactual`; `savingsPercent = savedTokens / Σbaseline`.
- A `measured` flag is true when real tokenizer counts were used (else the value is a bytes/4 estimate).

Example: `Saved 1,867,864 tokens (94.3%)` = aggregate baseline `1,980,404` − aggregate sent `112,540`
across 21 sent calls.

### Step 5 — End-to-end accounting (whole agent loop)

`src/chat/agentRunner.ts` also tracks true cost, not just first context:

- `inputTokens` += `Σ model.countTokens(message)` over the full message set **each round** (every
  round re-sends the conversation — that's what providers bill for multi-turn tool loops).
- `outputTokens` = `model.countTokens(all generated text)`.
- `/savings` reports **end-to-end input** and **total spend (input + output)** separately from the
  context-savings %.

---

## Why the percentage is legitimately high

- **Numerator** = a ranked *summary* (paths, reasons, symbol signatures, ≤3 snippets), capped at ~6k tokens.
- **Denominator** = the *full byte content* of all relevant files.

Replacing "dump N files" with "send a structured ~400-token slice" genuinely is an 80–95% reduction —
and since v0.2.0 it is **measured with the model's real tokenizer**, not estimated.

## Honest caveats (state these plainly)

1. **Baseline = naive full-file dump of the *same* retrieved files.** A fair, reproducible strawman —
   **not** "what Copilot would have sent" (Copilot does its own context selection). Claim "vs naive RAG."
2. **Context-savings % ≠ total cost reduction.** The headline % compares first-assembled context to the
   baseline. The agent loop then spends more (tool rounds), which is why end-to-end input + output are
   reported separately.
3. **`bytes ÷ 4` is a fallback.** When `model.countTokens` is unavailable, both sides use the byte
   estimate; the `measured` flag indicates which basis produced a given number.
4. **Input-side focus.** Savings are about *input* context. Output tokens are counted for total spend
   but are not part of the "saved" figure.
