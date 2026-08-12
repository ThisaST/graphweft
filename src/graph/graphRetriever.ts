import * as path from 'path';
import {
  CodeGraphFile,
  CodeSymbol,
  RankedFileResult,
  RankedSymbolResult,
  RetrievalResult,
} from './graphTypes';
import { applyContextualFileBoosts, createHintMatches, GraphRetrievalHints } from './graphRanker';
import { buildFileGraph, personalizedPageRank } from './graphAlgorithms';
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
  importsByPath: Map<string, CodeGraphFile[]>;
  importersByPath: Map<string, CodeGraphFile[]>;
}

export class GraphRetriever {
  public constructor(private readonly store: GraphStore) {}

  public retrieve(task: string, tokenBudget = defaultTokenBudget, hints: GraphRetrievalHints = {}): RetrievalResult {
    const query = buildQueryModel(task);
    const files = this.store.getFiles();
    const importGraph = buildImportGraph(files);
    const rankedFiles = rankFiles(files, query, importGraph, hints);
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

function rankFiles(files: CodeGraphFile[], query: QueryModel, importGraph: ImportGraph, hints: GraphRetrievalHints): RankedFileResult[] {
  const baseResults = files.map((file) => scoreFile(file, query));
  const hintMatches = createHintMatches(files, hints);
  const mergedResults = mergeRankedFiles([...baseResults, ...hintMatches]);
  const matchedPaths = new Set(mergedResults.filter((result) => result.score > 0).map((result) => result.file.path));
  const centrality = taskCentrality(files, mergedResults, hints);

  return applyContextualFileBoosts(
    mergedResults
      .map((result) => applyFileBoosts(result, matchedPaths, query, importGraph))
      .map((result) => applyCentralityBoost(result, centrality))
      .filter((result) => result.score > 0),
    hints,
  )
    .sort(sortRankedFiles);
}

/**
 * Personalized PageRank scores seeded from keyword matches and workspace hints
 * (Aider repo-map technique): a random walk that teleports back to the task's seed
 * files, so structural relevance to *this task* — not global popularity — is measured.
 * Scores are normalized to [0, 1] relative to the best-ranked file.
 */
function taskCentrality(
  files: CodeGraphFile[],
  mergedResults: RankedFileResult[],
  hints: GraphRetrievalHints,
): Map<string, number> {
  const seeds = new Map<string, number>();
  for (const result of mergedResults) {
    if (result.score > 0) seeds.set(result.file.path, result.score);
  }
  if (hints.activeFilePath) seeds.set(hints.activeFilePath, (seeds.get(hints.activeFilePath) ?? 0) + 30);
  for (const p of hints.openFilePaths ?? []) seeds.set(p, (seeds.get(p) ?? 0) + 10);
  for (const p of hints.changedFilePaths ?? []) seeds.set(p, (seeds.get(p) ?? 0) + 20);
  if (seeds.size === 0) return new Map();

  const ranks = personalizedPageRank(buildFileGraph(files), seeds);
  let max = 0;
  for (const value of ranks.values()) max = Math.max(max, value);
  if (max === 0) return new Map();
  const normalized = new Map<string, number>();
  for (const [node, value] of ranks) normalized.set(node, value / max);
  return normalized;
}

/**
 * Centrality is a *nudge*, not a primary signal: it must never override explicit
 * intent boosts (e.g. the +45 test-task boost), only break near-ties in favor of
 * files that are structurally central to the task's neighborhood.
 */
const centralityBoostScale = 8;

function applyCentralityBoost(result: RankedFileResult, centrality: Map<string, number>): RankedFileResult {
  const value = centrality.get(result.file.path) ?? 0;
  // Only meaningful centrality gets a boost; the long tail of near-zero scores is noise.
  if (result.score <= 0 || value < 0.05) return result;
  return {
    ...result,
    score: result.score + Math.round(value * centralityBoostScale),
    reasons: [...result.reasons, `graph centrality ${(value * 100).toFixed(0)}%`],
  };
}

function rankSymbols(files: CodeGraphFile[], query: QueryModel, rankedFiles: RankedFileResult[]): RankedSymbolResult[] {
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

function scoreFile(file: CodeGraphFile, query: QueryModel): RankedFileResult {
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

function scoreSymbol(symbol: CodeSymbol, file: CodeGraphFile, query: QueryModel, fileScore: number): RankedSymbolResult {
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

function buildDependencyFlow(selectedFiles: CodeGraphFile[], importGraph: ImportGraph): string[] {
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

function findRelatedTests(query: QueryModel, selectedFiles: CodeGraphFile[], allFiles: CodeGraphFile[]): string[] {
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

function buildImportGraph(files: CodeGraphFile[]): ImportGraph {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const importsByPath = new Map<string, CodeGraphFile[]>();
  const importersByPath = new Map<string, CodeGraphFile[]>();

  for (const file of files) {
    const importedFiles = resolveImports(file, byPath);
    importsByPath.set(file.path, importedFiles);

    for (const importedFile of importedFiles) {
      const importers = importersByPath.get(importedFile.path) ?? [];
      importers.push(file);
      importersByPath.set(importedFile.path, importers);
    }
  }

  return {
    importsByPath,
    importersByPath,
  };
}

function resolveImports(file: CodeGraphFile, byPath: Map<string, CodeGraphFile>): CodeGraphFile[] {
  const resolved: CodeGraphFile[] = [];

  for (const importRef of file.imports) {
    if (!importRef.specifier.startsWith('.')) {
      continue;
    }

    const importBase = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), importRef.specifier));
    const candidates = [
      importBase,
      `${importBase}.ts`,
      `${importBase}.tsx`,
      `${importBase}.js`,
      `${importBase}.jsx`,
      path.posix.join(importBase, 'index.ts'),
      path.posix.join(importBase, 'index.tsx'),
      path.posix.join(importBase, 'index.js'),
      path.posix.join(importBase, 'index.jsx'),
    ];

    const match = candidates.map((candidate) => byPath.get(candidate)).find((candidate): candidate is CodeGraphFile => Boolean(candidate));
    if (match) {
      resolved.push(match);
    }
  }

  return resolved;
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
