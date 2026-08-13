import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EmbeddingProvider } from '../semantic/embeddingProvider';
import { resolveLocalModel, splitBatchOutput, DEFAULT_LOCAL_MODEL, LocalEmbeddingProvider } from '../semantic/localEmbeddingProvider';
import { resolveEmbeddingProvider, EmbeddingProviderFactories } from '../semantic/providerChain';
import { repoCacheDir, SqliteVectorStore } from '../semantic/sqliteVectorStore';
import { CodeChunk } from '../semantic/codeChunker';

function chunk(partial: Partial<CodeChunk> & { id: string }): CodeChunk {
  return {
    id: partial.id,
    path: partial.path ?? 'a.ts',
    kind: partial.kind ?? 'symbol',
    symbol: partial.symbol,
    startLine: partial.startLine ?? 1,
    endLine: partial.endLine ?? 5,
    text: partial.text ?? 'text',
    hash: partial.hash ?? 'h1',
  };
}

function fakeProvider(id: string, available: boolean): EmbeddingProvider {
  return {
    id,
    isAvailable: async () => available,
    embed: async (texts) => texts.map(() => [1, 0]),
  };
}

async function run(): Promise<void> {
  // --- provider chain resolution ---

  {
    // auto: local wins when available.
    const factories: EmbeddingProviderFactories = {
      createLocal: () => fakeProvider('local::m', true),
      createOllama: () => fakeProvider('ollama::m', true),
    };
    const provider = await resolveEmbeddingProvider({ runtime: 'auto' }, factories);
    assert.strictEqual(provider?.id, 'local::m', 'auto prefers the bundled runtime');
  }

  {
    // auto: falls back to Ollama only when configured AND local is unavailable.
    const factories: EmbeddingProviderFactories = {
      createLocal: () => fakeProvider('local::m', false),
      createOllama: () => fakeProvider('ollama::m', true),
    };
    const withoutConfig = await resolveEmbeddingProvider({ runtime: 'auto' }, factories);
    assert.strictEqual(withoutConfig, undefined, 'no silent fallback to an unconfigured server');
    const withConfig = await resolveEmbeddingProvider({ runtime: 'auto', ollama: { endpoint: 'http://localhost:11434' } }, factories);
    assert.strictEqual(withConfig?.id, 'ollama::m', 'configured Ollama used when local unavailable');
  }

  {
    // explicit runtime choices are strict.
    const factories: EmbeddingProviderFactories = {
      createLocal: () => fakeProvider('local::m', false),
      createOllama: () => fakeProvider('ollama::m', true),
    };
    assert.strictEqual(
      await resolveEmbeddingProvider({ runtime: 'local' }, factories),
      undefined,
      'runtime=local never falls back to a server',
    );
    const ollama = await resolveEmbeddingProvider({ runtime: 'ollama' }, factories);
    assert.strictEqual(ollama?.id, 'ollama::m', 'runtime=ollama skips local');
    assert.strictEqual(await resolveEmbeddingProvider({ runtime: 'off' }, factories), undefined, 'runtime=off disables');
  }

  {
    // factory throwing (invalid endpoint) is handled as unavailable.
    const factories: EmbeddingProviderFactories = {
      createLocal: () => fakeProvider('local::m', false),
      createOllama: () => {
        throw new Error('non-loopback endpoint');
      },
    };
    const provider = await resolveEmbeddingProvider({ runtime: 'ollama' }, factories);
    assert.strictEqual(provider, undefined);
  }

  // --- local provider pieces (no model download) ---

  {
    assert.strictEqual(resolveLocalModel('custom/model'), 'custom/model');
    delete process.env.CODEGRAPH_EMBED_MODEL;
    assert.strictEqual(resolveLocalModel(), DEFAULT_LOCAL_MODEL);
    process.env.CODEGRAPH_EMBED_MODEL = 'env/model';
    assert.strictEqual(resolveLocalModel(), 'env/model');
    delete process.env.CODEGRAPH_EMBED_MODEL;
  }

  {
    // batch tensor splitting.
    const vectors = splitBatchOutput(Float32Array.from([1, 2, 3, 4, 5, 6]), [2, 3], 2);
    assert.deepStrictEqual(vectors, [
      [1, 2, 3],
      [4, 5, 6],
    ]);
    assert.throws(() => splitBatchOutput(Float32Array.from([1, 2]), [2, 3], 2), /unexpected tensor shape/);
  }

  {
    // provider embeds through an injected (fake) transformers module — no download.
    const calls: string[][] = [];
    const provider = new LocalEmbeddingProvider({ model: 'test/model', cacheDir: 'unused' }, async () => ({
      env: {},
      pipeline: async () =>
        (async (texts: string[]) => {
          calls.push(texts);
          return { data: Float32Array.from(texts.flatMap((_, i) => [i + 1, 0])), dims: [texts.length, 2] };
        }) as never,
    }));
    assert.strictEqual(provider.id, 'local::test/model');
    assert.ok(await provider.isAvailable());
    const vectors = await provider.embed(['a', 'b', 'c']);
    assert.strictEqual(vectors.length, 3);
    assert.deepStrictEqual(vectors[1], [2, 0]);
    assert.strictEqual(calls.length, 1, 'small batch embedded in one pipeline call');
  }

  {
    // unavailable when the dependency cannot load.
    const provider = new LocalEmbeddingProvider({}, async () => {
      throw new Error('MODULE_NOT_FOUND');
    });
    assert.strictEqual(await provider.isAvailable(), false);
  }

  // --- sqlite vector store ---

  {
    const store = await SqliteVectorStore.openInMemory();
    store.reset('local::m');
    store.upsert(chunk({ id: 'a.ts#symbol:f@1', path: 'a.ts', symbol: 'f', hash: 'h1' }), [1, 0, 0]);
    store.upsert(chunk({ id: 'b.ts#symbol:g@1', path: 'b.ts', symbol: 'g', hash: 'h2' }), [0.9, 0.1, 0]);
    store.upsert(chunk({ id: 'c.ts#symbol:h@1', path: 'c.ts', symbol: 'h', hash: 'h3' }), [0, 1, 0]);

    const matches = store.search([1, 0, 0], 5, 0.2);
    assert.strictEqual(matches[0].path, 'a.ts');
    assert.strictEqual(matches[0].symbol, 'f');
    assert.strictEqual(matches[1].path, 'b.ts');
    assert.ok(!matches.some((m) => m.path === 'c.ts'), 'orthogonal filtered by minSimilarity');

    const hashes = store.getChunkHashes();
    assert.strictEqual(hashes.get('a.ts#symbol:f@1'), 'h1');

    const dropped = store.retainOnly(new Set(['a.ts#symbol:f@1']));
    assert.strictEqual(dropped, 2);
    assert.strictEqual(store.stats().chunks, 1);

    store.reset('local::other');
    assert.strictEqual(store.stats().chunks, 0, 'reset wipes vectors');
    assert.strictEqual(store.getProviderId(), 'local::other');
  }

  {
    // disk round-trip.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-vec-'));
    process.env.CODEGRAPH_CACHE_DIR = temp;
    try {
      const repo = path.join(temp, 'repo');
      const store = await SqliteVectorStore.open(repo);
      store.reset('local::m');
      store.upsert(chunk({ id: 'x#symbol:s@1', path: 'x.ts', symbol: 's', startLine: 3, endLine: 9, hash: 'hx' }), [0.25, -1.5]);
      store.persist();

      const reopened = await SqliteVectorStore.open(repo);
      assert.strictEqual(reopened.getProviderId(), 'local::m');
      assert.strictEqual(reopened.stats().chunks, 1);
      const [match] = reopened.search([0.25, -1.5], 1, 0.5);
      assert.strictEqual(match.id, 'x#symbol:s@1');
      assert.strictEqual(match.startLine, 3);
      assert.strictEqual(match.endLine, 9);
      assert.ok(match.similarity > 0.999, 'identical vector similarity ~1');

      // per-repo cache dirs are stable and distinct.
      assert.strictEqual(repoCacheDir(repo), repoCacheDir(repo));
      assert.notStrictEqual(repoCacheDir(repo), repoCacheDir(path.join(temp, 'other')));

      reopened.wipe();
      const empty = await SqliteVectorStore.open(repo);
      assert.strictEqual(empty.stats().chunks, 0, 'wipe removes the on-disk database');
    } finally {
      delete process.env.CODEGRAPH_CACHE_DIR;
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  console.log('semanticLocal.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
