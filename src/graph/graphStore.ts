import { CodeGraphFile, IndexedWorkspace } from './graphTypes';

export interface GraphStore {
  replace(files: CodeGraphFile[]): Promise<void>;
  clear(): Promise<void>;
  hasIndex(): boolean;
  getWorkspace(): IndexedWorkspace | undefined;
  getFiles(): CodeGraphFile[];
  getFile(filePath: string): CodeGraphFile | undefined;
}
