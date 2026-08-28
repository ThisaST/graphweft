/**
 * Host-agnostic Graphweft engine. Wraps the pure graph/indexer/retriever modules behind a small
 * API that any host (CLI, MCP server, future tools) can drive without VS Code. Holds the index
 * in memory; a host can persist `getFiles()` if it wants durability.
 */
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { buildFileGraph, impactSet, shortestPath, PathResult } from '../graph/graphAlgorithms';
import { GraphRetriever } from '../graph/graphRetriever';
import { InMemoryGraphStore } from '../graph/inMemoryGraphStore';
import { GraphweftFile } from '../graph/graphTypes';
import { buildGraphReport, renderGraphReportMarkdown } from '../report/graphReport';
import { indexGenericFile } from '../indexer/genericIndexer';
import { indexTypeScriptFile } from '../indexer/typescriptAstIndexer';
import { preloadGrammarsForPaths } from '../indexer/treeSitterIndexer';
import { HeadlessSemanticIndex, SemanticBuildStats, toFileMatches } from '../semantic/headlessSemanticIndex';
import { EmbeddingChainConfig } from '../semantic/providerChain';
import { ChunkMatch } from '../semantic/sqliteVectorStore';
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
  /** Chunk-level semantic hits backing the hybrid ranking (present when embeddings exist). */
  semanticHits?: SemanticHit[];
}

export interface SemanticHit {
  path: string;
  symbol?: string;
  kind: string;
  startLine: number;
  endLine: number;
  similarity: number;
  snippet?: string;
}

export interface SemanticSearchOptions {
  topK?: number;
  minSimilarity?: number;
  /** Attach a short source snippet to each hit (reads from disk). Default true. */
  includeSnippets?: boolean;
}

export class GraphweftEngine {
  private readonly store = new InMemoryGraphStore();
  private root?: string;
  private semantic?: HeadlessSemanticIndex;
  private semanticConfig?: EmbeddingChainConfig;

  public constructor(config?: { semantic?: EmbeddingChainConfig }) {
    this.semanticConfig = config?.semantic;
  }

  /** Build (or rebuild) the index from a directory on disk. */
  public async indexDirectory(root: string, options?: ScanOptions): Promise<IndexSummary> {
    this.root = root;
    const sources = await scanDirectory(root, options);
    await preloadGrammarsForPaths(sources.map((file) => file.workspaceRelativePath));
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

  /**
   * Hybrid search: like `search`, but fuses semantic chunk similarity into the ranking when a
   * semantic index exists for this repo (best-effort — falls back to pure graph search
   * silently, so hosts can always call this).
   */
  public async searchHybrid(query: string, limit = 12): Promise<SearchResult> {
    const semantic = await this.getSemantic();
    const chunkMatches = semantic ? await semantic.trySearch(query, 24) : [];
    if (chunkMatches.length === 0) return this.search(query, limit);

    const retrieval = new GraphRetriever(this.store).retrieve(query, 6000, {
      semanticMatches: toFileMatches(chunkMatches),
    });
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
      semanticHits: await this.toSemanticHits(chunkMatches.slice(0, 8), false),
    };
  }

  /**
   * Build/refresh the semantic (embedding) index for the indexed directory. Chunks every
   * indexed file, embeds only new/changed chunks, persists to the per-repo cache.
   */
  public async buildSemanticIndex(onProgress?: (embedded: number, total: number) => void): Promise<SemanticBuildStats> {
    const semantic = await this.getSemantic();
    if (!semantic) {
      throw new Error('Semantic index unavailable: index a directory first.');
    }
    return semantic.build(this.store.getFiles(), readFileText, onProgress);
  }

  /** Chunk-level semantic search — precise, LLM-ready hits with file/symbol/line info. */
  public async semanticSearch(query: string, options: SemanticSearchOptions = {}): Promise<SemanticHit[]> {
    const semantic = await this.getSemantic();
    if (!semantic) {
      throw new Error('Semantic index unavailable: index a directory first.');
    }
    const matches = await semantic.search(query, options.topK ?? 12, options.minSimilarity ?? 0.25);
    return this.toSemanticHits(matches, options.includeSnippets ?? true);
  }

  /** True when a semantic index with vectors exists for the indexed directory. */
  public async hasSemanticIndex(): Promise<boolean> {
    const semantic = await this.getSemantic();
    return semantic?.hasVectors() ?? false;
  }

  /** Delete the persisted semantic index for the indexed directory. */
  public async wipeSemanticIndex(): Promise<void> {
    const semantic = await this.getSemantic();
    semantic?.wipe();
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

  /** Lazily open the per-repo semantic index (vector store + provider chain). */
  private async getSemantic(): Promise<HeadlessSemanticIndex | undefined> {
    if (!this.root) return undefined;
    this.semantic ??= await HeadlessSemanticIndex.open(this.root, this.semanticConfig);
    return this.semantic;
  }

  private async toSemanticHits(matches: ChunkMatch[], includeSnippets: boolean): Promise<SemanticHit[]> {
    const files = new Map(this.store.getFiles().map((file) => [file.path, file]));
    const hits: SemanticHit[] = [];
    for (const match of matches) {
      const hit: SemanticHit = {
        path: match.path,
        symbol: match.symbol,
        kind: match.kind,
        startLine: match.startLine,
        endLine: match.endLine,
        similarity: Number(match.similarity.toFixed(4)),
      };
      if (includeSnippets) {
        const file = files.get(match.path);
        const text = file ? await readFileText(file) : undefined;
        if (text !== undefined) {
          const lines = text.split(/\r\n|\r|\n/).slice(match.startLine - 1, Math.min(match.endLine, match.startLine + 11));
          hit.snippet = lines.join('\n');
        }
      }
      hits.push(hit);
    }
    return hits;
  }
}

/** Read a graph file's current on-disk text via its file:// uri (skip when unreadable). */
async function readFileText(file: GraphweftFile): Promise<string | undefined> {
  try {
    return await fs.readFile(fileURLToPath(file.uri), 'utf8');
  } catch {
    return undefined;
  }
}

