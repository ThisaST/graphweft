# Changelog

All notable changes to **Graphweft** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] — 2026-08-30

### Fixed
- **Imports that name a package *directory* did not resolve, so the graph was near-empty on
  Go, and on any language whose unit of import is a directory rather than a file.** On a
  113-file Go repository the import graph had **5 edges** — and all five were accidents,
  where an import's final segment happened to match a unique *file* name. `impact`, `path`,
  `communities` and the personalized-PageRank ranking signal were all effectively inert.
  `resolveDirectoryPackage` now drops leading segments of a specifier one at a time and
  links to every file in the longest suffix that is a real directory, so
  `github.com/org/repo/internal/billing/api` resolves to `internal/billing/api/`. Same repo,
  after: **147 edges**. Single-segment specifiers are ignored so standard-library imports
  (`context`, `fmt`) cannot invent edges.
- **The retriever carried a second, weaker import resolver** that understood relative TS/JS
  specifiers only. Even with the fix above, one-hop expansion, the importer/imported score
  boosts and `dependencyFlow` stayed empty on non-TypeScript repositories. It now shares the
  multi-language resolver in `graphAlgorithms`. Measured over four queries on the same Go
  repo, `dependencyFlow` went from **0 to 149** edges, surfacing the actual collaborators
  (the ClickHouse client for a cost-event query, the migration runner for an RLS query).
  The file graph is now built once per retrieval and reused for both the import lookups and
  the PageRank signal, rather than built twice.

### Changed
- Retrieval context on a Go repository got slightly *cheaper* while getting more accurate
  (16,897 vs 17,047 tokens over a 10-query benchmark), because better ranking spends the
  same budget on more relevant chunks.

## [0.8.3] — 2026-08-28

### Fixed
- **The npm `description` and `keywords` fix in 0.8.2 never reached the registry.** npm
  captures registry metadata from `package.json` *before* running `prepack`, so the
  pack-time swap changed the tarball but not the npm page, which kept advertising a
  "@graphweft chat participant … Works with GitHub Copilot Chat". Both fields are now
  worded in the committed manifest to serve npm and the Marketplace, and
  `scripts/npm-manifest.js` no longer pretends to swap them. `main` stays swapped: Node
  reads that from the tarball, where the swap does apply.

## [0.8.2] — 2026-08-28

### Fixed
- **The MCP server indexed non-TypeScript files at reduced fidelity.** It never preloaded
  tree-sitter grammars, so `extractTreeSitterSymbols` returned `undefined` and every
  Python/Go/Rust/Java/C#/Ruby/PHP/C++/Bash file silently fell back to regex extraction —
  losing nested symbols (methods inside a class, functions in a Rust `impl`). Measured at a
  31% symbol loss on a mixed-language fixture. Agents using MCP, the primary consumer, were
  the ones affected. The three copies of this preload logic are now one exported
  `preloadGrammarsForPaths` used by the engine, the workspace indexer, and the MCP server.
- **npm-facing `description` and `keywords` still described the VS Code extension**
  ("@graphweft chat participant… Works with GitHub Copilot Chat"), which is what npm shows
  in search results and under the package name.
- **`main` pointed at `out/extension.js`, which is not published to npm.** Resolving the
  package by path (rather than by name, where `exports` applies) failed with
  `Please verify that the package.json has a valid "main" entry`.
- **The CLI exited 0 on bad input**, so mistyped paths passed silently in scripts and CI.
  `index`/`search`/`embed`/`semantic`/`impact`/`path`/`report` now verify the target is a
  readable directory, and `impact`/`path` fail when a file is not in the index instead of
  returning an empty result indistinguishable from "nothing depends on this".
- **`--model` was undocumented on `search` and `semantic`** (it was always parsed and applied),
  making `embed --model X` followed by a bare `semantic` look broken. Documented in usage and
  the readme, with a pointer to `GRAPHWEFT_EMBED_MODEL`.
- The `embed` progress message hard-coded `~/.graphweft/models`; it now reports the cache
  directory actually in use (honouring `GRAPHWEFT_MODEL_CACHE`).

