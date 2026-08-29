import * as assert from 'assert';
import { buildContextMarkdown } from '../compressor/contextCompressor';
import { GraphRetriever } from '../graph/graphRetriever';
import { InMemoryGraphStore } from '../graph/inMemoryGraphStore';
import { indexTypeScriptFile } from '../indexer/typescriptAstIndexer';
import type { WorkspaceSourceFile } from '../indexer/workspaceScanner';

interface TestUri {
  toString(): string;
}

function testFile(workspaceRelativePath: string, text: string): WorkspaceSourceFile {
  return {
    uri: {
      toString: () => `file:///test/${workspaceRelativePath}`,
    } as TestUri as WorkspaceSourceFile['uri'],
    workspaceRelativePath,
    text,
    isTypescript: true,
  };
}

async function buildStore(): Promise<InMemoryGraphStore> {
  const sourceFiles = [
    testFile(
      'src/user.service.ts',
      [
        'import { Injectable } from "@nestjs/common";',
        '',
        '@Injectable()',
        'export class UserService {',
        '  findUser(id: string): string {',
        '    return id;',
        '  }',
        '}',
      ].join('\n'),
    ),
    testFile(
      'src/user.controller.ts',
      [
        'import { Controller, Get } from "@nestjs/common";',
        'import { UserService } from "./user.service";',
        '',
        '@Controller("users")',
        'export class UserController {',
        '  constructor(private readonly service: UserService) {}',
        '',
        '  @Get(":id")',
        '  getUser(): string {',
        '    return this.service.findUser("1");',
        '  }',
        '}',
      ].join('\n'),
    ),
    testFile(
      'src/user.routes.ts',
      [
        'import { UserController } from "./user.controller";',
        '',
        'export function registerUserRoutes(controller: UserController): void {',
        '  controller.getUser();',
        '}',
      ].join('\n'),
    ),
    testFile(
      'src/user.controller.spec.ts',
      [
        'import { UserController } from "./user.controller";',
        '',
        'describe("UserController", () => {',
        '  it("works", () => {',
        '    expect(UserController).toBeDefined();',
        '  });',
        '});',
      ].join('\n'),
    ),
    testFile(
      'src/BillingPanel.tsx',
      [
        'export function BillingPanel() {',
        '  return <section>Billing</section>;',
        '}',
      ].join('\n'),
    ),
  ];

  const store = new InMemoryGraphStore();
  await store.replace(sourceFiles.map(indexTypeScriptFile));
  return store;
}

async function runTests(): Promise<void> {
  const store = await buildStore();
  const retriever = new GraphRetriever(store);
  const result = retriever.retrieve('fix UserController get user route tests');

  assert.strictEqual(result.files[0]?.file.path, 'src/user.controller.spec.ts', 'test task should boost matching spec file');
  assert.ok(result.files.some((entry) => entry.file.path === 'src/user.service.ts'), 'matched controller should expand to imported service');
  assert.ok(result.files.some((entry) => entry.file.path === 'src/user.routes.ts'), 'matched controller should expand to importer file');
  assert.ok(result.dependencyFlow.includes('src/user.controller.ts -> src/user.service.ts'), 'dependency flow should include controller to service import');
  assert.ok(result.dependencyFlow.includes('src/user.routes.ts -> src/user.controller.ts'), 'dependency flow should include importer relationship');
  assert.ok(result.relatedTests.includes('src/user.controller.spec.ts'), 'related tests should include matching spec file');

  const controllerSymbol = result.symbols.find((entry) => entry.symbol.name === 'UserController')?.symbol;
  assert.ok(controllerSymbol, 'exact symbol name should be ranked');
  assert.ok(controllerSymbol.signature.includes('class UserController'), 'symbol signature should be captured');

  const generousMarkdown = buildContextMarkdown('fix UserController get user route tests', result, 3000);
  assert.ok(generousMarkdown.includes('## Compact Snippets'), 'context package should include compact snippets section');
  assert.ok(generousMarkdown.includes('class UserController'), 'top symbol snippet should be included');
  assert.ok(!generousMarkdown.includes('src/BillingPanel.tsx'), 'unrelated file should not appear in context');

  const tinyMarkdown = buildContextMarkdown('fix UserController get user route tests', result, 260);
  assert.ok(tinyMarkdown.includes('Estimated tokens'), 'budgeted markdown should report estimated tokens');
  assert.ok(tinyMarkdown.length < generousMarkdown.length, 'small budget should omit lower-ranked context');
}

/**
 * The retriever used to carry its own import resolver that understood relative TS/JS
 * specifiers only, so on a Go/Java-style repo the one-hop expansion, the import boosts and
 * dependencyFlow were all silently empty. It now shares the multi-language resolver.
 */
async function resolvesPackageDirectoryImportsInRetrieval(): Promise<void> {
  const store = new InMemoryGraphStore();
  const goFile = (path: string, imports: string[] = []) => ({
    uri: `file:///test/${path}`,
    path,
    imports: imports.map((specifier) => ({ specifier, importedNames: [], isTypeOnly: false, line: 1 })),
    symbols: [],
    decorators: [],
  });

  await store.replace([
    goFile('internal/telemetry/service.go', ['context', 'github.com/acme/platform/internal/telemetry/emit']),
    goFile('internal/telemetry/emit/emitter.go'),
    goFile('internal/telemetry/emit/sink.go'),
  ]);

  const result = new GraphRetriever(store).retrieve('telemetry emit', 4000);
  assert.ok(
    result.dependencyFlow.join(' ').includes('internal/telemetry/service.go -> internal/telemetry/emit/emitter.go'),
    `expected a Go package edge in dependencyFlow, got: ${JSON.stringify(result.dependencyFlow)}`,
  );
  assert.ok(
    result.files.some((entry) => entry.file.path === 'internal/telemetry/emit/sink.go'),
    'one-hop expansion should pull in the rest of the imported package',
  );
}

runTests()
  .then(resolvesPackageDirectoryImportsInRetrieval)
  .then(() => console.log('retrieval.test.ts passed'))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
