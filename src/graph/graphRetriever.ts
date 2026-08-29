import * as path from 'path';
import {
  GraphweftFile,
  CodeSymbol,
  RankedFileResult,
  RankedSymbolResult,
  RetrievalResult,
} from './graphTypes';
import { applyContextualFileBoosts, createHintMatches, GraphRetrievalHints, reciprocalRankFusion } from './graphRanker';
import { buildFileGraph, personalizedPageRank, FileGraph } from './graphAlgorithms';
import { GraphStore } from './graphStore';

const maxFiles = 16;
const maxSymbols = 28;
const defaultTokenBudget = 6000;

interface QueryModel {
  normalized: string;
  terms: string[];
  wantsTests: boolean;
}

interface ImportGraph {
  importsByPath: Map<string, GraphweftFile[]>;
  importersByPath: Map<string, GraphweftFile[]>;
}

export class GraphRetriever {
  public constructor(private readonly store: GraphStore) {}

  public retrieve(task: string, tokenBudget = defaultTokenBudget, hints: GraphRetrievalHints = {}): RetrievalResult {
    const query = buildQueryModel(task);
    const files = this.store.getFiles();
    // One shared graph for both import lookups and the PageRank signal: the resolver in
    // graphAlgorithms understands every language's import style (relative paths, namespaces,
    // and package-as-directory imports like Go module paths), which the retriever's own
    // resolver did not — it saw relative TS/JS imports only, so on a Go or Java repo the
    // one-hop expansion, the import boosts and dependencyFlow were all silently empty.
    const fileGraph = buildFileGraph(files);
    const importGraph = buildImportGraph(files, fileGraph);
    const rankedFiles = rankFiles(files, query, importGraph, hints, fileGraph);
    const rankedSymbols = rankSymbols(files, query, rankedFiles);
    const expandedFiles = expandOneHop(rankedFiles, importGraph);
    const selectedFiles = expandedFiles.slice(0, maxFiles);

    return {
      files: selectedFiles,
      symbols: rankedSymbols.slice(0, maxSymbols),
      dependencyFlow: buildDependencyFlow(selectedFiles.map((result) => result.file), importGraph),
      relatedTests: findRelatedTests(query, selectedFiles.map((result) => result.file), files),
      tokenBudget,
      estimatedTokens: 0,
    };
  }
}

function rankFiles(
  files: GraphweftFile[],
  query: QueryModel,
  importGraph: ImportGraph,
  hints: GraphRetrievalHints,
  fileGraph: FileGraph,
): RankedFileResult[] {
  const baseResults = files.map((file) => scoreFile(file, query));
  const hintMatches = createHintMatches(files, hints);
  const mergedResults = mergeRankedFiles([...baseResults, ...hintMatches]);
  const matchedPaths = new Set(mergedResults.filter((result) => result.score > 0).map((result) => result.file.path));
  const fusedSignal = fuseGraphSignals(mergedResults, hints, fileGraph);

  return applyContextualFileBoosts(
    mergedResults
      .map((result) => applyFileBoosts(result, matchedPaths, query, importGraph))
      .map((result) => applyCentralityBoost(result, fusedSignal))
      .filter((result) => result.score > 0),
    hints,
  )
    .sort(sortRankedFiles);
}

/**
 * Fuse the three scale-incompatible graph signals — keyword match ranking, semantic
 * similarity ranking, and personalized-PageRank centrality — with Reciprocal Rank
 * Fusion (k=60). RRF works on ranks, not raw scores, so a 0..1 cosine similarity, an
 * unbounded keyword score and a probability-mass centrality can be combined without
 * hand-tuned scale factors. The fused value is normalized to [0, 1].
 */