### Changed
- `scripts/swap-readme.js` became `scripts/npm-manifest.js` and now swaps the npm-only
  `main`, `description`, and `keywords` alongside the readme during `prepack`/`postpack`.
  vsce never runs those hooks, so the Marketplace build keeps its own values.

## [0.8.1] — 2026-08-28

### Added
- **npm distribution.** The headless engine now publishes to npm as `graphweft`. A
  Node-safe entry point (`src/index.ts`) exports the engine, graph algorithms, retriever,
  indexers, report builders and MCP server; `main` stays the VS Code extension while
  Node resolves the package through `exports`, so both distributions work from one manifest.
- **`graphweft-mcp` binary** — the MCP stdio server is now directly invokable, so client
  config is `"command": "graphweft-mcp"` instead of a hard-coded path into `out/`.
- **npm-specific README** (`npm-readme.md`), swapped in by `prepack`/`postpack` via
  `scripts/swap-readme.js` so the npm page documents the CLI/MCP/API rather than the
  VS Code chat participant, while the Marketplace page keeps its own README.

### Fixed
- **`pnpm-workspace.yaml` was missing the `packages:` field**, which made every pnpm
  command fail — including `pnpm install`, `pnpm run compile` and `pnpm test`.
- **Stale build artifacts were being published.** `out/` was never cleaned, so pre-rename
  modules (`codegraphParticipant`, `codegraphEngine`, `codeGraphTreeProvider`) shipped in
  the package. `compile` now runs `scripts/clean.js` first.
- **The MCP server reported a hard-coded version `0.7.0`.** It now reads the version from
  the manifest, so it can no longer drift.
- Narrowed the published `files` list to the vscode-free closure: no tests, no source maps,
  and no VS Code-only modules. Tarball dropped from 311 kB / 195 files to 86 kB / 65 files.

## [0.8.0] — 2026-08-13

### Added
- **Fully-local, chunk-level semantic search for the CLI and MCP server.** Embeddings now run
  **in-process** via a bundled ONNX runtime (`@huggingface/transformers`) — no Ollama or any
  external server required. The model (default `jinaai/jina-embeddings-v2-base-code`,
  quantized; fast alternative `Xenova/all-MiniLM-L6-v2`) is downloaded once to
  `~/.graphweft/models` and never ships in the package.
- **AST-aware chunking** (`src/semantic/codeChunker.ts`): one chunk per top-level
  function/class with a situating header (path › kind › signature), a file-summary chunk per
  file, and a sliding-window fallback for symbol-less files — so results point LLMs at precise
  symbols and line ranges instead of whole files.
- **Persistent per-repo vector store** (`src/semantic/sqliteVectorStore.ts`): sql.js database
  under `~/.graphweft/index/<repo-hash>/semantic.db`, incremental by chunk content hash —
  re-running `embed` after an edit re-embeds only what changed.
- **New CLI commands**: `graphweft embed [dir]` (`--model`, `--wipe`),
  `graphweft semantic [dir] <query…>` (`--top`), and `graphweft search` is now **hybrid by
  default** — embedding similarity is fused into the reciprocal-rank fusion whenever an index
  exists (`--no-semantic` to opt out).
- **New MCP tools**: `graphweft_semantic_search` (chunk-level hits with snippets) and
  `graphweft_embed`; `graphweft_context` fuses semantic ranks automatically. The workspace
  watcher incrementally re-embeds changed files (best-effort).
- **Provider chain** (`src/semantic/providerChain.ts`): `auto` prefers the bundled local
  runtime, falls back to Ollama when configured; `GRAPHWEFT_EMBED_RUNTIME` /
  `GRAPHWEFT_EMBED_MODEL` / `GRAPHWEFT_MODEL_CACHE` / `GRAPHWEFT_CACHE_DIR` overrides.
- Tests: `codeChunker`, `semanticLocal` (provider chain + vector store), `semanticEngine`
  (hybrid engine, injected fake providers), MCP semantic tool coverage — no model downloads
  in CI.
