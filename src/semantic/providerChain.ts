/**
 * Provider resolution chain for semantic embeddings — decides which embedding backend a
 * headless host (CLI / MCP server) uses:
 *
 *   1. bundled local ONNX runtime (default; zero setup, model auto-downloaded on first use)
 *   2. Ollama-compatible loopback server, when the user configured an endpoint
 *   3. disabled — semantic features quietly no-op and retrieval stays lexical+graph
 *
 * Explicit choice always wins: `runtime: 'ollama'` skips the bundled model entirely, and
 * `runtime: 'local'` never silently falls back to a server the user didn't ask for.
 * Factories are injectable so the chain is unit-testable without ONNX or a server.
 */
import { EmbeddingProvider, EmbeddingProviderConfig, OllamaEmbeddingProvider } from './embeddingProvider';
import { LocalEmbeddingConfig, LocalEmbeddingProvider } from './localEmbeddingProvider';

export type EmbeddingRuntime = 'auto' | 'local' | 'ollama' | 'off';

export interface EmbeddingChainConfig {
  /** Which backend to use. Default 'auto' (local first, then Ollama when configured). */
  runtime?: EmbeddingRuntime;
  /** Options for the bundled local runtime. */
  local?: LocalEmbeddingConfig;
  /** Ollama endpoint+model; only consulted when set (or runtime is 'ollama'). */
  ollama?: Partial<EmbeddingProviderConfig>;
  /** Provider construction override — used by tests to inject fakes. */
  factories?: EmbeddingProviderFactories;
}

export interface EmbeddingProviderFactories {
  createLocal(config: LocalEmbeddingConfig): EmbeddingProvider;
  createOllama(config: EmbeddingProviderConfig): EmbeddingProvider;
}

const defaultFactories: EmbeddingProviderFactories = {
  createLocal: (config) => new LocalEmbeddingProvider(config),
  createOllama: (config) => new OllamaEmbeddingProvider(config),
};

const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';

/**
 * Resolve the first *available* provider in the chain, or undefined when semantic search
 * should stay off. Availability means: local → transformers.js loads; ollama → server answers.
 */
export async function resolveEmbeddingProvider(
  config: EmbeddingChainConfig = {},
  factories?: EmbeddingProviderFactories,
): Promise<EmbeddingProvider | undefined> {
  const active = factories ?? config.factories ?? defaultFactories;
  const runtime = config.runtime ?? (process.env.GRAPHWEFT_EMBED_RUNTIME as EmbeddingRuntime | undefined) ?? 'auto';
  if (runtime === 'off') return undefined;

  if (runtime === 'local' || runtime === 'auto') {
    const local = active.createLocal(config.local ?? {});
    if (await local.isAvailable()) return local;
    if (runtime === 'local') return undefined;
  }

  const wantsOllama = runtime === 'ollama' || (runtime === 'auto' && config.ollama !== undefined);
  if (wantsOllama) {
    try {
      const ollama = active.createOllama({
        endpoint: config.ollama?.endpoint ?? DEFAULT_OLLAMA_ENDPOINT,
        model: config.ollama?.model ?? DEFAULT_OLLAMA_MODEL,
      });
      if (await ollama.isAvailable()) return ollama;
    } catch {
      // Invalid (non-loopback) endpoint — treated as unavailable, never called.
    }
  }

  return undefined;
}
