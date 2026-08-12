import { CodeGraphFile, IndexedWorkspace } from './graphTypes';
import { GraphStore } from './graphStore';

export class InMemoryGraphStore implements GraphStore {
  private workspace?: IndexedWorkspace;

  public async replace(files: CodeGraphFile[]): Promise<void> {
    this.workspace = {
      files,
      indexedAt: new Date(),
    };
  }

  public async clear(): Promise<void> {
    this.workspace = undefined;
  }

  public hasIndex(): boolean {
    return Boolean(this.workspace);
  }

  public getWorkspace(): IndexedWorkspace | undefined {
    return this.workspace;
  }

  public getFiles(): CodeGraphFile[] {
    return this.workspace?.files ?? [];
  }

  public getFile(filePath: string): CodeGraphFile | undefined {
    return this.getFiles().find((file) => file.path === filePath);
  }
}