function fuseGraphSignals(
  mergedResults: RankedFileResult[],
  hints: GraphRetrievalHints,
  fileGraph: FileGraph,
): Map<string, number> {
  const keywordRanking = mergedResults
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .map((result) => result.file.path);

  const semanticRanking = (hints.semanticMatches ?? [])
    .slice()
    .sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path))
    .map((match) => match.path);

  const centrality = taskCentrality(mergedResults, hints, fileGraph);
  const centralityRanking = Array.from(centrality.entries())
    .filter(([, value]) => value >= 0.05)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([node]) => node);

  const rankings = [keywordRanking, semanticRanking, centralityRanking].filter((r) => r.length > 0);
  if (rankings.length === 0) return new Map();

  const fused = reciprocalRankFusion(rankings);
  let max = 0;
  for (const value of fused.values()) max = Math.max(max, value);
  if (max === 0) return new Map();
  const normalized = new Map<string, number>();
  for (const [node, value] of fused) normalized.set(node, value / max);
  return normalized;
}

/**
 * Personalized PageRank scores seeded from keyword matches and workspace hints
 * (Aider repo-map technique): a random walk that teleports back to the task's seed
 * files, so structural relevance to *this task* — not global popularity — is measured.
 * Scores are normalized to [0, 1] relative to the best-ranked file.
 */
function taskCentrality(
  mergedResults: RankedFileResult[],
  hints: GraphRetrievalHints,
  fileGraph: FileGraph,
): Map<string, number> {
  const seeds = new Map<string, number>();
  for (const result of mergedResults) {
    if (result.score > 0) seeds.set(result.file.path, result.score);
  }
  if (hints.activeFilePath) seeds.set(hints.activeFilePath, (seeds.get(hints.activeFilePath) ?? 0) + 30);
  for (const p of hints.openFilePaths ?? []) seeds.set(p, (seeds.get(p) ?? 0) + 10);
  for (const p of hints.changedFilePaths ?? []) seeds.set(p, (seeds.get(p) ?? 0) + 20);
  if (seeds.size === 0) return new Map();

  const ranks = personalizedPageRank(fileGraph, seeds);
  let max = 0;
  for (const value of ranks.values()) max = Math.max(max, value);
  if (max === 0) return new Map();
  const normalized = new Map<string, number>();
  for (const [node, value] of ranks) normalized.set(node, value / max);
  return normalized;
}

/**
 * The fused graph signal is a *nudge*, not a primary signal: it must never override
 * explicit intent boosts (e.g. the +45 test-task boost), only break near-ties in
 * favor of files the fused rankers agree are relevant.
 */
const centralityBoostScale = 8;

function applyCentralityBoost(result: RankedFileResult, fusedSignal: Map<string, number>): RankedFileResult {
  const value = fusedSignal.get(result.file.path) ?? 0;
  // Only meaningful agreement gets a boost; the long tail of near-zero scores is noise.
  if (result.score <= 0 || value < 0.05) return result;
  return {
    ...result,
    score: result.score + Math.round(value * centralityBoostScale),
    reasons: [...result.reasons, `graph signal fusion ${(value * 100).toFixed(0)}%`],
  };
}

function rankSymbols(files: GraphweftFile[], query: QueryModel, rankedFiles: RankedFileResult[]): RankedSymbolResult[] {
  const fileScores = new Map(rankedFiles.map((result) => [result.file.path, result.score]));

  return files
    .flatMap((file) => file.symbols.map((symbol) => scoreSymbol(symbol, file, query, fileScores.get(file.path) ?? 0)))
    .filter((result) => result.score > 0)
    .sort(sortRankedSymbols);
}

function mergeRankedFiles(results: RankedFileResult[]): RankedFileResult[] {
  const merged = new Map<string, RankedFileResult>();

  for (const result of results) {
    const existing = merged.get(result.file.path);
    if (!existing) {
      merged.set(result.file.path, result);
      continue;
    }

    merged.set(result.file.path, {
      file: result.file,
      score: existing.score + result.score,
      reasons: Array.from(new Set([...existing.reasons, ...result.reasons])),
    });
  }

  return Array.from(merged.values());
}

