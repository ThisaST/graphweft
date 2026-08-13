export type CodeSymbolType =
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'reactComponent'
  | 'reactHook'
  | 'nestjsController'
  | 'nestjsService'
  | 'nestjsModule'
  | 'routeHandler';

export interface LineRange {
  start: number;
  end: number;
}

export interface ImportReference {
  specifier: string;
  importedNames: string[];
  isTypeOnly: boolean;
  line: number;
}

export interface CodeSymbol {
  id: string;
  name: string;
  type: CodeSymbolType;
  filePath: string;
  lineRange: LineRange;
  signature: string;
  snippet?: string;
  exported: boolean;
  decorators: string[];
  parentName?: string;
  tags: string[];
}

export interface GraphweftFile {
  uri: string;
  path: string;
  imports: ImportReference[];
  symbols: CodeSymbol[];
  decorators: string[];
  /**
   * The namespace/package this file declares, when the language has one
   * (C# `namespace`, Java/Kotlin/Scala `package`, PHP `namespace`, VB `Namespace`).
   * Used to resolve namespace-based imports to the files that define them.
   */
  moduleName?: string;
  /**
   * SHA-256 of the source text at index time. Used by the incremental reindexer to
   * skip files whose on-disk content has not actually changed (e.g. touch/format no-ops).
   */
  contentHash?: string;
}

export interface IndexedWorkspace {
  files: GraphweftFile[];
  indexedAt: Date;
}

export interface RankedFileResult {
  file: GraphweftFile;
  score: number;
  reasons: string[];
}

export interface RankedSymbolResult {
  symbol: CodeSymbol;
  score: number;
  reasons: string[];
}

export interface RetrievalResult {
  files: RankedFileResult[];
  symbols: RankedSymbolResult[];
  dependencyFlow: string[];
  relatedTests: string[];
  tokenBudget: number;
  estimatedTokens: number;
}
