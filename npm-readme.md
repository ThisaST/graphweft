# graphweft

**A local-first code graph for AI agents.** Index a repository into an import/symbol graph,
then ask it for the *relevant slice* of the codebase instead of dumping whole files into a
model's context window.

Ships three ways: a **CLI**, an **MCP server** (so Claude Code, Copilot CLI, Cursor, or any
MCP client can query your graph), and a **programmatic API**.

Everything runs on your machine. No telemetry, no cloud service, no account. The only
network call the package can make is to a **loopback** embedding server, and a one-time
model download if you opt into semantic search.

```bash
npm install -g graphweft
```

Or run it without installing:

```bash
npx graphweft report .
```

> **Looking for the VS Code extension?** The `@graphweft` Copilot Chat participant, graph
> view, and Privacy Center are a separate install from the VS Code Marketplace. This npm
> package is the headless engine only.

---

## Why

Naive retrieval answers "which files mention this word". A code graph answers "which files
*matter* for this task" — by fusing keyword matches, embedding similarity, and
personalized PageRank over the real import graph.

Measured on this repo's own benchmark suite (8 tasks, full methodology in `BENCHMARKS.md`):

| | Graphweft | Whole-file baseline | Naive RAG |
| --- | ---: | ---: | ---: |
| Total context tokens | **23,392** | 240,363 | 452,948 |
| Savings | — | **90.3%** | **94.8%** |

On a 12-query ground-truth retrieval benchmark, hybrid (graph + embeddings) scores
**MRR 0.547** vs 0.381 for a grep baseline and 0.382 for graph-only — at the same token cost.

---

## CLI

```
graphweft index    [dir]
graphweft search   [dir] <query...>   [--no-semantic] [--model <hf-id>]
graphweft embed    [dir]              [--model <hf-id>] [--wipe]
graphweft semantic [dir] <query...>   [--top <n>] [--model <hf-id>]
graphweft impact   [dir] <file>
graphweft path     [dir] <fileA> <fileB>
graphweft report   [dir]
```

`dir` defaults to the current directory. Output is JSON (or markdown for `report`), so it
pipes cleanly into other tools.

```bash
# What files matter for this task?
graphweft search . "how does session expiry work"

# What breaks if I change this file?
graphweft impact . src/auth/session.ts

# How are these two files connected?
graphweft path . src/api/login.ts src/db/pool.ts

# Architectural overview: hubs, clusters, orphans
graphweft report .
```

`search` is **hybrid by default** — it fuses embedding similarity into the ranking whenever
an index exists. Pass `--no-semantic` to use graph + lexical ranking only.

---

## MCP server

Point any MCP client at the server to give your agent structural knowledge of the codebase.

```jsonc
{
  "mcpServers": {
    "graphweft": {
      "command": "graphweft-mcp",
      "args": ["/absolute/path/to/your/repo"]
    }
  }
}
```

Without a global install, `npx` works too:

```jsonc
{
  "mcpServers": {
    "graphweft": {
      "command": "npx",
      "args": ["-y", "-p", "graphweft", "graphweft-mcp", "/absolute/path/to/your/repo"]
    }
  }
}
```

The path argument defaults to the current working directory if omitted.

**Tools exposed:**

| Tool | What it answers |
| --- | --- |
| `graphweft_context` | Ranked, compressed context package for a task — the main entry point |
| `graphweft_impact` | Blast radius: what transitively imports this file |
| `graphweft_path` | Shortest import path between two files |
| `graphweft_hotspots` | Most-connected files (architectural hubs / god nodes) |
| `graphweft_communities` | Architectural clusters via Louvain community detection |
| `graphweft_symbol_refs` | Which files import a given symbol; most-imported symbols |
| `graphweft_semantic_search` | Conceptual search with file:line hits and snippets |
| `graphweft_embed` | Build/refresh the on-device embedding index |
| `graphweft_stats` | File, symbol, and edge counts |

The server watches the workspace and re-indexes changed files on each call, so agents never
see a stale graph.