- **Retrieval quality benchmark** (`src/benchmark/retrievalBenchmark.ts`): grep baseline vs
  graph-only vs hybrid on 12 ground-truth queries. Hybrid: MRR 0.547 vs 0.38 for both
  baselines; 100% lexical hit@5; conceptual hit@5 43% vs 14% graph-only — at the same token
  cost as graph-only. Results in BENCHMARKS.md.
- **Agent-in-the-loop benchmark** (`src/benchmark/agentBenchmark.ts`): real Claude Code and
  GitHub Copilot CLI agents answering 8 ground-truth codebase questions across three arms
  (no graphweft / graph-only MCP / graph+embeddings MCP), with per-run correctness, wall time,
  turns, tokens, cost, and graphweft tool-call telemetry. Headline: the one task no agent
  solved without graphweft (keyword-free conceptual lookup) was solved with it; Copilot cut
  wall time 27%; tool *adoption* (not tool quality) is the bottleneck for Claude. Full
  methodology, results, and caveats in AGENT_BENCHMARKS.md.

### Changed
- **Project renamed to Graphweft.** The extension formerly known as CodeGraph / Codemap — Local
  Code Graph is now **Graphweft**. This is a comprehensive rename:
  - npm/extension package name: `codemap-graph` → `graphweft`.
  - Chat participant: `@codegraph` → `@graphweft` (id `graphweft.chat`).
  - Command IDs: `codegraph.*` → `graphweft.*`.
  - Settings namespace: `codegraph.*` → `graphweft.*`.
  - MCP server tools: `codegraph_context`, `codegraph_impact`, `codegraph_path`,
    `codegraph_hotspots`, `codegraph_symbol_refs`, `codegraph_communities`, `codegraph_stats`
    → `graphweft_*` equivalents.
  - CLI bin: `codegraph` → `graphweft`.
  - Public API surface (e.g. `CodeGraphEngine` → `GraphweftEngine`) and storage keys renamed
    to match.

  Historical changelog entries below retain the old names for accuracy.
- The VS Code extension is unaffected by the new semantic pipeline: it keeps its Ollama-based
  file-level semantic path, and `.vscodeignore` hard-excludes
  `@huggingface/transformers`/`onnxruntime`/`sharp` so ONNX binaries can never enter the VSIX
  (leak check documented in PUBLISHING.md).

## [0.7.0] — 2026-08-12

### Added
- **Real-time index freshness for AI-agent edits.** A workspace-wide filesystem watcher
  (`**/*`, 300 ms debounce) now catches *all* file events — including writes made through
  `vscode.workspace.fs` by AI agents, which never fire `onDidSaveTextDocument` and previously
  left the graph stale. The agent's own write/edit tools re-index touched files immediately
  (`reindexUris`), and every chat turn / graph command flushes pending changes first
  (`ensureFresh`/`flushPending`). Content hashing (SHA-256) skips no-op writes; all index
  mutations are serialized and fire `onDidChangeIndex`.
- **Live graph view + sidebar updates.** The Cytoscape webview patches elements in place on
  index changes (preserving your layout/positions) instead of requiring a reopen; the sidebar
  tree refreshes automatically.
- **Louvain community detection** (graphology, seeded and deterministic) replaces label
  propagation, with a fallback when graphology is unavailable.
- **Personalized PageRank ranking signal.** Retrieval seeds PPR with the query's matched files
  (Aider-style repo-map ranking) and applies it as a bounded nudge that can't override direct
  intent matches.
- **Reciprocal Rank Fusion.** Keyword, semantic, and centrality rankings are fused with the
  standard RRF k=60 formula before boosting.
- **Symbol-level reference graph.** Named imports are resolved against exported symbols, giving
  symbol-granular edges. New "Hot Symbols" table in the graph report.
- **Tree-sitter AST indexing** for Python, Go, Java, C#, Rust, Ruby, PHP, C++, and Bash via
  `web-tree-sitter` + VS Code's prebuilt WASM grammars: real line ranges, nested `parentName`,
  Go/Rust export detection. Falls back to the regex extractors when a grammar can't load.
