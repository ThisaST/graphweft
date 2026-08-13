import { TaskType } from './taskClassifier';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type GraphweftContextPackage = {
  task: string;
  taskType: TaskType;
  confidence: ConfidenceLevel;
  relevantFiles: Array<{
    path: string;
    reason: string;
    score: number;
  }>;
  importantSymbols: Array<{
    name: string;
    kind: string;
    filePath: string;
    startLine: number;
    endLine: number;
    reason: string;
  }>;
  dependencyFlow: string[];
  relatedTests: string[];
  snippets: Array<{
    filePath: string;
    symbolName: string;
    code: string;
  }>;
};
