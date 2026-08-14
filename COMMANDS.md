# Graphweft — Commands & Usage Reference

Graphweft is **local-first**. Everything except the final model answer runs on your machine, and every model call is logged. There are three ways to drive it:

1. **`@graphweft` chat** in Copilot Chat (natural language + slash commands)
2. **Command Palette** (`Ctrl/Cmd+Shift+P` → type "Graphweft")
3. The **Graphweft sidebar** (activity-bar icon)

---

## 1. Chat: `@graphweft`

Open Copilot Chat, type `@graphweft`, then either ask a question or pick a `/command`.

### Natural-language questions (these DO call the model)

These build a compact local context package and send it to the Copilot model you have selected:

```text
@graphweft explain the login flow
@graphweft fix the marketplace popover that doesn't close on outside click
@graphweft add tests for invite validation
@graphweft review my current changes
@graphweft what files are impacted by my staged changes?
@graphweft where is the rate limiter configured?
```

Each answer ends with a **Context used** block, a **confidence level**, and a **token-savings footer** showing how much smaller the prompt was than a naive file dump.

### Agent actions (the model can now *do*, not just describe)

`@graphweft` is a full agent: when a request implies an action, the model calls a **tool** and Graphweft carries it out — the same agentic loop the built-in Copilot agent uses, but routed through Graphweft's confirmation + audit layer.

```text
@graphweft run the test suite and fix the first failure
@graphweft build the project and tell me what broke
@graphweft add a --verbose flag to the CLI and update the README
@graphweft what's the blast radius of changing src/auth/session.ts? then refactor it safely
```

| Tool | What it does | Confirmation? |
| --- | --- | --- |
| `runInTerminal` | Runs a shell command in a **visible "Graphweft Agent" integrated terminal** (so you see it execute, just like the built-in agent) and reads back its output + exit code. | **Yes** (unless `graphweft.autoApproveCommands`) |
| `writeFile` | Creates or overwrites a file. | **Yes** (unless `graphweft.autoApproveEdits`) |
| `replaceInFile` | Applies a targeted find/replace edit. | **Yes** (unless `graphweft.autoApproveEdits`) |
| `readFile` / `listDirectory` / `findFiles` | Inspect files and folders. | No (read-only) |
| `impact` / `dependencyPath` / `godNodes` | Query the local code graph (blast radius, import paths, hub files). | No (local) |

- Every command and edit shows an inline **Continue / Cancel** prompt before it runs.
- Every tool execution is written to a local **tool audit log** (`tool-log.jsonl`) next to the model-call audit log.
- You can `#`-reference any tool directly, e.g. `@graphweft #runInTerminal npm run build`.
- Turn the whole agent capability off with `graphweft.enableAgentTools: false` (makes `@graphweft` a read-only responder again).

### Slash commands (these DO NOT call the model — 100% local)

Type the `/` and VS Code shows them as chips. Extra text after the command is ignored by local commands, so `@graphweft /savings how much did I save` works fine.

| Command | What it does | Example |
| --- | --- | --- |
| `/path <a> <b>` | Shortest **import path** between two files (BFS over the dependency graph). Partial names are matched, so you don't need full paths. | `@graphweft /path login db/pool` |
| `/impact <file>` | Reverse-dependency **impact set**: every file that transitively imports the given file (depth 4). | `@graphweft /impact src/auth/session.ts` |
| `/godnodes` | The most-connected files (degree centrality) — your architectural hubs. | `@graphweft /godnodes` |
| `/report` | Full local **graph report**: god nodes, communities, surprising cross-cluster imports, orphan files, suggested questions. | `@graphweft /report` |
| `/savings` | **Token-savings analysis** across all model calls: tokens saved, % saved, avg per call, best/worst case, est. dollar savings. | `@graphweft /savings` |
| `/viz [query]` | Open the **interactive graph** panel. Optional query filters to matching files. | `@graphweft /viz auth` |
| `/privacy` | Open the **Privacy Center** (mode switch + audit table). | `@graphweft /privacy` |
| `/audit` | Inline table of the **last 10 model calls** (time, task, bytes, files). | `@graphweft /audit` |
| `/wipe` | Wipe the local index and/or audit log (asks for confirmation). | `@graphweft /wipe` |
| `/help` | List every command. | `@graphweft /help` |

> **Why slash commands never hit the model:** they are answered directly from the local SQLite graph, so they are instant, free, and leak nothing.

---

## 2. Command Palette

`Ctrl/Cmd+Shift+P`, then:

