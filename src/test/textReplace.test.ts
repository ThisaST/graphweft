import * as assert from 'assert';
import { applyReplace, detectEol } from '../chat/textReplace';

(function exactMatchPreservesContent(): void {
  const r = applyReplace('const a = 1;\nconst b = 2;\n', 'const b = 2;', 'const b = 3;');
  assert.ok(r);
  assert.strictEqual(r!.strategy, 'exact');
  assert.ok(r!.updated.includes('const b = 3;'));
})();

(function matchesAcrossCrlfVsLf(): void {
  // File on disk is CRLF (Windows/.NET); model's find uses LF — the real-world failure.
  const file = 'public class Foo\r\n{\r\n    public Foo()\r\n    {\r\n    }\r\n}\r\n';
  const find = 'public Foo()\n    {\n    }';
  const replace = 'public Foo() { }';
  const r = applyReplace(file, find, replace);
  assert.ok(r, 'should match despite CRLF/LF mismatch');
  assert.strictEqual(r!.strategy, 'normalized-eol');
  assert.ok(r!.updated.includes('public Foo() { }'));
})();

(function preservesCrlfOnWrite(): void {
  const file = 'a\r\nb\r\nc\r\n';
  const r = applyReplace(file, 'b', 'B');
  assert.ok(r);
  assert.ok(r!.updated.includes('\r\n'), 'output keeps CRLF line endings');
  assert.ok(!/[^\r]\n/u.test(r!.updated), 'no lone LF introduced');
})();

(function toleratesIndentationDrift(): void {
  // Find has different leading whitespace than the file (spaces count differs).
  const file = 'class X\n{\n        int y = 1;\n}\n';
  const find = 'int y = 1;';
  const r = applyReplace(file, '  int y = 1;  ', 'int y = 2;');
  assert.ok(r, 'flexible whitespace match should succeed');
  assert.ok(['normalized-eol', 'flexible-whitespace', 'exact'].includes(r!.strategy));
  assert.ok(r!.updated.includes('int y = 2;'));
  void find;
})();

(function returnsUndefinedWhenTrulyAbsent(): void {
  assert.strictEqual(applyReplace('hello world', 'nonexistent snippet', 'x'), undefined);
})();

(function replaceAllCountsOccurrences(): void {
  const r = applyReplace('x\nx\nx\n', 'x', 'y', true);
  assert.ok(r);
  assert.strictEqual(r!.count, 3);
  assert.strictEqual(r!.updated, 'y\ny\ny\n');
})();

(function dollarSignsInReplacementAreLiteral(): void {
  const r = applyReplace('price = OLD;', 'OLD', '$cost$&');
  assert.ok(r);
  assert.ok(r!.updated.includes('$cost$&'), 'replacement $ is literal, not a backreference');
})();

(function detectsDominantEol(): void {
  assert.strictEqual(detectEol('a\r\nb\r\n'), '\r\n');
  assert.strictEqual(detectEol('a\nb\n'), '\n');
})();

console.log('textReplace.test.ts passed');
