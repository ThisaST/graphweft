import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraphEngine } from '../node/codegraphEngine';
import { EmbeddingProvider } from '../semantic/embeddingProvider';
import { toFileMatches } from '../semantic/headlessSemanticIndex';
import { EmbeddingProviderFactories } from '../semantic/providerChain';

/**
 * Deterministic fake embedding: axis 0 = retry/backoff concepts, axis 1 = auth concepts,
 * axis 2 = everything else. Good enough to prove chunk retrieval and hybrid fusion flow
 * end-to-end without downloading a model.
 */
function fakeEmbed(text: string): number[] {
  const lower = text.toLowerCase();
  const retry = /retry|backoff|attempt/.test(lower) ? 1 : 0;
  const auth = /auth|login|credential/.test(lower) ? 1 : 0;
  const other = retry === 0 && auth === 0 ? 1 : 0;
  const norm = Math.sqrt(retry + auth + other) || 1;
  return [retry / norm, auth / norm, other / norm];
}

const fakeFactories: EmbeddingProviderFactories = {
  createLocal: (): EmbeddingProvider => ({
    id: 'local::fake-model',
    isAvailable: async () => true,
    embed: async (texts) => texts.map(fakeEmbed),
  }),
  createOllama: () => {
    throw new Error('not used');
  },
};

async function run(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-eng-'));
  process.env.CODEGRAPH_CACHE_DIR = path.join(temp, 'cache');
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });

  fs.writeFileSync(
    path.join(repo, 'src', 'httpClient.ts'),
    [
      'export function fetchWithRetry(url: string, attempts: number): Promise<Response> {',
      '  // exponential backoff between attempts',
      '  return retryLoop(url, attempts);',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repo, 'src', 'auth.ts'),
    [
      'export class AuthService {',
      '  login(credentials: string): boolean {',
      '    return credentials.length > 0;',
      '  }',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(repo, 'src', 'misc.ts'), 'export const helper = 1;\n');

  try {
    const engine = new CodeGraphEngine({ semantic: { factories: fakeFactories } });
    await engine.indexDirectory(repo);

    // --- build ---
    assert.strictEqual(await engine.hasSemanticIndex(), false, 'no vectors before build');
    const stats = await engine.buildSemanticIndex();
    assert.strictEqual(stats.providerId, 'local::fake-model');
    assert.ok(stats.chunks >= 3, 'chunks for all files');
    assert.strictEqual(stats.embedded, stats.chunks, 'first build embeds everything');
    assert.ok(await engine.hasSemanticIndex(), 'vectors exist after build');

    // --- incremental rebuild: nothing changed, nothing re-embedded ---
    const rebuild = await engine.buildSemanticIndex();
    assert.strictEqual(rebuild.embedded, 0, 'unchanged repo embeds nothing');
    assert.strictEqual(rebuild.reused, rebuild.chunks);

    // --- chunk-level search with precise locations ---
    const hits = await engine.semanticSearch('how do we retry failed requests with backoff');
    assert.ok(hits.length > 0, 'semantic hits found');
    assert.strictEqual(hits[0].path, 'src/httpClient.ts', 'retry chunk ranks first');
    assert.ok(hits[0].startLine >= 1 && hits[0].endLine >= hits[0].startLine, 'line range present');
    assert.ok(hits[0].snippet?.includes('fetchWithRetry'), 'snippet carries the code');
    assert.ok(!hits.some((h) => h.path === 'src/auth.ts' && h.similarity > 0.9), 'auth not a strong retry match');

    // --- hybrid search fuses semantic into file ranking ---
    const hybrid = await engine.searchHybrid('retry with backoff');
    assert.ok(hybrid.files.length > 0);
    assert.strictEqual(hybrid.files[0].path, 'src/httpClient.ts', 'hybrid ranks retry file first');
    assert.ok(hybrid.semanticHits && hybrid.semanticHits.length > 0, 'hybrid result exposes chunk hits');

    // --- incremental update: change a file, only its chunks re-embed ---
    fs.writeFileSync(
      path.join(repo, 'src', 'auth.ts'),
      [
        'export class AuthService {',
        '  login(credentials: string): boolean {',
        '    return credentials.trim().length > 3;',
        '  }',
        '}',
      ].join('\n'),
    );
    await engine.indexDirectory(repo);
    const incremental = await engine.buildSemanticIndex();
    assert.ok(incremental.embedded > 0, 'changed file re-embedded');
    assert.ok(incremental.embedded < incremental.chunks, 'unchanged files reused');

    // --- deleted files are pruned ---
    fs.rmSync(path.join(repo, 'src', 'misc.ts'));
    await engine.indexDirectory(repo);
    const afterDelete = await engine.buildSemanticIndex();
    assert.ok(afterDelete.pruned > 0, 'chunks of deleted file pruned');

    // --- wipe ---
    await engine.wipeSemanticIndex();
    assert.strictEqual(await engine.hasSemanticIndex(), false, 'wipe clears the index');

    // --- file aggregation helper: max pooling ---
    const fileMatches = toFileMatches([
      { id: '1', path: 'a.ts', kind: 'symbol', startLine: 1, endLine: 2, similarity: 0.4 },
      { id: '2', path: 'a.ts', kind: 'symbol', startLine: 5, endLine: 9, similarity: 0.9 },
      { id: '3', path: 'b.ts', kind: 'symbol', startLine: 1, endLine: 2, similarity: 0.6 },
    ]);
    assert.deepStrictEqual(fileMatches, [
      { path: 'a.ts', similarity: 0.9 },
      { path: 'b.ts', similarity: 0.6 },
    ]);

    console.log('semanticEngine.test.ts passed');
  } finally {
    delete process.env.CODEGRAPH_CACHE_DIR;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