| Command | Description |
| --- | --- |
| **Graphweft: Build Local Index** | (Re)scan the workspace and rebuild the graph. Runs automatically on first chat use; after that the index stays fresh incrementally (file watcher + agent write-through), so manual rebuilds are rarely needed. |
| **Graphweft: Open Interactive Graph** | Cytoscape graph view — search, filter, switch layouts, click a node to open it / ask about it / show its impact set. |
| **Graphweft: Generate Graph Report** | Open the graph report as a Markdown document. |
| **Graphweft: Token Savings Analysis** | Open the full token-savings report as a Markdown document. |
| **Graphweft: Open Privacy Center** | Webview dashboard: privacy mode, audit log table, token-savings panel, raw-log opener, clear-log. |
| **Graphweft: Wipe Local Data** | Delete the local SQLite index and/or the JSONL audit log. Source files are never touched. |

---

## 3. Sidebar (activity bar → Graphweft icon)

A tree with six sections:

- **Privacy** — current mode, bytes sent this session, lifetime audit entry count.
- **Token Savings** — saved tokens + %, sent vs. baseline, avg per call, and "Open full analysis…".
- **Actions** — one-click buttons for graph, report, savings, rebuild, privacy, wipe.
- **God Nodes** — top hub files; click to open.
- **Communities** — auto-detected clusters (Louvain modularity); expand to see members.
- **Suggested Questions** — click to drop a ready-made question into `@graphweft`.
- **Recent Model Calls** — last 8 audited calls; click to open the Privacy Center.

The graph view and Privacy Center also have title-bar buttons (refresh, open graph).

---

## Privacy modes

Set `graphweft.privacyMode` in settings (or switch it live in the Privacy Center):

| Mode | Behavior |
| --- | --- |
| `standard` (default) | Sends the compact context to the selected model and logs every send. |
| `preview-before-send` | Shows a modal with the byte count + file list and waits for your confirmation **before every call**. |
| `local-only` | **Blocks all model calls.** `@graphweft` still indexes and shows you the exact local context it *would* have sent. Slash commands, graph, report, and savings all keep working. |

---

## Agent settings

