# CodeGraph Copilot Chat

A **local-first** code graph for VS Code that gives you a `@codegraph` Copilot Chat participant, an interactive graph view, and a per-call audit trail your team can trust.

Inspired by [graphify](https://github.com/safishamsi/graphify): code stays on the machine; visualizations, path-finding, and reports run locally; only the compact context you choose is ever sent — and only to the Copilot model **you** select.

> **Docs:** [Commands & Usage](COMMANDS.md) · [Publishing to the Marketplace](PUBLISHING.md)

## Why your team can trust this

| Guarantee | How it is enforced |
| --- | --- |
| The extension makes **zero outbound HTTP** of its own | No `fetch`, `http`, `https`, `node-fetch`, or socket dependencies — only `sql.js` and `cytoscape`, both bundled. |
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

## Languages

CodeGraph indexes symbols **and resolves imports** for:

- TypeScript / JavaScript (via the TS compiler API)
- Python, Go, Rust, Java, Kotlin, C#, C, C++, Swift, Scala, Clojure, Lua, Ruby, PHP (symbols + imports via tuned regex per language)
- YAML, Terraform/HCL, shell, PowerShell, Markdown (symbol-only)

Files inside `node_modules`, `dist`, `build`, `coverage`, `.git`, `__pycache__`, `.venv`, `venv` are excluded.

## What CodeGraph uses

- **TypeScript compiler API** for `.ts`, `.tsx`, `.js`, `.jsx` symbol + import indexing
- **Per-language regex extractors** for everything else
- **SQLite** (via `sql.js`) at the extension `globalStorageUri`
- **Cytoscape.js** for the interactive graph (bundled locally; loaded via webview CSP)
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
  graph/           graph store (SQLite), retriever, ranker, algorithms (BFS, communities, degrees)
  indexer/         TS AST indexer, generic regex indexer, multi-language imports, file watcher
  privacy/         PrivacyManager, AuditLog, ToolAuditLog, Privacy Center webview, status-bar badge
  report/          markdown report builder (god nodes, communities, surprises)
  viz/             interactive graph webview (Cytoscape)
  views/           activity-bar tree provider
media/graph/       graph.html / graph.css / graph.js (webview assets)
```
