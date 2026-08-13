/**
 * Host-agnostic Graphweft engine. Wraps the pure graph/indexer/retriever modules behind a small
 * API that any host (CLI, MCP server, future tools) can drive without VS Code. Holds the index
 * in memory; a host can persist `getFiles()` if it wants durability.
 */
import { buildFileGraph, impactSet, shortestPath, PathResult } from '../graph/graphAlgorithms';
import { GraphRetriever } from '../graph/graphRetriever';
import { InMemoryGraphStore } from '../graph/inMemoryGraphStore';
import { GraphweftFile } from '../graph/graphTypes';
import { buildGraphReport, renderGraphReportMarkdown } from '../report/graphReport';
import { indexGenericFile } from '../indexer/genericIndexer';
import { indexTypeScriptFile } from '../indexer/typescriptAstIndexer';
import { loadGrammar, treeSitterExtensions } from '../indexer/treeSitterIndexer';
import { scanDirectory, ScanOptions } from './nodeScanner';

export interface IndexSummary {
  files: number;
  symbols: number;
  edges: number;
}

export interface SearchHit {
  path: string;
  score: number;
  reason: string;
}

export interface SearchResult {
  query: string;
  files: SearchHit[];
  symbols: Array<{ name: string; type: string; file: string }>;
  dependencyFlow: string[];
  relatedTests: string[];
}

export class GraphweftEngine {
  private readonly store = new InMemoryGraphStore();

  /** Build (or rebuild) the index from a directory on disk. */
  public async indexDirectory(root: string, options?: ScanOptions): Promise<IndexSummary> {
    const sources = await scanDirectory(root, options);
    await preloadGrammarsFor(sources.map((file) => file.workspaceRelativePath));
    const files = sources.map((file) => (file.isTypescript ? indexTypeScriptFile(file) : indexGenericFile(file)));
    await this.store.replace(files);
    return {
      files: files.length,
      symbols: files.reduce((n, f) => n + f.symbols.length, 0),
      edges: this.edgeCount(files),
    };
  }

  public hasIndex(): boolean {
    return this.store.hasIndex();
  }

  public getFiles(): GraphweftFile[] {
    return this.store.getFiles();
  }

  /** Ranked, structurally-aware context for a query — the core "give me the relevant slice" op. */
  public search(query: string, limit = 12): SearchResult {
    const retrieval = new GraphRetriever(this.store).retrieve(query, 6000);
    return {
      query,
      files: retrieval.files.slice(0, limit).map((r) => ({
        path: r.file.path,
        score: Math.round(r.score),
        reason: r.reasons.join(', '),
      })),
      symbols: retrieval.symbols.slice(0, 20).map((s) => ({ name: s.symbol.name, type: s.symbol.type, file: s.symbol.filePath })),
      dependencyFlow: retrieval.dependencyFlow,
      relatedTests: retrieval.relatedTests,
    };
  }

  /** Files that transitively depend on `file` (blast radius). */
  public impact(file: string, maxDepth = 4): string[] {
    const match = this.matchPath(file);
    if (!match) return [];
    return impactSet(buildFileGraph(this.store.getFiles()), match, maxDepth);
  }

  /** Shortest dependency path between two files. */
  public path(from: string, to: string): PathResult {
    const a = this.matchPath(from);
    const b = this.matchPath(to);
    if (!a || !b) return { found: false, path: [], hopCount: 0 };
    return shortestPath(buildFileGraph(this.store.getFiles()), a, b);
  }

  /** Full graph report (god nodes, communities, surprises) as markdown. */
  public report(): string {
    return renderGraphReportMarkdown(buildGraphReport(this.store.getFiles()));
  }

  /** Resolve a partial path the way the slash commands do (exact, else first substring match). */
  public matchPath(query: string): string | undefined {
    const paths = this.store.getFiles().map((f) => f.path);
    if (paths.includes(query)) return query;
    const lower = query.toLowerCase();
    return paths.find((p) => p.toLowerCase().includes(lower));
  }

  private edgeCount(files: GraphweftFile[]): number {
    let count = 0;
    for (const targets of buildFileGraph(files).adjacency.values()) count += targets.size;
    return count;
  }
}

/** Best-effort tree-sitter grammar preload for the languages present in `paths`. */
async function preloadGrammarsFor(paths: string[]): Promise<void> {
  const known = new Set(treeSitterExtensions());
  const wanted = new Set<string>();
  for (const filePath of paths) {
    const dot = filePath.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = filePath.slice(dot).toLowerCase();
    if (known.has(ext)) wanted.add(ext);
  }
  await Promise.all([...wanted].map((ext) => loadGrammar(ext).catch(() => false)));
}
