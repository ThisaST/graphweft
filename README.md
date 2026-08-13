# Graphweft Copilot Chat

A **local-first** code graph for VS Code that gives you a `@graphweft` Copilot Chat participant, an interactive graph view, and a per-call audit trail your team can trust.

Inspired by [graphify](https://github.com/safishamsi/graphify): code stays on the machine; visualizations, path-finding, and reports run locally; only the compact context you choose is ever sent — and only to the Copilot model **you** select.

> **Docs:** [Commands & Usage](COMMANDS.md) · [Publishing to the Marketplace](PUBLISHING.md)

## Why your team can trust this

| Guarantee | How it is enforced |
| --- | --- |
| The extension makes **zero outbound HTTP** of its own | No `fetch`, `http`, `https`, `node-fetch`, or socket dependencies — only bundled local libraries (`sql.js`, `cytoscape`, `graphology`, tree-sitter WASM). |
| Every model call is **logged before it happens** | `AuditLog` writes a JSONL entry (timestamp, model, byte count, SHA-256 of the prompt, files included, outcome) to extension storage. |
| You can **disable model calls entirely** | Set `graphweft.privacyMode` to `local-only`. The chat participant will still build the index and show the local context, but never call `model.sendRequest`. |
| You can **preview every prompt** before it is sent | Set `graphweft.privacyMode` to `preview-before-send`. A modal confirms files + byte count each time. |
| Storage is **workspace-scoped** | SQLite index + JSONL audit log live under the extension `globalStorageUri`. `Graphweft: Wipe Local Data` clears them in one click. |
| Visualizations are **CSP-locked** | The graph webview uses a strict CSP, loads only nonce-tagged scripts from `media/` and `node_modules/cytoscape/dist/`. |
| Agent actions are **confirmed and audited** | When the agent runs a command or edits a file, you get an inline **Continue / Cancel** prompt (unless you opt into auto-approve), and every execution is written to a local tool audit log (`tool-log.jsonl`). |
| `local-only` mode **disables the whole agent** | With no model call, there are no tool calls — the agent can neither talk nor act until you leave `local-only`. |

The status-bar item shows the current mode, total calls, and bytes sent. Click it to open the Privacy Center.

## Interactivity

| Feature | Entry point |
| --- | --- |
| **Always-fresh graph** — a workspace-wide file watcher, agent write-through re-indexing, and read-time flushing keep the graph current in real time, including edits made by AI agents that never trigger a document save. The sidebar and graph view patch themselves live | automatic (see [ALGORITHMS.md](ALGORITHMS.md) → *Incremental freshness*) |
| **Agentic actions** — `@graphweft` can run terminal commands, read/write/edit files, and query the graph to actually carry out a request (build, test, run the app, refactor). Same loop as Copilot's built-in agent, behind Graphweft's confirmation + audit layer | `@graphweft run the tests and fix the first failure` |
| **Model-fit routing** — a free local complexity score (with an optional cheap-model tiebreak on borderline cases) detects when a simpler/stronger model fits, then posts **in-chat buttons** in the reply to reroute @graphweft's own answer and remembers your choice | in-chat buttons on mismatch (toggle `graphweft.suggestModel`, `graphweft.modelSwitchPrompt`, `graphweft.suggestModelUsesLLM`) |
| Interactive force-directed graph (Cytoscape) — click a node to open the file, ask `@graphweft` about it, or compute its impact set | `Graphweft: Open Interactive Graph` or `/viz` in chat |
| Sidebar tree: Privacy state, Actions, God Nodes, Communities, Suggested Questions, Recent Model Calls | Activity bar → Graphweft icon |
| `GRAPH_REPORT`-style local markdown — god nodes, communities, surprising cross-cluster connections, orphan files, suggested questions | `Graphweft: Generate Graph Report` or `/report` |
| Privacy Center webview (audit table, mode switcher, raw-log opener, clear-log) | `Graphweft: Open Privacy Center`, `/privacy`, or click the status-bar item |
| Shortest path between two files | `/path src/a.ts src/b.ts` |
| Reverse-dependency impact set | `/impact src/auth.ts` |
| List the most-connected files | `/godnodes` |
| Show recent model calls inline | `/audit` |
| **Token-savings analysis** — every call records what a naive "dump the relevant files" RAG would have cost, then shows lifetime tokens saved, % savings, avg per call, best/worst case, and est. dollar savings at common model prices | `Graphweft: Token Savings Analysis`, `/savings` in chat, or the **Token Savings** section of the sidebar |

## Chat

```text
@graphweft explain login flow
@graphweft run the test suite and fix the first failure
@graphweft build the project and tell me what broke
@graphweft fix marketplace popover issue
@graphweft add tests for invite validation
@graphweft review my current changes
@graphweft #runInTerminal npm run build
@graphweft /path src/auth/login.ts src/db/pool.ts
@graphweft /impact src/auth/session.ts
@graphweft /report
@graphweft /viz auth
@graphweft /privacy
```

Slash commands run **entirely locally** — they never call the model.

## MCP server (use the graph from any agent)

The same graph engine runs headlessly as a **Model Context Protocol** server over stdio — no VS Code
required — so Copilot agent mode, Claude, Cursor, or any MCP client can query your code graph:

```jsonc
// e.g. .vscode/mcp.json
{
  "servers": {
    "graphweft": {
      "command": "node",
      "args": ["<path-to-extension>/out/mcp/server.js", "${workspaceFolder}"]
    }
  }
}
```

Tools: `graphweft_context` (ranked context for a task), `graphweft_impact` (blast radius),
`graphweft_path` (dependency path between files), `graphweft_hotspots` (god nodes),
`graphweft_symbol_refs` (who imports a symbol / most-imported symbols), `graphweft_communities`,
`graphweft_stats`. The server watches the workspace and re-indexes changed files on each call,
so agents always see the current structure.

Per-client setup (Claude Code, Copilot CLI, Codex, Cursor, Ollama) with verified commands is in
[INTEGRATIONS.md](INTEGRATIONS.md). Measured token savings vs naive retrieval (~90%) are in
[BENCHMARKS.md](BENCHMARKS.md).

## Languages

Graphweft indexes symbols **and resolves imports** for:

- TypeScript / JavaScript (via the TS compiler API)
- Python, Go, Java, C#, Rust, Ruby, PHP, C++, Bash (real AST parsing via **tree-sitter** WASM grammars — the same builds VS Code uses — with nested-symbol and export detection; regex fallback if a grammar fails to load)
- Kotlin, Swift, Scala, Clojure, Lua, C (symbols + imports via tuned regex per language)
- YAML, Terraform/HCL, shell, PowerShell, Markdown (symbol-only)

Files inside `node_modules`, `dist`, `build`, `coverage`, `.git`, `__pycache__`, `.venv`, `venv` are excluded.

## What Graphweft uses

- **TypeScript compiler API** for `.ts`, `.tsx`, `.js`, `.jsx` symbol + import indexing
- **Tree-sitter** (`web-tree-sitter` + `@vscode/tree-sitter-wasm`) for AST-accurate indexing of 9 more languages, with per-language regex extractors as fallback
- **graphology** + **graphology-communities-louvain** for Louvain community detection and the personalized-PageRank ranking signal
- **SQLite** (via `sql.js`) at the extension `globalStorageUri`, with debounced incremental persistence
- **Cytoscape.js** for the interactive graph (bundled locally; loaded via webview CSP), patched live on index changes
- **Local git diff** for review and impact-analysis prompts
- **Active editor and open tabs** as ranking hints
- The **Copilot language model selected by the user** for the active chat request

## Privacy Boundary

Graphweft is local-first. Indexing, graph storage, ranking, compression, path-finding, community detection, the report, and the visualization all happen locally.

The extension sends code context only to the Copilot language model selected by you for the active chat request. It makes **no other external API calls** and uses **no cloud service of its own**.

Audit log location: `<globalStorageUri>/audit-log.jsonl`. Each entry contains the SHA-256 of the prompt so you can prove (or disprove) that a specific prompt was sent.

## Configuration

```jsonc
// settings.json
{
  // standard | preview-before-send | local-only
  "graphweft.privacyMode": "standard"
}
```

## Development

```bash
pnpm install
pnpm test
```

Press `F5` in VS Code to launch an Extension Development Host, open Copilot Chat, and invoke `@graphweft`.

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
