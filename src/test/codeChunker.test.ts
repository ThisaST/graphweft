import * as assert from 'assert';
import { chunkFile, hashChunk } from '../semantic/codeChunker';
import { CodeGraphFile, CodeSymbol } from '../graph/graphTypes';

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

function symbol(partial: Partial<CodeSymbol> & { name: string; lineRange: { start: number; end: number } }): CodeSymbol {
  return {
    id: partial.id ?? partial.name,
    name: partial.name,
    type: partial.type ?? 'function',
    filePath: partial.filePath ?? 'a.ts',
    lineRange: partial.lineRange,
    signature: partial.signature ?? partial.name,
    exported: partial.exported ?? true,
    decorators: partial.decorators ?? [],
    parentName: partial.parentName,
    tags: partial.tags ?? [],
  };
}

// --- symbol chunks ---

(function symbolChunksCarrySituatingHeaderAndBody(): void {
  const text = ['import x from "y";', '', 'export function login(user: string): boolean {', '  return user.length > 0;', '}'].join('\n');
  const f = file({
    path: 'src/auth.ts',
    symbols: [symbol({ name: 'login', signature: 'login(user: string): boolean', lineRange: { start: 3, end: 5 } })],
  });

  const chunks = chunkFile(f, text);
  const sym = chunks.find((c) => c.kind === 'symbol');
  assert.ok(sym, 'symbol chunk exists');
  assert.strictEqual(sym!.symbol, 'login');
  assert.strictEqual(sym!.startLine, 3);
  assert.strictEqual(sym!.endLine, 5);
  assert.ok(sym!.text.includes('src/auth.ts'), 'header names the file');
  assert.ok(sym!.text.includes('login(user: string): boolean'), 'header carries the signature');
  assert.ok(sym!.text.includes('return user.length > 0;'), 'body carries the code');
})();

(function methodsInsideIndexedClassAreNotDuplicated(): void {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  const f = file({
    path: 'src/service.ts',
    symbols: [
      symbol({ name: 'UserService', type: 'class', lineRange: { start: 1, end: 10 } }),
      symbol({ name: 'save', type: 'method', parentName: 'UserService', lineRange: { start: 4, end: 6 } }),
    ],
  });

  const chunks = chunkFile(f, text).filter((c) => c.kind === 'symbol');
  assert.strictEqual(chunks.length, 1, 'method covered by class chunk is skipped');
  assert.strictEqual(chunks[0].symbol, 'UserService');
})();

(function orphanMethodsStillGetChunks(): void {
  const text = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join('\n');
  const f = file({
    path: 'src/partial.cs',
    symbols: [symbol({ name: 'Handle', type: 'method', parentName: 'NotIndexed', lineRange: { start: 2, end: 4 } })],
  });

  const chunks = chunkFile(f, text).filter((c) => c.kind === 'symbol');
  assert.strictEqual(chunks.length, 1, 'method without indexed parent kept');
  assert.strictEqual(chunks[0].symbol, 'NotIndexed.Handle', 'qualified with parent');
})();

// --- file summary chunk ---

(function everyFileGetsASummaryChunk(): void {
  const f = file({ path: 'src/empty.ts' });
  const chunks = chunkFile(f, '');
  assert.strictEqual(chunks.filter((c) => c.kind === 'file-summary').length, 1);
  assert.ok(chunks[0].text.includes('file: src/empty.ts'), 'summary is the structured semantic doc');
})();

// --- fallback windows ---

(function symbollessFilesFallBackToWindows(): void {
  const lines = Array.from({ length: 130 }, (_, i) => `key${i}: value${i}`);
  const f = file({ path: 'config/app.yaml' });

  const windows = chunkFile(f, lines.join('\n'), { windowLines: 60, windowOverlap: 10 }).filter((c) => c.kind === 'window');
  assert.ok(windows.length >= 2, 'long file split into multiple windows');
  assert.strictEqual(windows[0].startLine, 1);
  assert.strictEqual(windows[0].endLine, 60);
  assert.strictEqual(windows[1].startLine, 51, 'windows overlap');
  assert.ok(windows[windows.length - 1].endLine === 130, 'last window reaches the end');
})();

(function filesWithSymbolsGetNoWindows(): void {
  const text = 'export const a = 1;\n';
  const f = file({ path: 'a.ts', symbols: [symbol({ name: 'a', lineRange: { start: 1, end: 1 } })] });
  assert.strictEqual(chunkFile(f, text).filter((c) => c.kind === 'window').length, 0);
})();

// --- caps and hashing ---

(function bodyIsCappedAtMaxChars(): void {
  const longLine = 'x'.repeat(5000);
  const f = file({ path: 'big.ts', symbols: [symbol({ name: 'big', lineRange: { start: 1, end: 1 } })] });
  const sym = chunkFile(f, longLine, { maxChunkChars: 100 }).find((c) => c.kind === 'symbol')!;
  assert.ok(sym.text.length < 400, 'body truncated');
  assert.ok(sym.text.includes('…truncated'));
})();

(function chunkCountIsCapped(): void {
  const many = Array.from({ length: 300 }, (_, i) => symbol({ name: `f${i}`, lineRange: { start: i + 1, end: i + 1 } }));
  const text = Array.from({ length: 300 }, () => 'line').join('\n');
  const chunks = chunkFile(file({ path: 'gen.ts', symbols: many }), text, { maxChunksPerFile: 50 });
  assert.strictEqual(chunks.filter((c) => c.kind === 'symbol').length, 50);
})();

(function hashesAreStableAndSensitive(): void {
  assert.strictEqual(hashChunk('same'), hashChunk('same'));
  assert.notStrictEqual(hashChunk('a'), hashChunk('b'));

  const f = file({ path: 'a.ts', symbols: [symbol({ name: 'f', lineRange: { start: 1, end: 1 } })] });
  const first = chunkFile(f, 'const f = 1;');
  const second = chunkFile(f, 'const f = 1;');
  assert.deepStrictEqual(first.map((c) => c.hash), second.map((c) => c.hash), 'same input, same hashes');
  const changed = chunkFile(f, 'const f = 2;');
  assert.notStrictEqual(first.find((c) => c.kind === 'symbol')!.hash, changed.find((c) => c.kind === 'symbol')!.hash);
})();

(function chunkIdsAreUniqueWithinFile(): void {
  const f = file({
    path: 'a.ts',
    symbols: [
      symbol({ name: 'f', lineRange: { start: 1, end: 2 } }),
      symbol({ name: 'f', lineRange: { start: 4, end: 5 } }),
    ],
  });
  const ids = chunkFile(f, 'a\nb\nc\nd\ne').map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'overloaded names disambiguated by line');
})();

console.log('codeChunker.test.ts passed');
