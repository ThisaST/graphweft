import * as assert from 'assert';
import { validateLocalEndpoint } from '../semantic/embeddingProvider';
import { buildSemanticDoc, hashDoc } from '../semantic/semanticDoc';
import { decodeVector, encodeVector, VectorIndex } from '../semantic/vectorIndex';
import { createHintMatches, applyContextualFileBoosts } from '../graph/graphRanker';
import { CodeGraphFile } from '../graph/graphTypes';

// --- endpoint validation (the privacy gate) ---

(function acceptsLoopbackOnly(): void {
  assert.ok(validateLocalEndpoint('http://localhost:11434'), 'localhost ok');
  assert.ok(validateLocalEndpoint('http://127.0.0.1:8080'), '127.0.0.1 ok');
  assert.ok(validateLocalEndpoint('http://[::1]:11434'), 'ipv6 loopback ok');
  assert.strictEqual(validateLocalEndpoint('https://api.openai.com/v1'), undefined, 'remote rejected');
  assert.strictEqual(validateLocalEndpoint('http://192.168.1.10:11434'), undefined, 'LAN rejected');
  assert.strictEqual(validateLocalEndpoint('ftp://localhost'), undefined, 'non-http rejected');
  assert.strictEqual(validateLocalEndpoint('not a url'), undefined, 'garbage rejected');
})();

// --- vector index math + round-trip ---

(function cosineSearchRanksByAngle(): void {
  const index = new VectorIndex('p');
  index.upsert({ path: 'a.ts', hash: 'h', vector: Float32Array.from([1, 0, 0]) });
  index.upsert({ path: 'b.ts', hash: 'h', vector: Float32Array.from([0.9, 0.1, 0]) });
  index.upsert({ path: 'c.ts', hash: 'h', vector: Float32Array.from([0, 1, 0]) });

  const matches = index.search([1, 0, 0], 3, 0.2);
  assert.strictEqual(matches[0].path, 'a.ts');
  assert.strictEqual(matches[1].path, 'b.ts');
  assert.ok(!matches.some((m) => m.path === 'c.ts'), 'orthogonal vector filtered by minSimilarity');
  assert.ok(matches[0].similarity > 0.99);
})();

(function serializationRoundTrips(): void {
  const index = new VectorIndex('endpoint::model');
  index.upsert({ path: 'x.cs', hash: 'abc', vector: Float32Array.from([0.25, -1.5, 3.75]) });
  const restored = VectorIndex.deserialize(index.serialize());
  assert.strictEqual(restored.providerId, 'endpoint::model');
  const entry = restored.get('x.cs')!;
  assert.strictEqual(entry.hash, 'abc');
  assert.deepStrictEqual([...entry.vector], [0.25, -1.5, 3.75]);
})();

(function vectorEncodingRoundTrips(): void {
  const original = Float32Array.from([1.5, -2.25, 0, 1e-7]);
  const decoded = decodeVector(encodeVector(original));
  assert.deepStrictEqual([...decoded], [...original]);
})();

(function retainOnlyDropsDeletedFiles(): void {
  const index = new VectorIndex('p');
  index.upsert({ path: 'keep.ts', hash: 'h', vector: Float32Array.from([1]) });
  index.upsert({ path: 'gone.ts', hash: 'h', vector: Float32Array.from([1]) });
  index.retainOnly(new Set(['keep.ts']));
  assert.ok(index.get('keep.ts'));
  assert.strictEqual(index.get('gone.ts'), undefined);
})();

// --- semantic doc building (graph-aware chunking) ---

function file(partial: Partial<CodeGraphFile> & { path: string }): CodeGraphFile {
  return {
    uri: `file:///${partial.path}`,
    path: partial.path,
    imports: partial.imports ?? [],
    symbols: partial.symbols ?? [],
    decorators: partial.decorators ?? [],
    moduleName: partial.moduleName,
  };
}

(function docCapturesStructure(): void {
  const doc = buildSemanticDoc(
    file({
      path: 'Services/UserService.cs',
      moduleName: 'Axon.Services',
      symbols: [
        { id: '1', name: 'UserService', type: 'class', filePath: 'Services/UserService.cs', lineRange: { start: 1, end: 9 }, signature: 'class UserService', exported: true, decorators: [], tags: [] },
      ],
      imports: [{ specifier: 'Axon.Data', importedNames: [], isTypeOnly: false, line: 1 }],
    }),
  );
  assert.ok(doc.includes('file: Services/UserService.cs'));
  assert.ok(doc.includes('module: Axon.Services'));
  assert.ok(doc.includes('class UserService'));
  assert.ok(doc.includes('imports: Axon.Data'));
})();

(function docHashIsStableAndSensitive(): void {
  const a = file({ path: 'a.ts' });
  assert.strictEqual(hashDoc(buildSemanticDoc(a)), hashDoc(buildSemanticDoc(a)), 'same input, same hash');
  const b = file({ path: 'a.ts', moduleName: 'M' });
  assert.notStrictEqual(hashDoc(buildSemanticDoc(a)), hashDoc(buildSemanticDoc(b)), 'changed doc, changed hash');
})();

// --- hybrid ranking integration ---

(function semanticMatchSeedsAndBoosts(): void {
  const files = [file({ path: 'src/backoff.ts' }), file({ path: 'src/other.ts' })];
  const hints = { semanticMatches: [{ path: 'src/backoff.ts', similarity: 0.85 }] };

  // Seeding: a zero-keyword file must enter the candidate set via hints.
  const seeded = createHintMatches(files, hints);
  assert.ok(seeded.some((r) => r.file.path === 'src/backoff.ts'), 'semantic match seeds candidates');

  // Boosting: similarity scales into the score with a visible reason.
  const boosted = applyContextualFileBoosts(
    [{ file: files[0], score: 1, reasons: [] }],
    hints,
  );
  assert.strictEqual(boosted[0].score, 1 + Math.round(0.85 * 40));
  assert.ok(boosted[0].reasons.some((r) => r.startsWith('semantic match')), 'reason recorded');
})();

console.log('semantic.test.ts passed');
