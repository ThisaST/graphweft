/**
 * Public entry point for the `graphweft` npm package.
 *
 * This is the **headless** surface: the code graph engine, indexers, retrieval, report
 * builders, and the MCP server — everything that runs under plain Node with no VS Code
 * host. The VS Code extension (`src/extension.ts`) is published separately to the
 * Marketplace via `vsce` and is deliberately NOT re-exported here, because it imports
 * the `vscode` module, which only resolves inside an extension host.
 *
 * Nothing reachable from this file may import `vscode`.
 */

// Engine — the "give me the relevant slice of this repo" API.
export { GraphweftEngine } from './node/graphweftEngine';
export type {
  IndexSummary,
  SearchHit,
  SearchResult,
  SemanticHit,
  SemanticSearchOptions,
} from './node/graphweftEngine';
export { scanDirectory } from './node/nodeScanner';
export type { ScanOptions } from './node/nodeScanner';

// Graph model, storage, retrieval and algorithms.
export type {
  CodeSymbol,
  CodeSymbolType,
  GraphweftFile,
  ImportReference,
  IndexedWorkspace,
  LineRange,
  RankedFileResult,
  RankedSymbolResult,
  RetrievalResult,
} from './graph/graphTypes';
export type { GraphStore } from './graph/graphStore';
export { InMemoryGraphStore } from './graph/inMemoryGraphStore';
export { GraphRetriever } from './graph/graphRetriever';
export { reciprocalRankFusion } from './graph/graphRanker';
export type { GraphRetrievalHints } from './graph/graphRanker';
export {
  buildFileGraph,
  communityLabels,
  computeDegrees,
  impactSet,
  personalizedPageRank,
  shortestPath,
} from './graph/graphAlgorithms';
export type { DegreeRow, FileGraph, PathResult } from './graph/graphAlgorithms';

// Indexers.
export { indexGenericFile } from './indexer/genericIndexer';
export { indexTypeScriptFile } from './indexer/typescriptAstIndexer';
export { loadGrammar, treeSitterExtensions } from './indexer/treeSitterIndexer';

// Context packaging and reporting.
export { buildContextMarkdown } from './compressor/contextCompressor';
export { buildGraphReport, renderGraphReportMarkdown } from './report/graphReport';

// Local semantic layer.
export { HeadlessSemanticIndex, toFileMatches } from './semantic/headlessSemanticIndex';
export type { SemanticBuildStats } from './semantic/headlessSemanticIndex';
export type { EmbeddingChainConfig, EmbeddingRuntime } from './semantic/providerChain';
export type { ChunkMatch } from './semantic/sqliteVectorStore';

// MCP stdio server (guarded by `require.main`, so importing this is side-effect free).
export { startServer as startMcpServer } from './mcp/server';
