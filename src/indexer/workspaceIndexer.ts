import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { GraphStore } from '../graph/graphStore';
import { isSupportedSourceUri, isTypescriptSourcePath } from '../utils/fileFilters';
import { indexGenericFile } from './genericIndexer';
import { indexTypeScriptFile } from './typescriptAstIndexer';
import { WorkspaceSourceFile } from './sourceFile';
import { scanWorkspaceSources } from './workspaceScanner';

export interface WorkspaceIndexResult {
  filesIndexed: number;
  symbolsIndexed: number;
}

export interface IndexChange {
  /** Workspace-relative paths that were re-indexed (created or updated). */
  updated: string[];
  /** Workspace-relative paths that were removed from the index. */
  removed: string[];
  /** True when the whole index was rebuilt rather than incrementally patched. */
  fullRebuild: boolean;
}

function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function indexSource(file: WorkspaceSourceFile) {
  const indexed = file.isTypescript ? indexTypeScriptFile(file) : indexGenericFile(file);
  indexed.contentHash = hashContent(file.text);
  return indexed;
}

/**
 * Builds and maintains the graph index. Full rebuilds happen once (or on demand); after
 * that, changes flow through the incremental path: watcher events and agent file writes
 * queue URIs, and `flushPending`/`reindexUris` re-parse only those files, skipping ones
 * whose content hash is unchanged. Every index mutation fires `onDidChangeIndex` so UI
 * surfaces (sidebar, graph webview) can refresh live.
 */
export class WorkspaceIndexer {
  private rebuildAttempted = false;
  private readonly pendingChanged = new Set<string>();
  private readonly pendingDeleted = new Set<string>();
  /** Serializes index mutations so overlapping flushes/rebuilds can't interleave. */
  private mutationChain: Promise<unknown> = Promise.resolve();

  private readonly changeEmitter = new vscode.EventEmitter<IndexChange>();
  public readonly onDidChangeIndex = this.changeEmitter.event;

  public constructor(private readonly store: GraphStore) {}

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  public async rebuild(): Promise<WorkspaceIndexResult> {
    return this.enqueue(async () => {
      this.rebuildAttempted = true;
      this.pendingChanged.clear();
      this.pendingDeleted.clear();

      const sourceFiles = await scanWorkspaceSources();
      const indexedFiles = sourceFiles.map(indexSource);
      await this.store.replace(indexedFiles);

      this.changeEmitter.fire({
        updated: indexedFiles.map((file) => file.path),
        removed: [],
        fullRebuild: true,
      });

      return {
        filesIndexed: indexedFiles.length,
        symbolsIndexed: indexedFiles.reduce((count, file) => count + file.symbols.length, 0),
      };
    });
  }

  public async ensureIndex(): Promise<WorkspaceIndexResult | undefined> {
    if (this.store.hasIndex() || this.rebuildAttempted) {
      return undefined;
    }

    return this.rebuild();
  }

  /**
   * Make the index current before retrieval: build it if it has never been built,
   * otherwise apply any file changes queued by the watcher since the last flush.
   */
  public async ensureFresh(): Promise<WorkspaceIndexResult | undefined> {
    if (!this.store.hasIndex() && !this.rebuildAttempted) {
      return this.rebuild();
    }

    await this.flushPending();
    return undefined;
  }

  /** True when watcher events are queued but not yet applied to the index. */
  public hasPendingChanges(): boolean {
    return this.pendingChanged.size > 0 || this.pendingDeleted.size > 0;
  }

  /** Queue a created/changed file for the next incremental flush. */
  public markChanged(uri: vscode.Uri): void {
    if (!isSupportedSourceUri(uri)) return;
    const key = uri.toString();
    this.pendingDeleted.delete(key);
    this.pendingChanged.add(key);
  }

  /** Queue a deleted file for the next incremental flush. */
  public markDeleted(uri: vscode.Uri): void {
    if (!isSupportedSourceUri(uri)) return;
    const key = uri.toString();
    this.pendingChanged.delete(key);
    this.pendingDeleted.add(key);
  }

  /** Apply all queued watcher changes to the index incrementally. */
  public async flushPending(): Promise<IndexChange | undefined> {
    if (!this.hasPendingChanges()) {
      return undefined;
    }

    return this.enqueue(async () => {
      const changed = [...this.pendingChanged].map((key) => vscode.Uri.parse(key));
      const deleted = [...this.pendingDeleted].map((key) => vscode.Uri.parse(key));
      this.pendingChanged.clear();
      this.pendingDeleted.clear();
      return this.applyChanges(changed, deleted);
    });
  }

  /**
   * Immediately re-index specific files — used by the agent's write/edit tools so the
   * very next tool call in the same agent loop sees fresh graph data instead of waiting
   * for watcher latency. Hash-checked, so it is a cheap no-op for unchanged content.
   */
  public async reindexUris(uris: vscode.Uri[]): Promise<IndexChange | undefined> {
    const supported = uris.filter((uri) => isSupportedSourceUri(uri));
    if (supported.length === 0) {
      return undefined;
    }

    // Anything queued for these URIs is superseded by this direct reindex.
    for (const uri of supported) {
      this.pendingChanged.delete(uri.toString());
      this.pendingDeleted.delete(uri.toString());
    }

    return this.enqueue(() => this.applyChanges(supported, []));
  }

  private async applyChanges(changed: vscode.Uri[], deleted: vscode.Uri[]): Promise<IndexChange | undefined> {
    // Without a base index, incremental updates have nothing to patch — the initial
    // build (ensureFresh/rebuild) will pick these files up instead.
    if (!this.store.hasIndex()) {
      return undefined;
    }

    const existingHashes = new Map<string, string>();
    for (const file of this.store.getFiles()) {
      if (file.contentHash) existingHashes.set(file.path, file.contentHash);
    }

    const updatedFiles = [];
    for (const uri of changed) {
      const source = await readSource(uri);
      if (!source) {
        // Changed event but unreadable — treat as deleted (e.g. rapid delete after write).
        deleted = [...deleted, uri];
        continue;
      }
      if (existingHashes.get(source.workspaceRelativePath) === hashContent(source.text)) {
        continue; // touch/no-op write — content identical to what is indexed
      }
      updatedFiles.push(indexSource(source));
    }

    const knownPaths = new Set(this.store.getFiles().map((file) => file.path));
    const removedPaths = [...new Set(
      deleted
        .map((uri) => vscode.workspace.asRelativePath(uri, false))
        .filter((relPath) => knownPaths.has(relPath)),
    )];

    if (updatedFiles.length === 0 && removedPaths.length === 0) {
      return undefined;
    }

    await this.store.upsert(updatedFiles, removedPaths);

    const change: IndexChange = {
      updated: updatedFiles.map((file) => file.path),
      removed: removedPaths,
      fullRebuild: false,
    };
    this.changeEmitter.fire(change);
    return change;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation, operation);
    this.mutationChain = result.catch(() => undefined);
    return result;
  }
}

async function readSource(uri: vscode.Uri): Promise<WorkspaceSourceFile | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return {
      uri: uri.toString(),
      workspaceRelativePath: vscode.workspace.asRelativePath(uri, false),
      text: Buffer.from(bytes).toString('utf8'),
      isTypescript: isTypescriptSourcePath(uri.fsPath),
    };
  } catch {
    return undefined;
  }
}