function scoreFile(file: GraphweftFile, query: QueryModel): RankedFileResult {
  let score = 0;
  const reasons = new Set<string>();
  const normalizedPath = normalizeForMatching(file.path);

  for (const term of query.terms) {
    if (normalizedPath.includes(term)) {
      score += 10;
      reasons.add(`file path matches "${term}"`);
    }

    if (file.imports.some((importRef) => importRef.specifier.toLowerCase().includes(term))) {
      score += 4;
      reasons.add(`import matches "${term}"`);
    }

    if (file.decorators.some((decorator) => decorator.toLowerCase() === term || decorator.toLowerCase().includes(term))) {
      score += 8;
      reasons.add(`decorator matches "${term}"`);
    }

    if (file.symbols.some((symbol) => normalizeForMatching(symbol.name).includes(term))) {
      score += 6;
      reasons.add(`symbol in file matches "${term}"`);
    }
  }

  return {
    file,
    score,
    reasons: Array.from(reasons),
  };
}

function applyFileBoosts(
  result: RankedFileResult,
  matchedPaths: Set<string>,
  query: QueryModel,
  importGraph: ImportGraph,
): RankedFileResult {
  let score = result.score;
  const reasons = new Set(result.reasons);
  const importedMatchedFiles = (importGraph.importsByPath.get(result.file.path) ?? []).filter((file) => matchedPaths.has(file.path));
  const importerMatchedFiles = (importGraph.importersByPath.get(result.file.path) ?? []).filter((file) => matchedPaths.has(file.path));

  if (importedMatchedFiles.length > 0) {
    score += 7;
    reasons.add(`imports matched file ${importedMatchedFiles[0].path}`);
  }

  if (importerMatchedFiles.length > 0) {
    score += 7;
    reasons.add(`imported by matched file ${importerMatchedFiles[0].path}`);
  }

  if (query.wantsTests && isTestFile(result.file.path)) {
    score += 45;
    reasons.add('test task boost');
  }

  return {
    ...result,
    score,
    reasons: Array.from(reasons),
  };
}

function scoreSymbol(symbol: CodeSymbol, file: GraphweftFile, query: QueryModel, fileScore: number): RankedSymbolResult {
  let score = Math.min(fileScore / 4, 8);
  const reasons = new Set<string>();
  const normalizedName = normalizeForMatching(symbol.name);
  const normalizedParent = normalizeForMatching(symbol.parentName ?? '');
  const searchableImports = file.imports.flatMap((importRef) => [importRef.specifier, ...importRef.importedNames]).join(' ').toLowerCase();

  if (query.normalized.includes(normalizedName) && normalizedName.length > 0) {
    score += 25;
    reasons.add('exact symbol name match');
  }

  for (const term of query.terms) {
    if (normalizedName === term || normalizedParent === term) {
      score += 18;
      reasons.add(`exact symbol token matches "${term}"`);
    } else if (normalizedName.includes(term) || normalizedParent.includes(term)) {
      score += 9;
      reasons.add(`partial symbol name matches "${term}"`);
    }

    if (normalizeForMatching(symbol.filePath).includes(term)) {
      score += 6;
      reasons.add(`file path matches "${term}"`);
    }

    if (symbol.decorators.some((decorator) => decorator.toLowerCase() === term || decorator.toLowerCase().includes(term))) {
      score += 8;
      reasons.add(`decorator matches "${term}"`);
    }

    if (symbol.tags.some((tag) => tag.includes(term))) {
      score += 4;
      reasons.add(`tag matches "${term}"`);
    }

    if (searchableImports.includes(term)) {
      score += 3;
      reasons.add(`import context matches "${term}"`);
    }
  }

  if (query.wantsTests && isTestFile(symbol.filePath)) {
    score += 18;
    reasons.add('test task boost');
  }

  return {
    symbol,
    score,
    reasons: Array.from(reasons),
  };
}

