import { GraphStore } from '../graph/graphStore';
import { indexGenericFile } from './genericIndexer';
import { indexTypeScriptFile } from './typescriptAstIndexer';
import { scanWorkspaceSources } from './workspaceScanner';

export interface WorkspaceIndexResult {
  filesIndexed: number;
  symbolsIndexed: number;
}

export class WorkspaceIndexer {
  private rebuildAttempted = false;

  public constructor(private readonly store: GraphStore) {}

  public async rebuild(): Promise<WorkspaceIndexResult> {
    this.rebuildAttempted = true;
    const sourceFiles = await scanWorkspaceSources();
    const indexedFiles = sourceFiles.map((file) =>
      file.isTypescript ? indexTypeScriptFile(file) : indexGenericFile(file),
    );
    await this.store.replace(indexedFiles);

    return {
      filesIndexed: indexedFiles.length,
      symbolsIndexed: indexedFiles.reduce((count, file) => count + file.symbols.length, 0),
    };
  }

  public async ensureIndex(): Promise<WorkspaceIndexResult | undefined> {
    if (this.store.hasIndex() || this.rebuildAttempted) {
      return undefined;
    }

    return this.rebuild();
  }
}
