# CodeGraph Copilot Chat

A **local-first** code graph for VS Code that gives you a `@codegraph` Copilot Chat participant, an interactive graph view, and a per-call audit trail your team can trust.

Inspired by [graphify](https://github.com/safishamsi/graphify): code stays on the machine; visualizations, path-finding, and reports run locally; only the compact context you choose is ever sent — and only to the Copilot model **you** select.

> **Docs:** [Commands & Usage](COMMANDS.md) · [Publishing to the Marketplace](PUBLISHING.md)

## Why your team can trust this

| Guarantee | How it is enforced |
| --- | --- |
| The extension makes **zero outbound HTTP** of its own | No `fetch`, `http`, `https`, `node-fetch`, or socket dependencies — only bundled local libraries (`sql.js`, `cytoscape`, `graphology`, tree-sitter WASM). |
| Every model call is **logged before it happens** | `AuditLog` writes a JSONL entry (timestamp, model, byte count, SHA-256 of the prompt, files included, outcome) to extension storage. |
| You can **disable model calls entirely** | Set `codegraph.privacyMode` to `local-only`. The chat participant will still build the index and show the local context, but never call `model.sendRequest`. |
| You can **preview every prompt** before it is sent | Set `codegraph.privacyMode` to `preview-before-send`. A modal confirms files + byte count each time. |
| Storage is **workspace-scoped** | SQLite index + JSONL audit log live under the extension `globalStorageUri`. `CodeGraph: Wipe Local Data` clears them in one click. |
| Visualizations are **CSP-locked** | The graph webview uses a strict CSP, loads only nonce-tagged scripts from `media/` and `node_modules/cytoscape/dist/`. |
| Agent actions are **confirmed and audited** | When the agent runs a command or edits a file, you get an inline **Continue / Cancel** prompt (unless you opt into auto-approve), and every execution is written to a local tool audit log (`tool-log.jsonl`). |
| `local-only` mode **disables the whole agent** | With no model call, there are no tool calls — the agent can neither talk nor act until you leave `local-only`. |

The status-bar item shows the current mode, total calls, and bytes sent. Click it to open the Privacy Center.

## Interactivity

| Feature | Entry point |
| --- | --- |
| **Always-fresh graph** — a workspace-wide file watcher, agent write-through re-indexing, and read-time flushing keep the graph current in real time, including edits made by AI agents that never trigger a document save. The sidebar and graph view patch themselves live | automatic (see [ALGORITHMS.md](ALGORITHMS.md) → *Incremental freshness*) |
| **Agentic actions** — `@codegraph` can run terminal commands, read/write/edit files, and query the graph to actually carry out a request (build, test, run the app, refactor). Same loop as Copilot's built-in agent, behind CodeGraph's confirmation + audit layer | `@codegraph run the tests and fix the first failure` |
| **Model-fit routing** — a free local complexity score (with an optional cheap-model tiebreak on borderline cases) detects when a simpler/stronger model fits, then posts **in-chat buttons** in the reply to reroute @codegraph's own answer and remembers your choice | in-chat buttons on mismatch (toggle `codegraph.suggestModel`, `codegraph.modelSwitchPrompt`, `codegraph.suggestModelUsesLLM`) |
| Interactive force-directed graph (Cytoscape) — click a node to open the file, ask `@codegraph` about it, or compute its impact set | `CodeGraph: Open Interactive Graph` or `/viz` in chat |
| Sidebar tree: Privacy state, Actions, God Nodes, Communities, Suggested Questions, Recent Model Calls | Activity bar → CodeGraph icon |
| `GRAPH_REPORT`-style local markdown — god nodes, communities, surprising cross-cluster connections, orphan files, suggested questions | `CodeGraph: Generate Graph Report` or `/report` |
| Privacy Center webview (audit table, mode switcher, raw-log opener, clear-log) | `CodeGraph: Open Privacy Center`, `/privacy`, or click the status-bar item |
| Shortest path between two files | `/path src/a.ts src/b.ts` |
| Reverse-dependency impact set | `/impact src/auth.ts` |
| List the most-connected files | `/godnodes` |
| Show recent model calls inline | `/audit` |
| **Token-savings analysis** — every call records what a naive "dump the relevant files" RAG would have cost, then shows lifetime tokens saved, % savings, avg per call, best/worst case, and est. dollar savings at common model prices | `CodeGraph: Token Savings Analysis`, `/savings` in chat, or the **Token Savings** section of the sidebar |

## Chat

```text
@codegraph explain login flow
@codegraph run the test suite and fix the first failure
@codegraph build the project and tell me what broke
@codegraph fix marketplace popover issue
@codegraph add tests for invite validation
@codegraph review my current changes
@codegraph #runInTerminal npm run build
@codegraph /path src/auth/login.ts src/db/pool.ts
@codegraph /impact src/auth/session.ts
@codegraph /report
@codegraph /viz auth
@codegraph /privacy
```

Slash commands run **entirely locally** — they never call the model.

## MCP server (use the graph from any agent)

The same graph engine runs headlessly as a **Model Context Protocol** server over stdio — no VS Code
required — so Copilot agent mode, Claude, Cursor, or any MCP client can query your code graph:

```jsonc
// e.g. .vscode/mcp.json
{
  "servers": {
    "codegraph": {
      "command": "node",
      "args": ["<path-to-extension>/out/mcp/server.js", "${workspaceFolder}"]
    }
  }
}
```

Tools: `codegraph_context` (ranked context for a task — hybrid with embeddings when an index
exists), `codegraph_semantic_search` (embedding-based conceptual search with line-level hits),
`codegraph_embed` (build/refresh the local embedding index), `codegraph_impact` (blast radius),
`codegraph_path` (dependency path between files), `codegraph_hotspots` (god nodes),
`codegraph_symbol_refs` (who imports a symbol / most-imported symbols), `codegraph_communities`,
`codegraph_stats`. The server watches the workspace and re-indexes changed files on each call,
so agents always see the current structure.

**Local semantic search (CLI + MCP):** `codegraph embed` builds an on-device embedding index —
AST-aware chunks (one per function/class) embedded with a bundled ONNX model
(`@huggingface/transformers`, downloaded once to `~/.codegraph/models`), persisted per repo.
`codegraph semantic "<query>"` returns the conceptually closest code with file:line ranges and
snippets, and `codegraph search` fuses semantic similarity into its ranking automatically. No
external server, nothing leaves your machine.

Per-client setup (Claude Code, Copilot CLI, Codex, Cursor, Ollama) with verified commands is in
[INTEGRATIONS.md](INTEGRATIONS.md). Measured token savings vs naive retrieval (~90%) are in
[BENCHMARKS.md](BENCHMARKS.md).

## Languages

CodeGraph indexes symbols **and resolves imports** for:

- TypeScript / JavaScript (via the TS compiler API)
- Python, Go, Java, C#, Rust, Ruby, PHP, C++, Bash (real AST parsing via **tree-sitter** WASM grammars — the same builds VS Code uses — with nested-symbol and export detection; regex fallback if a grammar fails to load)
- Kotlin, Swift, Scala, Clojure, Lua, C (symbols + imports via tuned regex per language)
- YAML, Terraform/HCL, shell, PowerShell, Markdown (symbol-only)

Files inside `node_modules`, `dist`, `build`, `coverage`, `.git`, `__pycache__`, `.venv`, `venv` are excluded.

## What CodeGraph uses

- **TypeScript compiler API** for `.ts`, `.tsx`, `.js`, `.jsx` symbol + import indexing
- **Tree-sitter** (`web-tree-sitter` + `@vscode/tree-sitter-wasm`) for AST-accurate indexing of 9 more languages, with per-language regex extractors as fallback
- **graphology** + **graphology-communities-louvain** for Louvain community detection and the personalized-PageRank ranking signal
- **SQLite** (via `sql.js`) at the extension `globalStorageUri`, with debounced incremental persistence
- **Cytoscape.js** for the interactive graph (bundled locally; loaded via webview CSP), patched live on index changes
- **Local git diff** for review and impact-analysis prompts
- **Active editor and open tabs** as ranking hints
- The **Copilot language model selected by the user** for the active chat request

## Privacy Boundary

CodeGraph is local-first. Indexing, graph storage, ranking, compression, path-finding, community detection, the report, and the visualization all happen locally.

The extension sends code context only to the Copilot language model selected by you for the active chat request. It makes **no other external API calls** and uses **no cloud service of its own**.

Audit log location: `<globalStorageUri>/audit-log.jsonl`. Each entry contains the SHA-256 of the prompt so you can prove (or disprove) that a specific prompt was sent.

## Configuration

```jsonc
// settings.json
{
  // standard | preview-before-send | local-only
  "codegraph.privacyMode": "standard"
}
```

## Development

```bash
pnpm install
pnpm test
```

Press `F5` in VS Code to launch an Extension Development Host, open Copilot Chat, and invoke `@codegraph`.

See [PUBLISHING.md](PUBLISHING.md) for packaging into a `.vsix` and publishing to the VS Code Marketplace (including the pnpm/`node_modules` gotchas).

## Architecture

```
src/
  chat/            chat participant, prompt builder, slash router, agent tools + tool-calling loop
  commands/        VS Code command registrations
  context/         retrieval → compact context package
  git/             local git diff provider
  graph/           graph store (SQLite), retriever, ranker (RRF), algorithms (Louvain, PPR, BFS, symbol refs)
  indexer/         TS AST indexer, tree-sitter indexer, generic regex indexer, incremental workspace indexer, file watcher
  mcp/             zero-dependency MCP stdio server (headless graph tools for any agent)
  node/            host-agnostic engine + scanner (CLI / MCP, no VS Code)
  privacy/         PrivacyManager, AuditLog, ToolAuditLog, Privacy Center webview, status-bar badge
  report/          markdown report builder (god nodes, hot symbols, communities, surprises)
  semantic/        opt-in local semantic layer (vector index, graph-aware docs)
  viz/             interactive graph webview (Cytoscape, live incremental updates)
  views/           activity-bar tree provider
media/graph/       graph.html / graph.css / graph.js (webview assets)
```
