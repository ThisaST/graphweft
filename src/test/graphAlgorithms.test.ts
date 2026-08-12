import * as assert from 'assert';
import { buildFileGraph, communityLabels, personalizedPageRank } from '../graph/graphAlgorithms';
import { reciprocalRankFusion } from '../graph/graphRanker';
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

function tsFile(relativePath: string, imports: string[]): WorkspaceSourceFile {
  const lines = imports.map((target) => `import { X } from "${target}";`);
  lines.push(`export const marker_${relativePath.replace(/[^a-z0-9]/giu, '_')} = 1;`);
  return testFile(relativePath, lines.join('\n'));
}

function runTests(): void {
  // Two dense clusters bridged by a single edge:
  //   auth: a1 <-> a2 <-> a3 (triangle-ish)
  //   billing: b1 <-> b2 <-> b3
  //   bridge: a1 -> b1
  const files = [
    tsFile('src/auth/a1.ts', ['./a2', './a3', '../billing/b1']),
    tsFile('src/auth/a2.ts', ['./a1', './a3']),
    tsFile('src/auth/a3.ts', ['./a1']),
    tsFile('src/billing/b1.ts', ['./b2', './b3']),
    tsFile('src/billing/b2.ts', ['./b1', './b3']),
    tsFile('src/billing/b3.ts', ['./b1']),
    tsFile('src/lonely.ts', []),
  ].map(indexTypeScriptFile);

  const graph = buildFileGraph(files);

  // --- Louvain communities -----------------------------------------------------------
  const labels = communityLabels(graph);
  assert.strictEqual(labels.size, files.length, 'every file gets a community');

  const authLabels = new Set(['src/auth/a1.ts', 'src/auth/a2.ts', 'src/auth/a3.ts'].map((p) => labels.get(p)));
  const billingLabels = new Set(['src/billing/b1.ts', 'src/billing/b2.ts', 'src/billing/b3.ts'].map((p) => labels.get(p)));
  assert.strictEqual(authLabels.size, 1, 'auth cluster is one community');
  assert.strictEqual(billingLabels.size, 1, 'billing cluster is one community');
  assert.notStrictEqual([...authLabels][0], [...billingLabels][0], 'clusters are separate communities');
  assert.notStrictEqual(labels.get('src/lonely.ts'), [...authLabels][0], 'isolated file is not merged into auth');
  assert.notStrictEqual(labels.get('src/lonely.ts'), [...billingLabels][0], 'isolated file is not merged into billing');

  // Determinism: same input -> same partition.
  const labelsAgain = communityLabels(buildFileGraph(files));
  assert.deepStrictEqual(Array.from(labelsAgain.entries()).sort(), Array.from(labels.entries()).sort(), 'louvain is deterministic');

  // Edgeless graph: every node is its own singleton community.
  const edgeless = buildFileGraph([tsFile('x.ts', []), tsFile('y.ts', [])].map(indexTypeScriptFile));
  const edgelessLabels = communityLabels(edgeless);
  assert.strictEqual(new Set(edgelessLabels.values()).size, 2, 'edgeless graph yields singleton communities');

  // --- Personalized PageRank ----------------------------------------------------------
  // Seeded on the auth cluster: auth files must outrank billing files.
  const seeds = new Map<string, number>([['src/auth/a1.ts', 10]]);
  const ranks = personalizedPageRank(graph, seeds);
  assert.strictEqual(ranks.size, files.length, 'every node has a rank');

  let total = 0;
  for (const value of ranks.values()) total += value;
  assert.ok(Math.abs(total - 1) < 0.01, `ranks are a probability distribution (sum=${total.toFixed(4)})`);

  const rank = (p: string): number => ranks.get(p) ?? 0;
  assert.ok(rank('src/auth/a1.ts') > rank('src/billing/b2.ts'), 'seed file outranks far cluster');
  assert.ok(rank('src/auth/a2.ts') > rank('src/billing/b2.ts'), 'seed neighborhood outranks far cluster');
  assert.ok(rank('src/lonely.ts') < rank('src/auth/a3.ts'), 'disconnected file ranks below seed cluster');

  // Seeding the billing side flips the ordering: personalization matters.
  const billingRanks = personalizedPageRank(graph, new Map([['src/billing/b1.ts', 10]]));
  assert.ok(
    (billingRanks.get('src/billing/b2.ts') ?? 0) > (billingRanks.get('src/auth/a2.ts') ?? 0),
    'personalization shifts mass to the seeded cluster',
  );

  // No seeds: falls back to uniform teleport (classic PageRank), still a distribution.
  const uniform = personalizedPageRank(graph, new Map());
  let uniformTotal = 0;
  for (const value of uniform.values()) uniformTotal += value;
  assert.ok(Math.abs(uniformTotal - 1) < 0.01, 'uniform fallback is a probability distribution');

  // Empty graph is safe.
  assert.strictEqual(personalizedPageRank(buildFileGraph([]), new Map()).size, 0, 'empty graph returns empty ranks');

  // --- Reciprocal Rank Fusion ----------------------------------------------------------
  const fused = reciprocalRankFusion([
    ['a.ts', 'b.ts', 'c.ts'],
    ['b.ts', 'a.ts'],
    ['b.ts', 'd.ts'],
  ]);
  // b.ts: 1/62 + 1/61 + 1/61 — appears high in all three lists, must win.
  const order = Array.from(fused.entries()).sort((x, y) => y[1] - x[1]).map(([id]) => id);
  assert.strictEqual(order[0], 'b.ts', 'item ranked high across lists wins fusion');
  assert.strictEqual(order[1], 'a.ts', 'consistent runner-up is second');
  assert.ok(fused.has('d.ts'), 'items from any single list are retained');
  const expectedB = 1 / 62 + 1 / 61 + 1 / 61;
  assert.ok(Math.abs((fused.get('b.ts') ?? 0) - expectedB) < 1e-12, 'k=60 formula 1/(k+rank) holds');
  assert.strictEqual(reciprocalRankFusion([]).size, 0, 'no rankings yields empty fusion');

  console.log('graphAlgorithms.test.ts passed');
}

runTests();
