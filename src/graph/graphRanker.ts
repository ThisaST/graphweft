import { CodeGraphFile, RankedFileResult } from './graphTypes';

export interface GraphRetrievalHints {
  activeFilePath?: string;
  openFilePaths?: string[];
  changedFilePaths?: string[];
  /**
   * Files the (opt-in, local) semantic index found similar to the query, with cosine
   * similarity in [0, 1]. Lets meaning-based matches surface even with zero keyword overlap.
   */
  semanticMatches?: Array<{ path: string; similarity: number }>;
}

export function applyContextualFileBoosts(results: RankedFileResult[], hints: GraphRetrievalHints): RankedFileResult[] {
  const activeFilePath = hints.activeFilePath;
  const openFilePaths = new Set(hints.openFilePaths ?? []);
  const changedFilePaths = new Set(hints.changedFilePaths ?? []);
  const semanticByPath = new Map((hints.semanticMatches ?? []).map((m) => [m.path, m.similarity]));

  return results.map((result) => {
    let score = result.score;
    const reasons = new Set(result.reasons);

    if (activeFilePath && samePath(result.file.path, activeFilePath)) {
      score += 25;
      reasons.add('active editor boost');
    }

    if (openFilePaths.has(result.file.path)) {
      score += 12;
      reasons.add('open tab boost');
    }

    if (changedFilePaths.has(result.file.path)) {
      score += 30;
      reasons.add('git diff boost');
    }

    const similarity = semanticByPath.get(result.file.path);
    if (similarity !== undefined) {
      // Scale similarity into the same range as the other boosts: a strong match (~0.9)
      // rivals the git-diff boost; a borderline one (~0.4) is a gentle nudge.
      score += Math.round(similarity * 40);
      reasons.add(`semantic match (${(similarity * 100).toFixed(0)}%)`);
    }

    return {
      ...result,
      score,
      reasons: Array.from(reasons),
    };
  });
}

export function createHintMatches(files: CodeGraphFile[], hints: GraphRetrievalHints): RankedFileResult[] {
  const hintedPaths = new Set<string>();

  if (hints.activeFilePath) {
    hintedPaths.add(hints.activeFilePath);
  }

  (hints.openFilePaths ?? []).forEach((filePath) => hintedPaths.add(filePath));
  (hints.changedFilePaths ?? []).forEach((filePath) => hintedPaths.add(filePath));
  // Semantic matches must seed candidates too: a file the embedding index found by meaning
  // may have ZERO keyword overlap, and would otherwise be filtered out before boosts apply.
  (hints.semanticMatches ?? []).forEach((match) => hintedPaths.add(match.path));

  return files
    .filter((file) => hintedPaths.has(file.path))
    .map((file) => ({
      file,
      score: 1,
      reasons: ['workspace state hint'],
    }));
}

function samePath(left: string, right: string): boolean {
  return left === right;
}