Per-client setup for Claude Code, Copilot CLI, Codex, Cursor, and Ollama is in
`INTEGRATIONS.md`.

---

## Programmatic API

```ts
import { GraphweftEngine, buildFileGraph, impactSet } from 'graphweft';

const engine = new GraphweftEngine();
await engine.indexDirectory('./src');

// Ranked context for a task
const result = engine.search('reciprocal rank fusion', 10);
console.log(result.files);

// Blast radius
console.log(engine.impact('src/graph/graphTypes.ts'));

// Hybrid search (fuses embeddings when an index exists)
const hybrid = await engine.searchHybrid('how do we deduplicate requests');

// Or work with the graph directly
const graph = buildFileGraph(engine.getFiles());
console.log(impactSet(graph, 'src/auth/session.ts', 3));
```

Ships with TypeScript declarations. Also exported: `GraphRetriever`, `InMemoryGraphStore`,
`personalizedPageRank`, `shortestPath`, `communityLabels`, `computeDegrees`,
`buildGraphReport`, `buildContextMarkdown`, `startMcpServer`, and the graph types.

---

## Semantic search (optional)

Embeddings are **off until you build an index**:

```bash
graphweft embed .
graphweft semantic . "where do we retry failed uploads"
```

The first `embed` downloads a quantized ONNX model (default
`jinaai/jina-embeddings-v2-base-code`) to `~/.graphweft/models`. It runs in-process — no
server, nothing leaves your machine. Vectors persist per repo under `~/.graphweft/index/`
and re-embed incrementally, so editing one file doesn't re-embed the repo.

Chunking is AST-aware: one chunk per function/class with a situating header, so results
point at precise symbols and line ranges rather than whole files.

| Env var | Purpose |
| --- | --- |
| `GRAPHWEFT_EMBED_RUNTIME` | `auto` (default), `local`, `ollama`, or `off` |
| `GRAPHWEFT_EMBED_MODEL` | Override the embedding model |
| `GRAPHWEFT_MODEL_CACHE` | Where models are downloaded |
| `GRAPHWEFT_CACHE_DIR` | Where the vector index is stored |

`--model` must match the model the index was built with; the index records it and refuses a
mismatch rather than returning wrong results. Set `GRAPHWEFT_EMBED_MODEL` to apply one model
to every command instead of passing `--model` each time.

To use Ollama instead of the bundled runtime, set `GRAPHWEFT_EMBED_RUNTIME=ollama`. Remote
endpoints are rejected by design — the endpoint must be loopback.

> **Install size.** `@huggingface/transformers` pulls in ONNX runtimes, so a full install is
> around 460 MB on disk. The dependency is loaded lazily: if you never run `embed` or
> `semantic`, it is never imported.

---

## Languages

Imports **and** symbols are resolved for:

- **TypeScript / JavaScript** — via the TypeScript compiler API
- **Python, Go, Java, C#, Rust, Ruby, PHP, C++, Bash** — real AST parsing via tree-sitter
  WASM grammars, with nested-symbol and export detection
- **Kotlin, Swift, Scala, Clojure, Lua, C** — symbols + imports via tuned per-language regex
- **YAML, Terraform/HCL, PowerShell, Markdown** — symbols only

`node_modules`, `dist`, `build`, `coverage`, `.git`, `__pycache__`, `.venv`, and `venv` are
excluded automatically.

---

## How ranking works

Three scale-incompatible signals are fused with **Reciprocal Rank Fusion** (k=60), which
operates on ranks rather than raw scores, so a 0–1 cosine similarity, an unbounded keyword
score, and a probability-mass centrality combine without hand-tuned weights:

1. **Lexical** — path, symbol, decorator, and import matches
2. **Semantic** — embedding cosine similarity (when an index exists)
3. **Structural** — personalized PageRank over the import graph, seeded from query matches,
   so centrality is measured *relative to this task* rather than global popularity

Results then expand one hop along the import graph to pull in immediate collaborators.
Full details in `ALGORITHMS.md`.

---

## Requirements

Node.js **18+**. No native compilation — tree-sitter grammars ship as WASM.

## License

MIT