| Setting | Default | Behavior |
| --- | --- | --- |
| `graphweft.enableAgentTools` | `true` | Let `@graphweft` use tools (run commands, edit files, query the graph). Set to `false` for a read-only responder. |
| `graphweft.includeExternalTools` | `true` | Also expose tools registered by other extensions (e.g. Copilot's built-ins), so `@graphweft` isn't capability-limited vs. the built-in agent. |
| `graphweft.maxTools` | `128` | Cap on tools sent to the model per request (models reject >128). Graphweft's own tools are always kept first. Lower it if your model has a smaller limit. |
| `graphweft.autoApproveCommands` | `false` | Run terminal commands without the inline confirmation prompt. Enable only in workspaces you trust. |
| `graphweft.autoApproveEdits` | `false` | Apply file create/overwrite/edit without the inline confirmation prompt. |
| `graphweft.suggestModel` | `true` | Master switch for **model-fit suggestions** — suggest a cheaper model on simple queries (to save tokens) or a stronger one on hard queries. Turn off to disable the whole feature. |
| `graphweft.modelSwitchPrompt` | `true` | When a better-fit model is found, render **in-chat switch buttons** inside the reply. Clicking one **reroutes @graphweft's own answer** to that model (re-runs the query on the next turn; your global picker is never touched) and remembers the preference. Off → a non-interactive advisory banner instead. |
| `graphweft.suggestModelUsesLLM` | `true` | On genuinely borderline queries, spend one tiny call to the **cheapest** available model (query text only — never your code context) to grade difficulty more accurately. Cached, and skipped entirely in `local-only` mode. Off → local heuristic only. |

### Model-fit suggestions (token saving)

Before each answer, Graphweft decides the difficulty **tier** of your query — `light`, `standard`, or `heavy` — and checks whether the model you have selected is a good fit. It uses a cost- and privacy-aware pipeline:

1. **Free local heuristic first.** Scores the query from the task type, the wording ("where is…" vs. "refactor… across the app"), and the size of the context it assembled (file/symbol counts, blast radius) — operational commands like "run the app" are treated as light even when they touch many files. No model call, nothing sent.
2. **Cheap-model tiebreak only when unsure.** If the score is genuinely borderline, Graphweft spends **one tiny call to the cheapest available model** (the query text only — your code context is never sent) to grade it. The result is **cached**, so the same question is free next time, and the call is **never made in `local-only` mode**.
3. **Suggest against your actual models.** It only ever names models really available in your window.

When the tier doesn't match your selected model, Graphweft posts the choice as **buttons right inside the chat reply** (not a pop-up at the top of the window), so the decision stays where you're reading:

```text
> 💡 This looks like a light task. A cheaper model may be a better fit.
>    Pick one to answer with (your global model picker stays unchanged):

  [ ⚡ Use GPT-4o-mini (cheaper) ]   [ ✓ Keep Claude Sonnet 4 ]
```

Because the VS Code chat API can't pause a reply for input mid-stream, clicking a button **re-runs the query through @graphweft with the chosen model** — so the answer is produced on that next turn, not the current one. The click **reroutes @graphweft's own reply** to your choice (VS Code doesn't let an extension change your global model picker, so nothing else is affected) and **remembers your choice** per tier in local storage (`model-prefs.json`) so future prompts default to it. Set `graphweft.modelSwitchPrompt: false` for a non-interactive advisory banner instead, or `graphweft.suggestModel: false` to turn the feature off entirely.

When the borderline-query tiebreak spends a cheap model call (step 2 above), Graphweft also prints a one-line note in the reply — e.g. `🔎 Graded this query as light via one lightweight call to GPT-4o-mini` — so the extra call is never hidden from you.

> Even with auto-approve on, **`local-only` privacy mode still blocks the model entirely** — no model means no tool calls. Auto-approve only removes the per-action confirmation; it never bypasses the privacy boundary.

---

## The interactive graph — interactions

- **Search box** — type to highlight matching files and fade the rest.
- **"only connected"** — hide orphan files (default on).
- **Layout** — force (cose), concentric, breadth-first, grid.
- **Click a node** — popover with: **Open file**, **Ask @graphweft about this**, **Show impact set**.
- **Colors** — each color is an auto-detected community/cluster; gold-bordered nodes are god nodes.

---

## What gets indexed

- **TypeScript / JavaScript** (`.ts .tsx .js .jsx`) — symbols + imports via the TS compiler API.
- **Python, Go, Java, C#, Rust, Ruby, PHP, C++, Bash** — real AST parsing via tree-sitter WASM grammars (nested symbols, line ranges, export detection), with regex fallback.
- **Many more languages** — symbols + imports via tuned per-language extractors: Kotlin, C, Swift, Scala, Clojure, Lua, Terraform/HCL, YAML, shell, PowerShell, Markdown, and more.
- Excluded: `node_modules`, `dist`, `build`, `coverage`, `.git`, `__pycache__`, `.venv`, `venv`.

The index stays fresh in **real time**: a workspace-wide watcher (debounced ~300 ms) catches every
file event — including writes by AI agents that never trigger a save — the chat agent's own file
tools re-index what they touched immediately, and every chat turn / graph command flushes pending
changes before reading. Unchanged content is skipped via content hashing.

---

## MCP server (headless)

Run the graph engine as an MCP stdio server for any MCP-capable agent (Copilot agent mode, Claude, Cursor):

```bash
node out/mcp/server.js /path/to/workspace
```

| Tool | What it returns |
| --- | --- |
| `graphweft_context` | Ranked files/symbols/dependency flow for a task query (hybrid with embeddings when an index exists). |
| `graphweft_semantic_search` | Embedding-based conceptual search — chunk-level hits with line ranges and snippets. |
| `graphweft_embed` | Builds/refreshes the local embedding index (incremental). |
| `graphweft_impact` | Blast radius — files transitively importing a file. |
| `graphweft_path` | Shortest dependency path between two files. |
| `graphweft_hotspots` | Most-connected files (god nodes). |
| `graphweft_symbol_refs` | Who imports a given symbol, or the most-imported symbols overall. |
| `graphweft_communities` | Louvain clusters. |
| `graphweft_stats` | Index size + freshness info. |

The server watches the workspace via `fs.watch` and applies changed files incrementally before every
tool call, so answers always reflect the current code. When an embedding index exists, changed files
are re-embedded incrementally too (best-effort).

## Local semantic search (CLI + MCP)

Fully on-device embeddings — no external server required. The model
(default `jinaai/jina-embeddings-v2-base-code`, quantized ONNX) is downloaded once to
`~/.graphweft/models` on first use; vectors persist per repo under `~/.graphweft/index/`.

```bash
node out/node/cli.js embed .                          # build/refresh the embedding index
node out/node/cli.js embed . --model Xenova/all-MiniLM-L6-v2   # smaller/faster model (~25 MB)
node out/node/cli.js embed . --wipe                   # discard vectors and re-embed from scratch
node out/node/cli.js semantic . "where do we debounce file watcher events" --top 10
node out/node/cli.js search . "auth flow"             # hybrid automatically when index exists
node out/node/cli.js search . "auth flow" --no-semantic   # graph/lexical only
```

Environment overrides: `GRAPHWEFT_EMBED_MODEL` (HF model id), `GRAPHWEFT_MODEL_CACHE`,
`GRAPHWEFT_CACHE_DIR` (vector index root), `GRAPHWEFT_EMBED_RUNTIME`
(`auto` | `local` | `ollama` | `off`). Chunking is AST-aware (one chunk per top-level
symbol + a file-summary chunk); only changed chunks re-embed on subsequent runs.
