import * as assert from 'assert';
import { buildFileGraph } from '../graph/graphAlgorithms';
import { GraphweftFile } from '../graph/graphTypes';
import { extractModuleDeclaration } from '../indexer/moduleDeclarations';
import { extractMultiLangImports } from '../indexer/multiLangImports';
import { indexTypeScriptFile } from '../indexer/typescriptAstIndexer';
import type { WorkspaceSourceFile } from '../indexer/workspaceScanner';

interface FileOpts {
  imports?: string[];
  module?: string;
}

function f(path: string, opts: FileOpts = {}): GraphweftFile {
  return {
    uri: `file:///${path}`,
    path,
    imports: (opts.imports ?? []).map((specifier) => ({ specifier, importedNames: [], isTypeOnly: false, line: 1 })),
    symbols: [],
    decorators: [],
    moduleName: opts.module,
  };
}

function edge(files: GraphweftFile[], from: string, to: string): boolean {
  return buildFileGraph(files).adjacency.get(from)?.has(to) ?? false;
}

// --- module/namespace declaration extraction ---

(function extractsCSharpNamespace(): void {
  assert.strictEqual(extractModuleDeclaration('namespace Axon.Services\n{\n}', '.cs'), 'Axon.Services');
  assert.strictEqual(extractModuleDeclaration('namespace Axon.Services;', '.cs'), 'Axon.Services', 'file-scoped namespace');
})();

(function extractsJavaPackage(): void {
  assert.strictEqual(extractModuleDeclaration('package com.example.app;', '.java'), 'com.example.app');
})();

(function normalizesPhpBackslashNamespace(): void {
  assert.strictEqual(extractModuleDeclaration('namespace App\\Services;', '.php'), 'App.Services');
})();

(function csharpUsingIsExtracted(): void {
  const imports = extractMultiLangImports('using Axon.Services;\nusing System;', '.cs');
  assert.ok(imports.some((i) => i.specifier === 'Axon.Services'), 'should capture using directive');
})();

// --- edge resolution across languages ---

(function csharpNamespaceEdge(): void {
  const files = [
    f('Services/UserService.cs', { module: 'Axon.Services' }),
    f('Controllers/UserController.cs', { module: 'Axon.Controllers', imports: ['Axon.Services'] }),
  ];
  assert.ok(edge(files, 'Controllers/UserController.cs', 'Services/UserService.cs'), 'C# using -> namespace file');
})();

(function csharpNamespaceLinksAllFilesInNamespace(): void {
  const files = [
    f('Services/UserService.cs', { module: 'Axon.Services' }),
    f('Services/OrderService.cs', { module: 'Axon.Services' }),
    f('Controllers/Api.cs', { module: 'Axon.Controllers', imports: ['Axon.Services'] }),
  ];
  assert.ok(edge(files, 'Controllers/Api.cs', 'Services/UserService.cs'));
  assert.ok(edge(files, 'Controllers/Api.cs', 'Services/OrderService.cs'));
})();

(function javaImportWithTypeSegment(): void {
  const files = [
    f('com/x/Foo.java', { module: 'com.x' }),
    f('com/x/Other.java', { module: 'com.x' }),
    f('com/y/Bar.java', { module: 'com.y', imports: ['com.x.Foo'] }),
  ];
  // `import com.x.Foo;` should prefer the file named Foo, not every file in com.x.
  assert.ok(edge(files, 'com/y/Bar.java', 'com/x/Foo.java'), 'Java import resolves to the named type file');
  assert.ok(!edge(files, 'com/y/Bar.java', 'com/x/Other.java'), 'should not link unrelated file in the package');
})();

(function relativeTypeScriptStillWorks(): void {
  const files = [f('src/a.ts', { imports: ['./b'] }), f('src/b.ts')];
  assert.ok(edge(files, 'src/a.ts', 'src/b.ts'), 'relative TS import still resolves');
})();

(function pythonDottedModulePath(): void {
  const files = [f('pkg/util/log.py'), f('pkg/main.py', { imports: ['pkg.util.log'] })];
  assert.ok(edge(files, 'pkg/main.py', 'pkg/util/log.py'), 'python dotted module path resolves to file');
})();