- **MCP server.** Zero-dependency JSON-RPC 2.0 stdio server (`out/mcp/server.js <root>`) exposing
  `codegraph_context`, `codegraph_impact`, `codegraph_path`, `codegraph_hotspots`,
  `codegraph_symbol_refs`, `codegraph_communities`, `codegraph_stats` to any MCP client, with
  `fs.watch`-based incremental freshness per call.

### Changed
- **SQLite persistence is now debounced (500 ms) and incremental.** `upsert` patches only changed
  files; sql.js full-DB exports are coalesced; `dispose()` flushes on deactivation. Schema v3
  adds `content_hash`.

## [0.6.0] — 2026-08-12

### Added
- **Workspace-package import resolution (monorepos).** `@scope/pkg` and `@scope/pkg/entry`
  imports (and unambiguous bare `pkg/entry` specifiers) now resolve to same-named workspace
  directories — trying the directory itself, then `src/`, then `lib/` — so cross-package edges in
  pnpm/npm/yarn monorepos land in the graph. `impact` and `path` now see through package
  specifiers like `@elementlogic-dds/dashboard-shared/ChartCard` instead of dropping them.
- **npm-publishable CLI package.** `package.json` gained a `files` whitelist (ships `out/` + docs,
  ~200 kB instead of accidentally packing every `.vsix`), `engines.node >= 18`, and a
  `prepublishOnly` compile step, so `npm install -g codemap-graph` provides the `codegraph` bin.

## [0.5.0] — 2026-06-10

### Added
- **Headless engine + CLI (cross-tool foundation).** The code-graph engine now runs with no VS
  Code dependency, via a new `codegraph` CLI: `index`, `search` (ranked, dependency-aware context
  as JSON), `impact`, `path`, and `report`. This lets other AI coding tools (Claude Code, Codex,
  Copilot CLI) pull token-efficient, structure-aware context by shelling out — fully local, no
  model calls. See [INTEGRATIONS.md](INTEGRATIONS.md). (A native MCP server is the planned next step.)
- The `WorkspaceSourceFile` type was decoupled from VS Code so the indexers run in plain Node.

### Fixed
- **Manual "Build Local Index" now indexes all languages.** The command previously ran every file
  through the TypeScript indexer, so C#/other-language files got no namespace/import edges — it now
  uses the same multi-language routing as the automatic build, matching the graph in both paths.

## [0.4.4] — 2026-06-10

### Changed
- **Cleaner sidebar.** The CodeGraph panel now opens scannable instead of a long wall of rows:
  section headers have icons and headline counts (token-savings %, model-call count), and the
  secondary sections (Communities, Suggested Questions, Recent Model Calls) start collapsed.
- **Activity Bar icon matches the chat icon.** The left-rail icon is now a custom graph glyph
  (monochrome, theme-tinted) echoing the `@codegraph` chat avatar, replacing the generic
  `$(graph)` codicon.

## [0.4.3] — 2026-06-10

### Fixed
- **File edits failed with "the find text was not found."** The edit tool matched the snippet
  byte-for-byte, which broke whenever the file's line endings differed from the model's `find`
  text — the common case for C#/.NET files on Windows (`\r\n` on disk vs `\n` from the model),
  so multi-line edits could never apply. The edit tool now matches tolerantly: exact →
  line-ending-normalized → per-line whitespace-flexible, and **preserves the file's original
  line endings** on write (no more rewriting every line). The read tool also no longer leaves a
  stray `\r` on each numbered line, so copied snippets match cleanly. The error message now lists
  what was tried and how to recover.

## [0.4.2] — 2026-06-10

### Changed
- **Attached code is now confirmed and acted on, not interrogated.** CodeGraph shows a
  `📎 Using your attached selection: …` line when it captures attached references (so it's
  visible that the selection was received), and the agent is now instructed to **investigate
  and act rather than ask**: it won't request code that's attached or readable with its tools,
  it inspects "the other components"/similar files to infer a pattern before applying it, and
  it asks a clarifying question only as a last resort (otherwise it makes the most reasonable
  change and states its assumption).

