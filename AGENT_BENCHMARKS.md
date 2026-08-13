# Agent-in-the-Loop Benchmarks

Real coding agents (Claude Code CLI, GitHub Copilot CLI) answering questions about this
repository, with and without CodeGraph's MCP server — measuring the *marginal, end-to-end*
value of the graph tools and the local embedding index for actual agent workflows, not
synthetic retrieval ranks. Complements the retrieval-level benchmark in
[BENCHMARKS.md](BENCHMARKS.md).

## Methodology

**Matrix: 2 agents × 3 arms × 8 tasks = 48 runs** (sequential, one repetition per cell).

### Agents

| Agent | Version | Invocation | Telemetry source |
|---|---|---|---|
| Claude Code | 2.1.229 | `claude -p … --output-format stream-json --model claude-haiku-4-5 --max-turns 15` | JSON events: turns, tokens, cost USD, per-tool-call names |
| GitHub Copilot CLI | 1.0.79 | `copilot -p … --allow-all-tools` | stderr footer: AI credits, token counts, duration |

Model is fixed per agent across all arms; all comparisons are **within-agent** (never
Claude-vs-Copilot — different models, different pricing units).

### Arms

| Arm | MCP config | Semantic index |
|---|---|---|
| A — baseline | No codegraph MCP server | — |
| B — graph-only | codegraph MCP, `CODEGRAPH_CACHE_DIR` → empty dir, `CODEGRAPH_EMBED_RUNTIME=off` | none |
| C — hybrid | codegraph MCP, default cache with prebuilt `jinaai/jina-embeddings-v2-base-code` index (695 chunks) | graph + embeddings |

Controls:

- Agents keep **all native tools** (grep, file read, shell) in every arm. This answers the
  honest question — "does adding codegraph help a real agent?" — rather than a rigged
  comparison with native tools disabled.
- Claude uses `--strict-mcp-config` with a per-arm config file (arm A = empty server list),
  so user-level MCP servers can never leak in. Copilot's `--additional-mcp-config @file`
  augments the user config, which contains no codegraph server (it does contain unrelated
  servers — figma, playwright — irrelevant to code Q&A; noted as a minor asymmetry).
- Task prompt text is byte-identical across agents and arms.
- Both codegraph arms build the graph index at server spawn (in-memory); only the persistent
  semantic store differs between B and C.

### Tasks

8 questions with hand-verified ground truth (exact file + exact fact), phrased to avoid
quoting identifier names where possible:

| # | Id | Kind | Expected file | Expected facts |
|---|---|---|---|---|
| 1 | watch-debounce | conceptual | `src/indexer/fileWatcher.ts` | 300 (ms) |
| 2 | token-budget-clamp | conceptual | `src/utils/tokenEstimator.ts` | 0.6 / 60% |
| 3 | rrf-k | lexical | `src/graph/graphRanker.ts` | 60 |
| 4 | chunk-char-cap | conceptual | `src/semantic/codeChunker.ts` | 1500 |
| 5 | replace-fallbacks | conceptual | `src/chat/textReplace.ts` | normalized-eol, flexible-whitespace |
| 6 | privacy-modes | lexical | `src/privacy/privacyManager.ts` | local-only, preview-before-send, standard |
| 7 | vector-prune | conceptual | `src/semantic/sqliteVectorStore.ts` | prune |
| 8 | chunks-per-file-cap | lexical | `src/semantic/codeChunker.ts` | 200 |

**Scoring** (automated, in `src/benchmark/agentBenchmark.ts`): `fileHit` = expected path
appears in the answer (case/separator-insensitive); `factHit` = every expected fact regex
matches; **correct = fileHit ∧ factHit**.

### Reproduce

```bash
node out/node/cli.js embed .          # build the arm-C embedding index once
node out/benchmark/agentBenchmark.js  # full matrix; --agent/--arm/--task to subset
node out/benchmark/agentBenchmark.js --arm C --nudge   # supplementary guided run
```

Raw per-run JSONL and full per-run tables are written next to the `--out` path.

## Results

### Main matrix (organic tool choice)

| Agent | Arm | Correct | Avg wall s | Avg turns | Avg tokens | Avg cost/run | CG tool calls |
|---|---|---|---|---|---|---|---|
| claude | A baseline | 7/8 | 35.1 | 3.6 | 93.4k | $0.057 | — |
| claude | B graph-only | 7/8 | 32.7 | 5.6 | 160.3k | $0.053 | 0 |
| claude | C hybrid | 6/8 | 19.3 | 5.5 | 134.4k | $0.028 | 0 |
| copilot | A baseline | 7/8 | 49.1 | — | 165.5k | 11.6 cr | n/a |
| copilot | B graph-only | 8/8 | 35.9 | — | 149.7k | 12.5 cr | n/a |
| copilot | C hybrid | 8/8 | 36.3 | — | 186.9k | 11.7 cr | n/a |

By task kind (correct):

| Agent | Arm | Lexical (3) | Conceptual (5) |
|---|---|---|---|
| claude | baseline | 3/3 | 4/5 |
| claude | graph-only | 3/3 | 4/5 |
| claude | hybrid | 3/3 | 3/5 |
| copilot | baseline | 3/3 | 4/5 |
| copilot | graph-only | 3/3 | **5/5** |
| copilot | hybrid | 3/3 | **5/5** |

### Supplementary run: arm C with a one-line tool nudge

The organic matrix exposed an adoption gap: **Claude never called a codegraph tool
unprompted** (0 calls across all 24 runs) — with `--allow-all-tools`-style freedom it
defaults to its own grep/read loop. A supplementary arm-C run appended one sentence to the
prompt ("Use the codegraph MCP tools … to locate the code before reading files"):

