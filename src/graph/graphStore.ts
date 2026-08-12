import { CodeGraphFile, IndexedWorkspace } from './graphTypes';

export interface GraphStore {
  replace(files: CodeGraphFile[]): Promise<void>;
  /**
   * Incrementally apply a change set: insert-or-update `files` (matched by `path`) and
   * remove `removedPaths`, leaving every other indexed file untouched. Edges are
   * recomputed from the resulting file set. Far cheaper than `replace` for small change
   * sets because unchanged files are not re-read or re-parsed.
   */
  upsert(files: CodeGraphFile[], removedPaths?: string[]): Promise<void>;
  clear(): Promise<void>;
  hasIndex(): boolean;
  getWorkspace(): IndexedWorkspace | undefined;
  getFiles(): CodeGraphFile[];
  getFile(filePath: string): CodeGraphFile | undefined;
}
