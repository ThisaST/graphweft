/**
 * Bundled local embedding provider — runs an ONNX embedding model **in-process** via
 * `@huggingface/transformers` (transformers.js). No external server: the CLI/MCP host embeds
 * on its own. The model is NOT shipped with the package; it is downloaded once from the
 * Hugging Face Hub into a local cache dir (default `~/.codegraph/models`) and reused offline
 * after that. That one-time download is the only network access this provider ever performs —
 * code and queries never leave the machine.
 *
 * The heavyweight dependency is loaded with a lazy dynamic `import()`, so hosts that never
 * touch semantic search (in particular the VS Code extension, which uses the Ollama provider)
 * never pay for — or bundle — ONNX Runtime.
 *
 * The transformers.js module is injectable for tests, so everything here is unit-testable
 * without downloading a model.
 */
import * as os from 'os';
import * as path from 'path';
import { EmbeddingProvider } from './embeddingProvider';

/** Code-specific model, quantized ONNX (~160 MB download on first use). */
export const DEFAULT_LOCAL_MODEL = 'jinaai/jina-embeddings-v2-base-code';
/** Small general-purpose alternative (~25 MB) for constrained machines: */
export const FAST_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

export interface LocalEmbeddingConfig {
  /** HF Hub model id. Env override: CODEGRAPH_EMBED_MODEL. */
  model?: string;
  /** Where model weights are cached. Env override: CODEGRAPH_MODEL_CACHE. */
  cacheDir?: string;
  /** Called once when a model download starts (first run UX). */
  onDownload?: (model: string, cacheDir: string) => void;
}

export function defaultModelCacheDir(): string {
  return process.env.CODEGRAPH_MODEL_CACHE ?? path.join(os.homedir(), '.codegraph', 'models');
}

export function resolveLocalModel(model?: string): string {
  return model ?? process.env.CODEGRAPH_EMBED_MODEL ?? DEFAULT_LOCAL_MODEL;
}

/** Minimal surface of transformers.js we rely on — injectable for tests. */
export interface TransformersModule {
  env: { cacheDir?: string; allowLocalModels?: boolean; [key: string]: unknown };
  pipeline(
    task: 'feature-extraction',
    model: string,
    options?: Record<string, unknown>,
  ): Promise<FeatureExtractionPipeline>;
}

export interface FeatureExtractionPipeline {
  (texts: string[], options: { pooling: 'mean'; normalize: boolean }): Promise<{
    data: Float32Array | number[];
    dims: number[];
  }>;
}

export type TransformersLoader = () => Promise<TransformersModule>;

const defaultLoader: TransformersLoader = async () => {
  // Under CommonJS compilation this dynamic import becomes require(); transformers.js ships a
  // CJS node build (dist/transformers.node.cjs), so both module systems resolve it fine.
  const module = (await import('@huggingface/transformers')) as unknown;
  return module as TransformersModule;
};

const EMBED_BATCH = 16;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  public readonly id: string;
  private readonly model: string;
  private readonly cacheDir: string;
  private readonly load: TransformersLoader;
  private readonly onDownload?: (model: string, cacheDir: string) => void;
  private pipelinePromise?: Promise<FeatureExtractionPipeline>;

  public constructor(config: LocalEmbeddingConfig = {}, loader: TransformersLoader = defaultLoader) {
    this.model = resolveLocalModel(config.model);
    this.cacheDir = config.cacheDir ?? defaultModelCacheDir();
    this.load = loader;
    this.onDownload = config.onDownload;
    this.id = `local::${this.model}`;
  }

  /** True when transformers.js can be loaded (dependency present, platform supported). */
  public async isAvailable(): Promise<boolean> {
    try {
      await this.load();
      return true;
    } catch {
      return false;
    }
  }

  public async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipe = await this.getPipeline();
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const output = await pipe(batch, { pooling: 'mean', normalize: true });
      vectors.push(...splitBatchOutput(output.data, output.dims, batch.length));
    }
    return vectors;
  }

  private getPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= (async () => {
      const transformers = await this.load();
      transformers.env.cacheDir = this.cacheDir;
      this.onDownload?.(this.model, this.cacheDir);
      // dtype q8: quantized weights — ~4x smaller download, near-identical retrieval quality.
      return transformers.pipeline('feature-extraction', this.model, { dtype: 'q8' });
    })();
    return this.pipelinePromise;
  }
}

/** transformers.js returns one flat tensor [batch, dims]; split it into per-text vectors. */
export function splitBatchOutput(
  data: Float32Array | number[],
  dims: number[],
  expectedCount: number,
): number[][] {
  const [batch, width] = dims.length === 2 ? dims : [1, dims[dims.length - 1]];
  if (batch !== expectedCount || batch * width !== data.length) {
    throw new Error(`Local embedding model returned unexpected tensor shape [${dims.join(', ')}].`);
  }
  const vectors: number[][] = [];
  for (let i = 0; i < batch; i++) {
    vectors.push(Array.from(data.slice(i * width, (i + 1) * width)) as number[]);
  }
  return vectors;
}
