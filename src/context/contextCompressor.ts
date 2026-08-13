import { GitDiffContext } from '../git/gitDiffProvider';
import { RetrievalResult } from '../graph/graphTypes';
import { ContextBudgeter } from './contextBudgeter';
import { GraphweftContextPackage, ConfidenceLevel } from './contextPackage';
import { TaskType } from './taskClassifier';

const defaultSnippetLimit = 3;

export interface ContextCompressionOptions {
  task: string;
  taskType: TaskType;
  retrieval: RetrievalResult;
  gitDiff: GitDiffContext;
  maxTokens: number;
  indexingError?: string;
}

export function buildGraphweftContextPackage(options: ContextCompressionOptions): GraphweftContextPackage {
  const budgeter = new ContextBudgeter(options.maxTokens);
  const contextPackage: GraphweftContextPackage = {
    task: options.task,
    taskType: options.taskType,
    confidence: calculateConfidence(options),
    relevantFiles: [],
    importantSymbols: [],
    dependencyFlow: [],
    relatedTests: [],
    snippets: [],
  };

  for (const result of options.retrieval.files) {
    const item = {
      path: result.file.path,
      reason: formatReasons(result.reasons),
      score: Math.round(result.score),
    };

    if (!budgeter.tryUse(JSON.stringify(item))) {
      break;
    }

    contextPackage.relevantFiles.push(item);
  }

  for (const result of options.retrieval.symbols) {
    const symbol = result.symbol;
    const item = {
      name: symbol.parentName ? `${symbol.parentName}.${symbol.name}` : symbol.name,
      kind: symbol.type,
      filePath: symbol.filePath,
      startLine: symbol.lineRange.start,
      endLine: symbol.lineRange.end,
      reason: formatReasons(result.reasons),
    };

    if (!budgeter.tryUse(JSON.stringify(item))) {
      break;
    }

    contextPackage.importantSymbols.push(item);
  }

  const flowLimit = options.taskType === 'explain_flow' || options.taskType === 'impact_analysis' ? 18 : 10;
  for (const flow of options.retrieval.dependencyFlow.slice(0, flowLimit)) {
    if (!budgeter.tryUse(flow)) {
      break;
    }

    contextPackage.dependencyFlow.push(flow);
  }

  for (const testPath of options.retrieval.relatedTests) {
    if (!budgeter.tryUse(testPath)) {
      break;
    }

    contextPackage.relatedTests.push(testPath);
  }

  if ((options.taskType === 'code_review' || options.taskType === 'impact_analysis') && options.gitDiff.diff.trim().length > 0) {
    addSnippet(contextPackage, budgeter, {
      filePath: 'git diff',
      symbolName: 'current changes',
      code: options.gitDiff.diff,
    });
  }

  const snippetLimit = options.taskType === 'explain_flow' ? 2 : defaultSnippetLimit;
  for (const result of options.retrieval.symbols.slice(0, snippetLimit)) {
    const symbol = result.symbol;
    addSnippet(contextPackage, budgeter, {
      filePath: symbol.filePath,
      symbolName: symbol.parentName ? `${symbol.parentName}.${symbol.name}` : symbol.name,
      code: symbol.snippet ?? symbol.signature,
    });
  }

  return contextPackage;
}

function addSnippet(
  contextPackage: GraphweftContextPackage,
  budgeter: ContextBudgeter,
  snippet: { filePath: string; symbolName: string; code: string },
): void {
  if (snippet.code.trim().length === 0) {
    return;
  }

  if (budgeter.tryUse(JSON.stringify(snippet))) {
    contextPackage.snippets.push(snippet);
  }
}

function calculateConfidence(options: ContextCompressionOptions): ConfidenceLevel {
  const retrieval = options.retrieval;

  if (options.indexingError || retrieval.files.length === 0) {
    return 'low';
  }

  const topScore = retrieval.files[0]?.score ?? 0;
  if ((options.taskType === 'code_review' || options.taskType === 'impact_analysis') && options.gitDiff.diff.trim().length > 0 && topScore >= 40) {
    return 'high';
  }

  if (topScore >= 50 && retrieval.symbols.length >= 1) {
    return 'high';
  }

  if (topScore >= 20 || retrieval.files.length >= 2) {
    return 'medium';
  }

  return 'low';
}

function formatReasons(reasons: string[]): string {
  return reasons.length > 0 ? reasons.join('; ') : 'related by code graph retrieval';
}
