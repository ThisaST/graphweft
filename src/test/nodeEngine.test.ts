import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CodeGraphEngine } from '../node/codegraphEngine';
import { scanDirectory } from '../node/nodeScanner';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-engine-'));
  const write = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  };

  await write('src/a.ts', "import { b } from './b';\nexport function a() { return b(); }\n");
  await write('src/b.ts', 'export function b() { return 42; }\n');
  await write('Services/UserService.cs', 'namespace App.Services;\npublic class UserService { }\n');
  await write('Controllers/UserController.cs', 'using App.Services;\nnamespace App.Controllers;\npublic class UserController { }\n');
  // Should be excluded by the scanner:
  await write('node_modules/junk/index.ts', 'export const junk = 1;\n');
  await write('obj/Debug/App.GlobalUsings.g.cs', 'global using System;\n');
  return root;
}

(async function run(): Promise<void> {
  const root = await makeFixture();
  try {
    // --- scanner excludes build/dependency dirs and generated files ---
    const scanned = await scanDirectory(root);
    const paths = scanned.map((s) => s.workspaceRelativePath).sort();
    assert.deepStrictEqual(paths, [
      'Controllers/UserController.cs',
      'Services/UserService.cs',
      'src/a.ts',
      'src/b.ts',
    ], `node_modules and obj should be excluded; got ${JSON.stringify(paths)}`);

    // --- engine indexes and builds edges across languages ---
    const engine = new CodeGraphEngine();
    const summary = await engine.indexDirectory(root);
    assert.strictEqual(summary.files, 4, 'four real source files indexed');
    assert.ok(summary.edges >= 2, `expected TS relative edge + C# namespace edge, got ${summary.edges}`);

    // --- impact: b.ts is imported by a.ts ---
    const impacted = engine.impact('src/b.ts');
    assert.ok(impacted.includes('src/a.ts'), 'a.ts depends on b.ts');

    // --- path: a.ts -> b.ts is one hop ---
    const p = engine.path('src/a.ts', 'src/b.ts');
    assert.ok(p.found && p.hopCount === 1, 'a.ts reaches b.ts in one hop');

    // --- C# namespace edge: UserController (using App.Services) -> UserService ---
    const csImpact = engine.impact('Services/UserService.cs');
    assert.ok(
      csImpact.includes('Controllers/UserController.cs'),
      `C# "using App.Services" should create an edge; impact=${JSON.stringify(csImpact)}`,
    );

    // --- search returns ranked, structure-aware hits ---
    const result = engine.search('user service');
    assert.ok(result.files.length > 0, 'search returns hits');
    assert.ok(result.files.some((f) => f.path === 'Services/UserService.cs'), 'finds the user service file');

    console.log('nodeEngine.test.ts passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
