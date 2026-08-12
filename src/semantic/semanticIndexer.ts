/**
 * Orchestrates CodeGraph's opt-in local semantic index: builds per-file docs from the graph
 * store, embeds changed ones via the local (loopback-only) provider, persists vectors to
 * extension storage, and answers similarity queries that feed the hybrid retriever.
 *
 * Everything is best-effort: if the local server is down or the feature is off, callers get
 * empty results and CodeGraph behaves exactly as before (pure lexical+graph retrieval).
 */
import * as vscode from 'vscode';
import { GraphStore } from '../graph/graphStore';
import { EmbeddingProvider, OllamaEmbeddingProvider } from './embeddingProvider';
import { buildSemanticDoc, hashDoc } from './semanticDoc';
import { SemanticMatch, SerializedIndex, VectorIndex } from './vectorIndex';

const INDEX_FILE = 'semantic-index.json';
const EMBED_BATCH_SIZE = 32;

export interface SemanticBuildResult {
  total: number;
  embedded: number;
  reused: number;
}

export class SemanticIndexer {
  private index?: VectorIndex;
  private loadAttempted = false;

  public constructor(
    private readonly store: GraphStore,
    private readonly storageUri: vscode.Uri,
  ) {}

  /** Feature flag + provider from settings. Undefined when disabled or misconfigured. */
  public getProvider(): EmbeddingProvider | undefined {
    const config = vscode.workspace.getConfiguration('codegraph');
    if (!config.get<boolean>('semanticSearch.enabled', false)) return undefined;
    try {
      return new OllamaEmbeddingProvider({
        endpoint: config.get<string>('semanticSearch.endpoint', 'http://localhost:11434'),
        model: config.get<string>('semanticSearch.model', 'nomic-embed-text'),
      });
    } catch {
      // Non-loopback endpoint configured — treat as disabled rather than ever calling out.
      return undefined;
    }
  }

  /**
   * (Re)build the semantic index incrementally: embed only files whose doc hash changed,
   * reuse stored vectors for the rest, drop vectors for deleted files. Progress is reported
   * via the optional callback (used by the build command's notification).
   */
  public async build(onProgress?: (done: number, total: number) => void): Promise<SemanticBuildResult> {
    const provider = this.getProvider();
    if (!provider) {
      throw new Error('Semantic search is disabled. Enable `codegraph.semanticSearch.enabled` first.');
    }
    if (!(await provider.isAvailable())) {
      throw new Error('Local embedding server is not reachable. Start Ollama (or compatible) and try again.');
    }

    const files = this.store.getFiles();
    if (files.length === 0) {
      throw new Error('No graph index yet. Run `CodeGraph: Build Local Index` first.');
    }

    let index = await this.loadIndex();
    if (index.providerId !== provider.id) {
      // Different endpoint/model — old vectors are incomparable; start fresh.
      index = new VectorIndex(provider.id);
    }

    const docs = files.map((file) => ({ path: file.path, doc: buildSemanticDoc(file) }));
    const pending = docs.filter(({ path, doc }) => index.get(path)?.hash !== hashDoc(doc));

    let embedded = 0;
    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await provider.embed(batch.map((b) => b.doc));
      batch.forEach((item, j) => {
        index.upsert({ path: item.path, hash: hashDoc(item.doc), vector: Float32Array.from(vectors[j]) });
      });
      embedded += batch.length;
      onProgress?.(embedded, pending.length);
    }

    index.retainOnly(new Set(docs.map((d) => d.path)));
    this.index = index;
    await this.persist(index);

    return { total: files.length, embedded, reused: files.length - embedded };
  }

  /**
   * Similarity search for the hybrid retriever. Best-effort and quiet: returns [] when the
   * feature is off, the index hasn't been built, or the local server is unreachable.
   */
  public async search(query: string, topK = 8): Promise<SemanticMatch[]> {
    const provider = this.getProvider();
    if (!provider) return [];

    const index = await this.loadIndex();
    if (index.size() === 0 || index.providerId !== provider.id) return [];

    try {
      const [queryVector] = await provider.embed([query]);
      return index.search(queryVector, topK);
    } catch {
      return [];
    }
  }

  /** True when semantic search is enabled and has a non-empty index to search. */
  public async isReady(): Promise<boolean> {
    if (!this.getProvider()) return false;
    return (await this.loadIndex()).size() > 0;
  }

  public async wipe(): Promise<void> {
    this.index = new VectorIndex();
    this.loadAttempted = true;
    try {
      await vscode.workspace.fs.delete(this.indexUri());
    } catch {
      // Already gone.
    }
  }

  private indexUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, INDEX_FILE);
  }

  private async loadIndex(): Promise<VectorIndex> {
    if (this.index) return this.index;
    if (!this.loadAttempted) {
      this.loadAttempted = true;
      try {
        const bytes = await vscode.workspace.fs.readFile(this.indexUri());
        const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as SerializedIndex;
        this.index = VectorIndex.deserialize(data);
      } catch {
        // Missing or corrupt — start empty; a build recreates it.
      }
    }
    this.index ??= new VectorIndex();
    return this.index;
  }

  private async persist(index: VectorIndex): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.storageUri);
    const payload = Buffer.from(JSON.stringify(index.serialize()), 'utf8');
    await vscode.workspace.fs.writeFile(this.indexUri(), payload);
  }
}
