# Using CodeGraph with external AI tools

CodeGraph runs **headlessly** — no VS Code, no model calls, fully local. Two integration
surfaces, both wrapping the same engine:

1. **MCP server** (recommended) — `out/mcp/server.js`, a zero-dependency JSON-RPC 2.0
   stdio server exposing 9 read-only graph + semantic tools. Works with any MCP client:
   Claude Code, GitHub Copilot (VS Code agent mode + CLI), OpenAI Codex, Cursor, Windsurf, …
2. **CLI** — `out/node/cli.js`, plain shell commands printing JSON/markdown. For tools
   without MCP support (e.g. Ollama).

Why bother: agents that grep-and-dump whole files burn tokens. Routing context through the
graph is **~90% cheaper** for the same task — see [BENCHMARKS.md](BENCHMARKS.md) for the
measured methodology and numbers (90.3% vs naive file dumping, 94.8% vs grep-style
retrieval on this repo).

---

## The MCP server

After building (`pnpm run compile`):

```
node /abs/path/to/codegraph/out/mcp/server.js /abs/path/to/your/project
```

- **Transport**: newline-delimited JSON-RPC 2.0 over stdio (no HTTP, no network).
- **Protocol versions**: echoes `2025-06-18`, `2025-03-26`, `2024-11-05` (falls back to
  `2024-11-05` for unknown versions). Unknown methods get a clean JSON-RPC error — the
  server never crashes on client quirks.
- **Freshness**: watches the project directory (`fs.watch`, debounced) and reindexes
  changed files, so tool answers reflect edits made mid-session by you or the agent.
- **Tools** (all read-only, `readOnlyHint: true`):

| Tool | What it returns |
|---|---|
| `codegraph_context` | Ranked, token-budgeted context pack for a task (files + symbols + dependency flow). Automatically **hybrid** — fuses embedding similarity into the ranking when a semantic index exists |
| `codegraph_semantic_search` | Embedding-based search: functions/classes conceptually similar to a natural-language query, with file:line ranges + snippets |
| `codegraph_embed` | Builds/refreshes the on-device embedding index (incremental; downloads the local ONNX model on first use) |
| `codegraph_impact` | Files transitively affected if a given file changes |
| `codegraph_path` | Shortest dependency path between two files |
| `codegraph_hotspots` | God nodes / high-centrality files |
| `codegraph_symbol_refs` | Most-referenced symbols and where they're used |
| `codegraph_communities` | Louvain module clusters |
| `codegraph_stats` | Index size (files / symbols / edges) |

**Semantic search** is fully local: embeddings run in-process via ONNX
(`@huggingface/transformers`), vectors persist per-repo under `~/.codegraph/index/`, and the
watcher re-embeds changed files incrementally. Build the index once with the
`codegraph_embed` tool or `codegraph embed` on the CLI; without it, every tool still works —
`codegraph_context` simply stays lexical/graph-only. Set `CODEGRAPH_EMBED_RUNTIME=off` to
disable embeddings entirely.

---

## GitHub Copilot CLI ✅ verified end-to-end

Register per-session or persistently in `~/.copilot/mcp-config.json`:

```jsonc
// ~/.copilot/mcp-config.json
{
  "mcpServers": {
    "codegraph": {
      "type": "local",
      "command": "node",
      "args": ["/abs/path/to/codegraph/out/mcp/server.js", "/abs/path/to/your/project"],
      "tools": ["*"]
    }
  }
}
```

One-shot (no config file):

```powershell
copilot -p "Call codegraph_stats and repeat its output" `
  --additional-mcp-config '{"mcpServers":{"codegraph":{"type":"local","command":"node","args":["<abs>/out/mcp/server.js","<abs-root>"],"tools":["*"]}}}' `
  --allow-tool 'codegraph'
```

*Verified:* the model called `codegraph_stats` live and returned
`Indexed 94 files, 626 symbols, 217 import edges.`

## Claude Code ✅ verified (transport handshake)

