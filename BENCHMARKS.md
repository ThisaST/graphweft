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
