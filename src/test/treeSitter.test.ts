/**
 * Tree-sitter indexer test: verifies AST-accurate symbol extraction upgrades the
 * regex path (line ranges, nesting via parentName, Go export detection) and that
 * the regex fallback still works when a grammar is not loaded.
 */
import * as assert from 'assert';
import { extractTreeSitterSymbols, initTreeSitter, loadGrammar, treeSitterExtensions } from '../indexer/treeSitterIndexer';
import { indexGenericFile } from '../indexer/genericIndexer';
import type { WorkspaceSourceFile } from '../indexer/sourceFile';

function sourceFile(workspaceRelativePath: string, text: string): WorkspaceSourceFile {
  return {
    uri: `file:///test/${workspaceRelativePath}` as unknown as WorkspaceSourceFile['uri'],
    workspaceRelativePath,
    text,
    isTypescript: false,
  };
}

async function runTests(): Promise<void> {
  // Before init: extraction returns undefined so callers use the regex fallback.
  assert.strictEqual(extractTreeSitterSymbols('def x(): pass', 'a.py', '.py'), undefined, 'not initialized -> undefined');

  const pyBeforeGrammar = indexGenericFile(sourceFile('src/fallback.py', 'def regex_found(x):\n    return x\n'));
  assert.ok(
    pyBeforeGrammar.symbols.some((s) => s.name === 'regex_found'),
    'regex fallback extracts symbols while grammar not loaded',
  );

  const ready = await initTreeSitter();
  assert.strictEqual(ready, true, 'tree-sitter WASM runtime initializes');
  assert.ok(treeSitterExtensions().includes('.py'), 'python is a supported extension');

  assert.strictEqual(await loadGrammar('.py'), true, 'python grammar loads');
  assert.strictEqual(await loadGrammar('.go'), true, 'go grammar loads');
  assert.strictEqual(await loadGrammar('.unknown'), false, 'unknown extension rejected');

  // --- Python: nesting + full line ranges ---------------------------------------------
  const py = [
    'class UserService:',
    '    def find(self, id):',
    '        return id',
    '',
    'def helper():',
    '    pass',
    '',
    'if True:',
    '    def conditional_def():',
    '        pass',
  ].join('\n');
  const pySymbols = extractTreeSitterSymbols(py, 'src/svc.py', '.py');
  assert.ok(pySymbols, 'python parses');
  const byName = new Map(pySymbols!.map((s) => [s.name, s]));

  const cls = byName.get('UserService');
  assert.ok(cls && cls.type === 'class', 'class extracted');
  assert.strictEqual(cls!.lineRange.start, 1, 'class starts at line 1');
  assert.ok(cls!.lineRange.end >= 3, 'class line range spans the body (regex could not do this)');

  const method = byName.get('find');
  assert.ok(method, 'method inside class extracted');
  assert.strictEqual(method!.parentName, 'UserService', 'nested method knows its parent class');

  const helper = byName.get('helper');
  assert.ok(helper && helper.parentName === undefined, 'top-level function has no parent');

  assert.ok(byName.has('conditional_def'), 'non-top-level def found (regex ^def missed these)');

  // --- Go: uppercase = exported --------------------------------------------------------
  const goSymbols = extractTreeSitterSymbols(
    ['package main', '', 'func Public() {}', '', 'func private() {}'].join('\n'),
    'main.go',
    '.go',
  );
  assert.ok(goSymbols, 'go parses');
  const goByName = new Map(goSymbols!.map((s) => [s.name, s]));
  assert.strictEqual(goByName.get('Public')?.exported, true, 'uppercase Go func is exported');
  assert.strictEqual(goByName.get('private')?.exported, false, 'lowercase Go func is unexported');

  // --- genericIndexer integration: tree-sitter path used once grammar is loaded -------
  const indexed = indexGenericFile(sourceFile('src/svc.py', py));
  assert.ok(
    indexed.symbols.some((s) => s.tags.includes('tree-sitter')),
    'generic indexer uses tree-sitter once grammar is loaded',
  );
  assert.ok(
    indexed.symbols.some((s) => s.name === 'find' && s.parentName === 'UserService'),
    'indexed file carries nested symbol info',
  );

  // Malformed source must not throw — tree-sitter produces a best-effort tree.
  const broken = extractTreeSitterSymbols('def broken(:\n  ???', 'bad.py', '.py');
  assert.ok(Array.isArray(broken), 'malformed source still yields a (possibly empty) symbol list');

  console.log('treeSitter.test.ts passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