## [0.4.1] — 2026-06-10

### Fixed
- **Attached code/selections were ignored.** When you attached a selection or file to your
  message (the reference chip, e.g. `Foo.razor.cs:23-28`), CodeGraph didn't see it and replied
  "I need to see the actual code" — because VS Code delivers attachments via `request.references`,
  not the prompt text, and the participant only read the prompt. CodeGraph now resolves attached
  references (selections → the exact line range, files → contents), feeds them to the model as the
  **primary subject** of the request (so "this"/"these"/"the above" resolve to them), and seeds
  them into retrieval. Large attachments are clipped to protect the token budget.

## [0.4.0] — 2026-06-10

### Added
- **Opt-in local semantic search (hybrid retrieval).** CodeGraph can now find files by
  *meaning*, not just keywords — "where's the retry logic?" surfaces `BackoffPolicy.cs`
  with zero word overlap. Embeddings are generated by a **local server you run yourself**
  (Ollama or compatible); the endpoint is restricted to loopback addresses by design, no
  model weights ship in the extension, and **no code ever leaves your machine**. Instead of
  blind text chunks, each file is embedded as a graph-aware summary (path, namespace,
  symbol signatures, imports), so one compact vector captures what the file is *and* how it
  connects. Semantic matches seed and boost the existing lexical+graph ranking — disabled
  (the default) or with the server down, retrieval behaves exactly as before.
  **To use:** install [Ollama](https://ollama.com), `ollama pull nomic-embed-text`, enable
  `codegraph.semanticSearch.enabled`, then run **CodeGraph: Build Semantic Index**. Vectors
  are stored locally and refreshed incrementally (only changed files are re-embedded).

## [0.3.2] — 2026-06-10

### Fixed
- **Model suggestions could offer an unusable model.** `selectChatModels()` can advertise
  models that aren't actually enabled for your account (VS Code exposes the full catalog,
  not just your picker), so a suggestion for a model you can't use could appear — and
  clicking it silently answered with a *different* model. Suggestions are now drawn only
  from the live available-models list, and when you pick one CodeGraph **re-checks it is
  still in that list before answering**. If it isn't, CodeGraph never silently switches: it
  says so, answers with your current model, and **remembers the bad model so it's not
  suggested again** this session.

## [0.3.1] — 2026-06-10

### Fixed
- **Build artifacts were being indexed (all languages).** Generated/compiled files
  polluted the graph and inflated the token-savings baseline. The scanner now excludes a
  broad, cross-language set of build/dependency directories — `node_modules`, `dist`,
  `build`, `out`, `obj`, `bin`, `target`, `vendor`, `_framework`, `.venv`/`__pycache__`,
  `Pods`/`DerivedData`/`.build`, `_build`/`deps`, `.gradle`, `.dart_tool`, `dist-newstyle`,
  `cmake-build-*`, `.terraform`, `.next`/`.nuxt`/`.svelte-kit`, and more — and filters
  generated files by name regardless of location: .NET (`*.g.cs`, `*.Designer.cs`,
  `*.AssemblyInfo.cs`, `dotnet.*.js`, `blazor.*.js`), protobuf/gRPC (`*.pb.go`, `*_pb2.py`,
  `*.pb.h`), `*.generated.*`, minified/bundled JS/CSS, source maps, and lockfiles
  (`package-lock.json`, `pnpm-lock.yaml`). **Re-run `CodeGraph: Build Local Index`** to drop
  already-indexed artifacts.

## [0.3.0] — 2026-06-10

### Added
- **Thorough, multi-model selection.** Model suggestions no longer collapse to a coarse
  3-tier guess with a single up/down nudge. A curated capability registry profiles each
  available model across five axes — capability, cost, speed, reasoning, context window —
  and a recommender ranks them for the specific task (tier + type + prompt size), surfacing
  **several distinct, role-labelled options** (🥇 best fit, ⚡ cheapest that fits, 🚀 most
  capable, 📏 largest context, 💨 fastest) each with a fit score and rationale, plus
  "keep current." Models that can't hold the prompt are excluded automatically.