(function cIncludeByPath(): void {
  const files = [f('net/socket.h'), f('net/socket.c', { imports: ['net/socket.h'] })];
  assert.ok(edge(files, 'net/socket.c', 'net/socket.h'), 'C #include path resolves');
})();

(function ambiguousBaseNameMakesNoEdge(): void {
  const files = [
    f('a/Helper.cs'),
    f('b/Helper.cs'),
    f('c/Main.cs', { imports: ['Helper'] }),
  ];
  assert.ok(!edge(files, 'c/Main.cs', 'a/Helper.cs'), 'ambiguous bare name should not create a spurious edge');
  assert.ok(!edge(files, 'c/Main.cs', 'b/Helper.cs'));
})();

(function noSelfEdge(): void {
  const files = [f('x/Thing.cs', { module: 'X', imports: ['X'] })];
  assert.ok(!edge(files, 'x/Thing.cs', 'x/Thing.cs'), 'a file importing its own namespace should not self-link');
})();

// --- workspace-package (monorepo) resolution ---

(function scopedPackageSubpathResolvesToWorkspaceSource(): void {
  const files = [
    f('packages/dashboard-shared/src/ChartCard/index.ts'),
    f('packages/dashboard-abc/src/components/Chart/index.tsx', {
      imports: ['@elementlogic-dds/dashboard-shared/ChartCard'],
    }),
  ];
  assert.ok(
    edge(files, 'packages/dashboard-abc/src/components/Chart/index.tsx', 'packages/dashboard-shared/src/ChartCard/index.ts'),
    'scoped subpath import resolves into the workspace package src/',
  );
})();

(function scopedPackageRootResolvesToEntry(): void {
  const files = [
    f('packages/utils/src/index.ts'),
    f('packages/app/src/main.ts', { imports: ['@elementlogic-dds/utils'] }),
  ];
  assert.ok(
    edge(files, 'packages/app/src/main.ts', 'packages/utils/src/index.ts'),
    'scoped package root import resolves to the package entry',
  );
})();

(function externalScopedPackageMakesNoEdge(): void {
  const files = [
    f('packages/app/src/main.ts', { imports: ['@external/axon-react'] }),
    f('packages/app/src/other.ts'),
  ];
  const graph = buildFileGraph(files);
  assert.strictEqual(graph.adjacency.get('packages/app/src/main.ts')!.size, 0, 'external scoped package should not link anywhere');
})();

(function ambiguousUnscopedDirMakesNoEdge(): void {
  const files = [
    f('a/utils/index.ts'),
    f('b/utils/index.ts'),
    f('c/main.ts', { imports: ['utils'] }),
  ];
  assert.ok(!edge(files, 'c/main.ts', 'a/utils/index.ts'), 'ambiguous unscoped dir name should not create an edge');
  assert.ok(!edge(files, 'c/main.ts', 'b/utils/index.ts'));
})();

(function reExportFromCreatesDependencyEdge(): void {
  const source: WorkspaceSourceFile = {
    uri: { toString: () => 'file:///pkg/src/ChartCard/index.ts' } as WorkspaceSourceFile['uri'],
    workspaceRelativePath: 'pkg/src/ChartCard/index.ts',
    text: "export { ChartCard } from './chart-card';\nexport type { ChartCardProps } from './types';",
    isTypescript: true,
  };
  const barrel = indexTypeScriptFile(source);
  assert.strictEqual(barrel.imports.length, 2, 'export ... from should be captured as imports');
  const files = [barrel, f('pkg/src/ChartCard/chart-card.tsx'), f('pkg/src/ChartCard/types.ts')];
  assert.ok(edge(files, 'pkg/src/ChartCard/index.ts', 'pkg/src/ChartCard/chart-card.tsx'), 'barrel re-export links to implementation');
  assert.ok(edge(files, 'pkg/src/ChartCard/index.ts', 'pkg/src/ChartCard/types.ts'), 'type re-export links to types file');
})();

console.log('multiLangGraph.test.ts passed');
