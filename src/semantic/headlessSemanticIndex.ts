/**
 * Headless semantic index for CLI / MCP hosts — the orchestrator that ties together the
 * AST-aware chunker, the embedding provider chain (bundled ONNX → Ollama), and the per-repo
 * sqlite vector store. No vscode imports.
 *
 * Incremental by construction: chunks carry content hashes, the store remembers them, and a
 * build only embeds chunks whose hash changed since the last run — a re-run on an unchanged
 * repo embeds nothing and finishes in milliseconds.
 */
import { GraphweftFile } from '../graph/graphTypes';
import { chunkFile, CodeChunk } from './codeChunker';
import { EmbeddingProvider } from './embeddingProvider';
import { EmbeddingChainConfig, resolveEmbeddingProvider } from './providerChain';
import { ChunkMatch, SqliteVectorStore } from './sqliteVectorStore';

const EMBED_BATCH = 16;

export interface SemanticBuildStats {
  providerId: string;
  chunks: number;
  embedded: number;
  reused: number;
  pruned: number;
}

export interface SemanticFileMatch {
  path: string;
  similarity: number;
}

/** Reads a file's current text; return undefined to skip (deleted/binary). */
export type FileTextReader = (file: GraphweftFile) => Promise<string | undefined>;

export class HeadlessSemanticIndex {
  public constructor(
    private readonly store: SqliteVectorStore,
    private readonly provider: EmbeddingProvider | undefined,
  ) {}

  /**
   * Open the per-repo vector store and resolve an embedding provider. Always returns an
   * index object — callers check `canEmbed()` / `hasVectors()` for what's possible.
   */
  public static async open(repoRoot: string, config?: EmbeddingChainConfig): Promise<HeadlessSemanticIndex> {
    const [store, provider] = await Promise.all([
      SqliteVectorStore.open(repoRoot),
      resolveEmbeddingProvider(config),
    ]);
    return new HeadlessSemanticIndex(store, provider);
  }

  /** True when an embedding backend is available (build + query possible). */
  public canEmbed(): boolean {
    return this.provider !== undefined;
  }

  /** True when the store holds vectors from the current provider (or any, when no provider). */
  public hasVectors(): boolean {
    const stats = this.store.stats();
    if (stats.chunks === 0) return false;
    return this.provider === undefined || stats.providerId === this.provider.id;
  }

  public providerId(): string | undefined {
    return this.provider?.id;
  }

  public stats(): ReturnType<SqliteVectorStore['stats']> {
    return this.store.stats();
  }

  /**
   * (Re)build incrementally from the graph index: chunk every file, embed only chunks whose
   * hash is new or changed, drop chunks that no longer exist, persist to disk.
   */
  public async build(
    files: GraphweftFile[],
    readText: FileTextReader,
    onProgress?: (embedded: number, total: number) => void,
  ): Promise<SemanticBuildStats> {
    const provider = this.requireProvider();
    if (files.length === 0) {
      throw new Error('No graph index to embed. Build the code graph first.');
    }

    if (this.store.getProviderId() !== provider.id) {
      // Different model/backend — stored vectors are incomparable; start over.
      this.store.reset(provider.id);
    }

    const chunks: CodeChunk[] = [];
    for (const file of files) {
      const text = await readText(file);
      if (text === undefined) continue;
      chunks.push(...chunkFile(file, text));
    }

    const known = this.store.getChunkHashes();
    const pending = chunks.filter((chunk) => known.get(chunk.id) !== chunk.hash);

    let embedded = 0;
    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const batch = pending.slice(i, i + EMBED_BATCH);
      const vectors = await provider.embed(batch.map((chunk) => chunk.text));
      batch.forEach((chunk, j) => this.store.upsert(chunk, vectors[j]));
      embedded += batch.length;
      onProgress?.(embedded, pending.length);
    }

    const pruned = this.store.retainOnly(new Set(chunks.map((chunk) => chunk.id)));
    this.store.persist();

    return {
      providerId: provider.id,
      chunks: chunks.length,
      embedded,
      reused: chunks.length - embedded,
      pruned,
    };
  }

  /**
   * Chunk-level similarity search. Requires vectors built with the current provider —
   * otherwise throws with guidance (hosts surface the message directly).
   */
  public async search(query: string, topK = 12, minSimilarity = 0.25): Promise<ChunkMatch[]> {
    const provider = this.requireProvider();
    const stats = this.store.stats();
    if (stats.chunks === 0) {
      throw new Error('Semantic index is empty. Run `graphweft embed` first.');
    }
    if (stats.providerId !== provider.id) {
      throw new Error(
        `Semantic index was built with "${stats.providerId}" but the current backend is "${provider.id}". ` +
          'Run `graphweft embed` to rebuild.',
      );
    }
    const [queryVector] = await provider.embed([query]);
    return this.store.search(queryVector, topK, minSimilarity);
  }

  /**
   * Best-effort variant for hybrid retrieval: quiet empty result instead of errors, so graph
   * search works identically whether or not embeddings exist.
   */
  public async trySearch(query: string, topK = 12, minSimilarity = 0.25): Promise<ChunkMatch[]> {
    if (!this.provider || !this.hasVectors()) return [];
    try {
      return await this.search(query, topK, minSimilarity);
    } catch {
      return [];
    }
  }

  public wipe(): void {
    this.store.wipe();
  }

  private requireProvider(): EmbeddingProvider {
    if (!this.provider) {
      throw new Error(
        'No embedding backend available. The bundled model requires @huggingface/transformers ' +
          '(bundled with the CLI); alternatively configure a local Ollama endpoint.',
      );
    }
    return this.provider;
  }
}

/**
 * Aggregate chunk matches to file-level scores for the retriever's RRF fusion:
 * a file's semantic score is its best chunk's similarity (max pooling), which rewards one
 * strongly-matching function over many weak matches spread across a file.
 */
export function toFileMatches(matches: ChunkMatch[]): SemanticFileMatch[] {
  const byPath = new Map<string, number>();
  for (const match of matches) {
    const existing = byPath.get(match.path);
    if (existing === undefined || match.similarity > existing) byPath.set(match.path, match.similarity);
  }
  return Array.from(byPath.entries())
    .map(([path, similarity]) => ({ path, similarity }))
    .sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path));
}