```bash
claude mcp add codegraph -- node /abs/path/to/codegraph/out/mcp/server.js /abs/path/to/your/project
claude mcp list       # → codegraph: … - ✓ Connected
```

`claude mcp list` performs a real handshake (spawn + `initialize` + capability exchange) —
verified `✓ Connected` against Claude Code 2.1.x. Project-scoped alternative: commit a
`.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/abs/path/to/codegraph/out/mcp/server.js", "."]
    }
  }
}
```

Tool names appear to the model as `mcp__codegraph__codegraph_context` etc. Headless use:
`claude -p --allowedTools "mcp__codegraph__codegraph_context" "your prompt"`.

## VS Code — Copilot agent mode

`.vscode/mcp.json` in the workspace (note VS Code uses a `servers` key, not `mcpServers`):

```json
{
  "servers": {
    "codegraph": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/out/mcp/server.js", "${workspaceFolder}"]
    }
  }
}
```

This repo ships that file, so opening it in VS Code with Copilot agent mode picks the
server up automatically (Chat → Tools → codegraph). Inside VS Code you also get the richer
`@codegraph` chat participant — the MCP route is for making the graph available to *agent
mode* and other MCP hosts.

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.codegraph]
command = "node"
args = ["/abs/path/to/codegraph/out/mcp/server.js", "/abs/path/to/your/project"]
```

Codex speaks MCP protocol `2025-03-26`; the handshake is covered by the simulated client
test (`src/test/mcpClients.test.ts`). Not live-verified here (CLI not installed).

## Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/abs/path/to/codegraph/out/mcp/server.js", "/abs/path/to/your/project"]
    }
  }
}
```

## Ollama (no MCP client — pipe the CLI)

Ollama's CLI has no tool-calling loop, so inject graph context into the prompt:

```bash
codegraph search . "where is auth handled" | ollama run qwen2.5-coder "Using this JSON \
context, explain where auth is handled: $(codegraph search . 'where is auth handled')"
```

Or with any Ollama-backed agent framework that supports MCP (e.g. via `mcphost`), point it
at the same stdio server.

---

## The CLI (fallback for non-MCP tools)

```bash
codegraph index    [dir]                  # build the graph, print {files, symbols, edges}
codegraph search   [dir] <query...>       # ranked context for a query (JSON); hybrid when an embedding index exists (--no-semantic to opt out)
codegraph embed    [dir]                  # build/refresh the local embedding index (--model <hf-id>, --wipe)
codegraph semantic [dir] <query...>       # pure embedding search: chunk-level hits w/ line ranges + snippets (--top N)
codegraph impact   [dir] <file>           # files that transitively depend on <file>
codegraph path     [dir] <fileA> <fileB>  # shortest dependency path
codegraph report   [dir]                  # full graph report (god nodes, communities) as markdown
```

Install globally for the bare `codegraph` command: `npm install -g .` from this repo.

For shell-capable agents without MCP, document it in the repo's agent instructions
(`AGENTS.md`, `.github/copilot-instructions.md`, or a Claude slash command):

```md
Before broad searches, run `codegraph search . "<what you're looking for>"` to get the
ranked, dependency-aware set of relevant files, then read only those.
```

---

## Verification status

| Client | Protocol | Status |
|---|---|---|
| GitHub Copilot CLI | 2025-03-26 | ✅ Live end-to-end: model invoked `codegraph_stats` through the server |
| Claude Code 2.1.x | 2025-06-18 | ✅ Live handshake: `claude mcp list` → `✓ Connected` |
| VS Code Copilot agent mode | 2025-03-26 | ✅ Simulated wire-exact handshake test |
| OpenAI Codex CLI | 2025-03-26 | ✅ Simulated wire-exact handshake test |
| Legacy hosts | 2024-11-05 | ✅ Simulated handshake + fallback test |
| Unknown future versions | any | ✅ Graceful fallback test |

The simulated tests (`src/test/mcpClients.test.ts`) replay each client's exact
`initialize` payload against the real server binary over real stdio, then exercise
`tools/list` + `tools/call` and unknown-method resilience.
