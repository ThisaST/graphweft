# CLAUDE.md

Graphweft — a local-first code graph. One codebase, **three delivery surfaces**:

| Surface | Entry | Ships via |
| --- | --- | --- |
| VS Code extension (`@graphweft` chat participant, graph view, Privacy Center) | `src/extension.ts` | `vsce` → Marketplace |
| CLI (`graphweft`) and MCP server (`graphweft-mcp`) | `src/node/cli.ts`, `src/mcp/server.ts` | npm |
| TypeScript API | `src/index.ts` | npm |

Almost every trap in this repo comes from those surfaces sharing one `package.json`.

## The layering rule

`src/graph/`, `src/indexer/`, `src/context/`, `src/semantic/`, `src/report/`,
`src/compressor/`, `src/utils/`, `src/node/`, `src/mcp/` are **VS Code-free**. Nothing
reachable from `src/index.ts`, the CLI, or the MCP server may `import 'vscode'` — that
module only resolves inside an extension host, so a stray import breaks the npm package
at require time.

A few VS Code-only modules live inside otherwise-headless folders
(`graph/sqliteGraphStore`, `indexer/fileWatcher`, `indexer/workspaceIndexer`,
`indexer/workspaceScanner`, `semantic/semanticIndexer`). They are excluded from the npm
tarball by name in `files`. **If you add another vscode-importing module to a headless
folder, add it to that exclusion list**, then verify:

```bash
npm pack && tar -xzf graphweft-*.tgz -C /tmp/check && grep -rl 'require("vscode")' /tmp/check/package/out
```

That must print nothing.

## Publishing: what is swapped and what cannot be

`scripts/npm-manifest.js` runs on `prepack`/`postpack` and swaps in the npm-facing
`README.md` and `main` for the tarball, then restores the originals. `vsce` never runs npm
lifecycle hooks, so the Marketplace build keeps its own values.

**`description` and `keywords` are deliberately NOT swapped.** npm captures registry
metadata from `package.json` *before* `prepack` runs, so swapping them changes the tarball
but never the npm page — this was shipped broken once and looked fine in `npm pack`. Those
two fields live in the committed manifest, worded to serve both registries.

`main` is different: Node reads it from the *tarball*, so the swap does take effect. It
must stay `./out/extension.js` in the committed manifest or VS Code cannot activate the
extension; npm consumers resolve through `exports` (by name) or the swapped `main` (by path).

Corollary: **an npm README can only be updated by publishing a new version.** There is no
way to fix the page without a release.

If a pack is interrupted mid-swap: `node scripts/npm-manifest.js restore`.

## Do not duplicate cross-cutting logic

Two bugs in this repo were the same mistake — logic copied per host, then fixed in only
some copies:

- **Tree-sitter grammar preload.** `extractTreeSitterSymbols` is synchronous and returns
  `undefined` if the grammar is not already loaded, silently falling back to regex and
  losing nested symbols (methods in a class, functions in a Rust `impl`). The MCP server
  omitted the preload entirely and indexed non-TypeScript files at ~31% fewer symbols than
  the CLI. Now one `preloadGrammarsForPaths` in `indexer/treeSitterIndexer.ts`, used by the
  engine, the workspace indexer, and the MCP server. **Any new host that indexes a batch of
  files must call it.**
- **Import resolution.** `graphRetriever` carried its own resolver that understood relative
  TS/JS specifiers only, so on a Go/Java repo the one-hop expansion, import boosts, and
  `dependencyFlow` were all silently empty while `impact`/`path` worked. There is now one
  resolver: `buildFileGraph` in `graph/graphAlgorithms.ts`. Build the graph **once** per
  retrieval and thread it through.

Symptom to watch for: an index with plausible file and symbol counts but near-zero
**edges**. That means import resolution failed, not that the repo is flat.

## Import resolution, in order

`resolveSpecifier` tries: relative path → namespace/package declaration (C#, Java, Kotlin,
Scala, PHP) → workspace package (`@scope/pkg`) → path-like (C/C++ includes, dotted module
paths) → **directory package** → unique file base name.

The directory step resolves imports that name a *directory* rather than a file — Go's
`github.com/org/repo/internal/billing/api` must reach `internal/billing/api/`. It drops
leading segments one at a time and takes the longest suffix that is a real directory, then
links every file in it. Single-segment specifiers are skipped: those are standard-library
imports (`context`, `fmt`), and matching them against a same-named directory invents edges.

The base-name fallback is last for a reason — it only fires when a package's final segment
happens to match a unique *file* name, which is an accident.

## Ranking

Three scale-incompatible signals fused with Reciprocal Rank Fusion (k=60): lexical matches,
embedding cosine similarity, and personalized PageRank seeded from query matches plus
workspace hints. The fused signal is a **tie-breaker, not a primary signal** —
`centralityBoostScale = 8` against intent boosts like the +45 test-task boost. Keep it that
way; raising it lets popularity override explicit intent.

## Conventions

Strict TS with `noUnusedLocals`/`noUnusedParameters`. Classes for stateful services, free
functions for pure logic; `public`/`private` written explicitly. No test framework — tests
are plain scripts run with `node out/test/*.test.js`, chained with `&&` in the `test`
script; add new ones there. Comments explain **why**, not what — match that density.

## Commands

```bash
pnpm install          # pnpm-workspace.yaml needs a `packages:` field or every pnpm command fails
npm test              # clean rebuild + all 18 suites
npm run compile       # cleans out/ first — stale artifacts have shipped before
node_modules/.bin/vsce ls   # what the .vsix would contain
```

When changing anything that affects packaging, check **both** distributions: `npm pack` for
the tarball and `vsce ls` for the extension. They are governed by different files (`files`
vs `.vscodeignore`) and a change to one does not show up in the other.

## Verifying claims

This project's value proposition is measurable, so measure it rather than asserting it.
`src/benchmark/` holds the retrieval and token benchmarks; `BENCHMARKS.md` and
`AGENT_BENCHMARKS.md` hold results and methodology. When comparing against a "naive"
baseline, make the baseline something a competent agent would actually do — a
union-of-every-keyword grep is a strawman and inflates the numbers.
