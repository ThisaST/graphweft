import { GraphweftFile, IndexedWorkspace } from './graphTypes';
import { GraphStore } from './graphStore';

export class InMemoryGraphStore implements GraphStore {
  private workspace?: IndexedWorkspace;

  public async replace(files: GraphweftFile[]): Promise<void> {
    this.workspace = {
      files,
      indexedAt: new Date(),
    };
  }

  public async upsert(files: GraphweftFile[], removedPaths: string[] = []): Promise<void> {
    const removed = new Set(removedPaths);
    const updated = new Map(files.map((file) => [file.path, file]));
    const kept = (this.workspace?.files ?? []).filter(
      (file) => !removed.has(file.path) && !updated.has(file.path),
    );
    this.workspace = {
      files: [...kept, ...files].sort((a, b) => a.path.localeCompare(b.path)),
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

  public getFiles(): GraphweftFile[] {
    return this.workspace?.files ?? [];
  }

  public getFile(filePath: string): GraphweftFile | undefined {
    return this.getFiles().find((file) => file.path === filePath);
  }
}