- **`/models` benchmark command.** Prints a transparency table of every available model
  with its scored axes and marks your current pick — so the ranking behind suggestions is
  inspectable. (The model API exposes no cost/quality data, so these are curated relative
  scores; values estimated from a model's name are marked with `~`.)

## [0.2.1] — 2026-06-10

### Added
- **Output-token counting & full spend.** The audit log and `/savings` now also
  record **output (completion) tokens** generated across the agent loop, alongside
  end-to-end input tokens. The report shows total spend (input + output) with
  dollar estimates at common input/output prices, so cost claims reflect the whole
  request, not just context. Older entries without counts degrade gracefully.

## [0.2.0] — 2026-06-10

### Added
- **Accurate token-savings measurement.** Savings are now counted with the model's
  real tokenizer (`model.countTokens`) instead of a bytes÷4 estimate, for both the
  assembled context and the naive file-dump baseline. The audit log and `/savings`
  also record **end-to-end input tokens across the whole agent loop** (every tool
  round), so the report shows both context efficiency and honest total input cost.
  Older log entries without token counts fall back to the byte estimate.
- **Multi-language dependency edges.** The graph now connects files across many
  languages, not just TypeScript/JavaScript. Namespace/package imports are resolved
  to the files that declare them — C# `using`, Java/Kotlin/Scala `import`/`package`,
  PHP `namespace`/`use` — and path-style imports (C/C++ `#include`, Python dotted
  modules, Go/Ruby/Lua requires) resolve by path and module name. Bare,
  ambiguous names are intentionally left unlinked to avoid spurious edges.
  Re-run **CodeGraph: Build Local Index** to populate edges for non-JS/TS projects.

### Fixed
- **Extension failed to activate when installed from the Marketplace.** The
  TypeScript compiler API is used at runtime for AST-based indexing, but
  `typescript` had been declared as a dev-only dependency, so it was not bundled
  into the published `.vsix`. Loading the extension threw at `require('typescript')`
  before `activate()` could register anything — surfacing as
  `command 'codegraph.buildIndex' not found` and
  `No activated agent with id "codegraph.chat"`. `typescript` is now a runtime
  dependency and ships inside the package, so indexing and the `@codegraph` chat
  participant work in installed builds.
- **Interactive graph appeared blank on sparse graphs.** The force layout ran over
  every indexed file, so a graph with few edges scattered its disconnected nodes
  across a huge area and the viewport zoomed out until nodes were invisible. The
  view now lays out and fits only the connected (visible) nodes, and theme colors
  are resolved to concrete values the canvas renderer understands.

## [0.1.0] — 2026-06-10

Initial public release.

### Added
- **`@codegraph` chat participant** with a cost/privacy-aware model router and an
  agentic tool loop (run terminal commands, read/write/edit files, query the graph).
- **Local-first code graph**: multi-language indexing, an interactive Cytoscape
  graph viewer, and a sidebar tree view.
- **Slash commands**: `/path`, `/impact`, `/report`, `/viz`, `/godnodes`,
  `/savings`, `/audit`, `/privacy`, `/wipe`, `/help`.
- **Privacy Center** with `standard` / `preview-before-send` / `local-only` modes
  and a per-call audit log (timestamp, model, bytes sent, prompt hash).
- **Token-savings analysis** comparing context sent vs. a naive baseline.
- Conversation history threading across chat turns, an in-chat **Continue** button
  at the step limit, and modernized chat rendering for terminal output, file
  reads/edits (clickable links), and search results.

[0.5.0]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.4.4]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.4.3]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.4.2]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.4.1]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.4.0]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.3.2]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.3.1]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.3.0]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.2.1]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.2.0]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
[0.1.0]: https://marketplace.visualstudio.com/items?itemName=ThisaraPramu.codemap-graph
