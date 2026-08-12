# Using CodeGraph outside VS Code (Claude Code, Codex, Copilot CLI)

CodeGraph's engine runs **headlessly** — no VS Code, no model calls, fully local. It exposes the
same local code graph, structural retrieval, and impact analysis through a CLI that any AI coding
tool can invoke as a shell command. (A richer MCP server is planned; see the end.)

## The CLI

After building (`pnpm run compile`), the engine is at `out/node/cli.js`:

```bash
codegraph index   [dir]                  # build the graph, print {files, symbols, edges}
codegraph search  [dir] <query...>       # ranked, structure-aware context for a query (JSON)
codegraph impact  [dir] <file>           # files that transitively depend on <file>
codegraph path    [dir] <fileA> <fileB>  # shortest dependency path
codegraph report  [dir]                  # full graph report (god nodes, communities) as markdown
```

`dir` defaults to the current directory. Output is JSON (or markdown for `report`) — easy for an
LLM to consume. Everything is local; no network, no model.

Install globally for the bare `codegraph` command:

```bash
npm install -g .        # from this repo (publishes the `codegraph` bin)
# or run directly:
node /path/to/codegraph/out/node/cli.js search . "where is auth handled"
```

## Why route context through CodeGraph

These tools already have their own model and agent loop — what they lack is a **token-efficient,
dependency-aware view** of the codebase. Calling `codegraph search` returns the focused slice
(ranked files + symbols + dependency flow) instead of the agent grepping and dumping whole files.

## Claude Code

Claude Code can run shell commands directly, so it can call the CLI as-is. To make it first-class:

- **Allow the command** (so it runs without prompting) — add to `.claude/settings.json`:
  ```json
  { "permissions": { "allow": ["Bash(codegraph:*)"] } }
  ```
- **Or add a slash command** — `.claude/commands/codegraph.md`:
  ```md
  Run `codegraph search . "$ARGUMENTS"` and use the returned files as the focused context
  for the task, reading them before answering.
  ```

## OpenAI Codex CLI

Codex runs in a sandbox that can execute commands. Reference the CLI in `AGENTS.md` at the repo
root so the agent prefers it for context gathering:

```md
## Codebase context
Before broad searches, run `codegraph search . "<what you're looking for>"` to get the
ranked, dependency-aware set of relevant files, then read those.
```

## GitHub Copilot (CLI / coding agent)

The Copilot CLI and coding agent can run shell commands; document the same `codegraph search`
usage in the repo's instructions file (e.g. `.github/copilot-instructions.md`).

## Roadmap: MCP server

The universal next step is a **Model Context Protocol** server wrapping this same engine, exposing
`codegraph_search`, `codegraph_impact`, `codegraph_path`, and `codegraph_report` as native tools +
resources. Claude Code, Codex, and Copilot all support MCP, so one server registers everywhere
(`claude mcp add`, Codex `config.toml` `[mcp_servers]`, VS Code `mcp.json`). It requires a small
dedicated ESM build (the MCP SDK is ESM-only) and is tracked as the follow-up to this CLI.