function expandOneHop(initialResults: RankedFileResult[], importGraph: ImportGraph): RankedFileResult[] {
  const results = new Map<string, RankedFileResult>();

  initialResults.forEach((result) => results.set(result.file.path, result));

  for (const result of initialResults) {
    const neighbors = [
      ...(importGraph.importsByPath.get(result.file.path) ?? []).map((file) => ({
        file,
        reason: `imported by ${result.file.path}`,
      })),
      ...(importGraph.importersByPath.get(result.file.path) ?? []).map((file) => ({
        file,
        reason: `imports ${result.file.path}`,
      })),
    ];

    for (const neighbor of neighbors) {
      const existing = results.get(neighbor.file.path);
      const expandedScore = Math.max(1, result.score - 3);

      if (!existing || expandedScore > existing.score) {
        results.set(neighbor.file.path, {
          file: neighbor.file,
          score: expandedScore,
          reasons: [neighbor.reason],
        });
      }
    }
  }

  return Array.from(results.values()).sort(sortRankedFiles);
}

function buildDependencyFlow(selectedFiles: GraphweftFile[], importGraph: ImportGraph): string[] {
  const selectedPaths = new Set(selectedFiles.map((file) => file.path));
  const flow: string[] = [];

  for (const file of selectedFiles) {
    for (const importedFile of importGraph.importsByPath.get(file.path) ?? []) {
      if (selectedPaths.has(importedFile.path)) {
        flow.push(`${file.path} -> ${importedFile.path}`);
      }
    }
  }

  return Array.from(new Set(flow));
}

function findRelatedTests(query: QueryModel, selectedFiles: GraphweftFile[], allFiles: GraphweftFile[]): string[] {
  const selectedStems = selectedFiles.map((file) => normalizeStem(file.path));
  const tests = allFiles.filter((file) => isTestFile(file.path));
  const related = tests.filter((testFile) => {
    const testPath = testFile.path.toLowerCase();

    if (selectedStems.some((stem) => testPath.includes(stem))) {
      return true;
    }

    return query.terms.some(
      (term) => testPath.includes(term) || testFile.symbols.some((symbol) => normalizeForMatching(symbol.name).includes(term)),
    );
  });

  return related.map((file) => file.path).sort();
}

function buildImportGraph(files: GraphweftFile[], fileGraph: FileGraph): ImportGraph {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const importsByPath = new Map<string, GraphweftFile[]>();
  const importersByPath = new Map<string, GraphweftFile[]>();

  const project = (paths: Iterable<string>): GraphweftFile[] => {
    const resolved: GraphweftFile[] = [];
    for (const target of paths) {
      const file = byPath.get(target);
      if (file) resolved.push(file);
    }
    return resolved;
  };

  for (const [filePath, targets] of fileGraph.adjacency) importsByPath.set(filePath, project(targets));
  for (const [filePath, sources] of fileGraph.reverseAdjacency) importersByPath.set(filePath, project(sources));

  return { importsByPath, importersByPath };
}


function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('__tests__/') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.tsx') ||
    filePath.endsWith('.spec.js') ||
    filePath.endsWith('.spec.jsx') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx') ||
    filePath.endsWith('.test.js') ||
    filePath.endsWith('.test.jsx')
  );
}

function normalizeStem(filePath: string): string {
  return path.posix
    .basename(filePath)
    .replace(/\.(spec|test)\.[tj]sx?$/u, '')
    .replace(/\.[tj]sx?$/u, '')
    .toLowerCase();
}

function buildQueryModel(task: string): QueryModel {
  const terms = tokenize(task);

  return {
    normalized: normalizeForMatching(task),
    terms,
    wantsTests: terms.some((term) => ['test', 'tests', 'spec', 'fix', 'bug', 'broken', 'failing', 'failure'].includes(term)),
  };
}

function tokenize(input: string): string[] {
  return Array.from(
    new Set(
      splitCamelCase(input)
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  );
}

function splitCamelCase(input: string): string {
  return input.replace(/([a-z0-9])([A-Z])/gu, '$1 $2');
}

function normalizeForMatching(input: string): string {
  return splitCamelCase(input).toLowerCase().replace(/[^a-z0-9_]+/gu, '');
}

function sortRankedFiles(left: RankedFileResult, right: RankedFileResult): number {
  return right.score - left.score || left.file.path.localeCompare(right.file.path);
}

function sortRankedSymbols(left: RankedSymbolResult, right: RankedSymbolResult): number {
  return right.score - left.score || left.symbol.name.localeCompare(right.symbol.name);
}