| Agent | Run | Correct | Avg wall s | Total cost | CG calls |
|---|---|---|---|---|---|
| claude | C organic | 6/8 | 19.3 | $0.227 | 0 |
| claude | **C nudged** | 6/8 | 22.8 | $0.318 | **11** |
| copilot | C organic | 8/8 | 36.3 | 93.8 cr | unknown |
| copilot | **C nudged** | 7/8 | 31.7 | **80.7 cr** | unknown |

Per-task highlights from the nudged run (Claude): `vector-prune` — the one task **no agent
solved without codegraph** (0/3 organic Claude arms, 0/1 baseline Copilot) — was solved
correctly with 1 semantic-search call. Conversely, two easy tasks regressed because Claude
accepted a plausible-looking semantic hit without verifying (`token-budget-clamp`,
`chunks-per-file-cap`), answering from the wrong-but-similar chunk.

## Analysis

**1. The hardest conceptual task is where codegraph pays.** `vector-prune` ("where are
embeddings for deleted files cleaned out?") has no greppable keyword (the code says
`prune`, the question says "cleaned out"). Baseline: both agents failed it — Claude burned
71 s/$0.107 and 27 tool calls before giving a wrong answer. With codegraph MCP attached,
Copilot solved it in both arms (31–33 s), and Claude solved it only when it actually used
the tools (nudged run: 1 semantic call, 38 s). This mirrors the synthetic benchmark, where
conceptual hit@5 went 14% → 43% with embeddings.

**2. Easy tasks are already saturated.** On a ~200-file repo, 7 of 8 tasks are solvable by
a competent grep loop — accuracy headroom is tiny, and the marginal value shows up in
efficiency, not correctness. Expect the accuracy gap to widen with repo size (grep gets
noisier; the graph+vector index does not).

**3. Efficiency signal favors codegraph, with a caveat.** Copilot: codegraph arms cut wall
time 27% (49.1 → ~36 s avg) at equal-or-better accuracy, and the nudged run was also the
cheapest (80.7 vs 92.7 credits baseline). Claude: arm C halved wall time and cost vs
baseline ($0.028 vs $0.057/run) — but since it made 0 codegraph calls there, some of that
is likely prompt-cache warmth from arm ordering (A→B→C sequential), so we do not claim it.

**4. Tool adoption is the real bottleneck — and the actionable finding.** Attaching the
MCP server did not make Claude use it; one sentence of prompt guidance did (0 → 11 calls).
Copilot appears to adopt MCP tools organically (its arm-B/C behavior changed measurably).
Practical implication: ship usage guidance in the tool descriptions and/or recommend a
CLAUDE.md / copilot-instructions line like *"prefer codegraph_semantic_search for
'where/how does X work' questions"* — that is where the retrieval quality shown in
BENCHMARKS.md actually converts into agent outcomes.

**5. Semantic hits need verification affordances.** Both nudged regressions came from
trusting a wrong-but-plausible chunk. The `codegraph_semantic_search` output already
includes line-ranged snippets; tool descriptions should tell agents to confirm values in
the cited file before answering (cheap: one targeted read).

### Token economics: counts up, cost down

| Agent | Arm | Avg input tok | Avg output tok | Avg cost/run |
|---|---|---|---|---|
| claude | A baseline | 92.7k | 701 | $0.057 |
| claude | B graph-only | 159.3k | 1,002 | $0.053 |
| claude | C hybrid | 133.3k | 1,020 | **$0.028** |

Attaching 9 MCP tools adds tool schemas to every turn's context, so *raw* input-token
counts rise — but nearly all of that is prompt-cache reads (~10× cheaper than fresh
tokens), so cost falls. This differs from the payload-level measurement in BENCHMARKS.md
(hybrid retrieval −83% tokens vs grep dumps): the agent loop adds fixed schema overhead
per turn, while the payoff arrives as fewer flailing turns on hard tasks (baseline
`vector-prune`: 27 tool calls, $0.107, wrong; nudged arm C: 10 turns, $0.059, correct).
At agent level, the savings unit is **cost and turns, not raw token counts** — and it
compounds with repo size, since grep loops grow with the codebase while retrieval
payloads stay bounded. (Claude's arm-order cache warming inflates part of the arm-C
saving; Copilot's footer exposes only an aggregate ↑ count, so credits are its
trustworthy unit.)

### Relation to the synthetic benchmark (BENCHMARKS.md)

| | Synthetic retrieval | Agent-in-the-loop |
|---|---|---|
| Conceptual queries | hybrid hit@5 43% vs 14% graph-only | hardest conceptual task solved *only* with codegraph |
| Lexical queries | all modes ~equal | all arms 3/3 — saturated |
| Cost | hybrid ≈ graph tokens, 83% less than grep dumps | Copilot −27% wall; Claude −44% cost when nudged vs baseline hard-task spend |

## Caveats

- **n = 1 per cell.** Agent runs are nondeterministic; single-repetition results are
  directional. Per-kind aggregates (16 runs per arm across both agents) partially mitigate.
- **Arm ordering confound**: arms ran sequentially (A→B→C) per agent; Claude's prompt cache
  warms across runs, deflating later-arm costs. Within-arm comparisons (nudged vs organic C)
  are cleaner.
- Single repository (~200 files, TypeScript) — small enough that native grep is a strong
  baseline; expect larger deltas on bigger codebases.
- Agents can answer from native grep in every arm; several tasks are grep-able by design
  (lexical group) to measure exactly that boundary.
- Copilot exposes credits + token counts but not turn/tool-call detail; codegraph tool-call
  counts are only available for Claude. Copilot's user-level MCP config also loads unrelated
  servers (figma/playwright) in all arms — a constant, not a differential.
- Cost figures use each vendor's native unit (USD for Claude, AI credits for Copilot) and are
  not comparable across agents.
