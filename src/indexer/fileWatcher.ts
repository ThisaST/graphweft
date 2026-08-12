import * as vscode from 'vscode';
import { WorkspaceIndexer } from './workspaceIndexer';

const flushDelayMs = 300;

/**
 * Keeps the index fresh for *any* disk write, not just editor saves. A raw
 * `FileSystemWatcher` fires for agent tool writes (`vscode.workspace.fs.writeFile`),
 * external agents (Copilot agent mode, CLI tools), `git pull`/checkout, and terminal
 * commands — none of which fire `onDidSaveTextDocument`. Events are queued on the
 * indexer (which drops unsupported/unchanged files) and flushed incrementally after a
 * short debounce so bursts (an agent writing 20 files) collapse into one index patch.
 */
export function registerFileSystemWatcher(indexer: WorkspaceIndexer): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  let timeout: NodeJS.Timeout | undefined;

  const scheduleFlush = (): void => {
    if (!indexer.hasPendingChanges()) {
      return;
    }
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      timeout = undefined;
      indexer.flushPending().then(
        (change) => {
          if (change) {
            console.log(
              `CodeGraph: incrementally refreshed index (${change.updated.length} updated, ${change.removed.length} removed).`,
            );
          }
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`CodeGraph: failed to refresh index. ${message}`);
        },
      );
    }, flushDelayMs);
  };

  const subscriptions = [
    watcher.onDidCreate((uri) => {
      indexer.markChanged(uri);
      scheduleFlush();
    }),
    watcher.onDidChange((uri) => {
      indexer.markChanged(uri);
      scheduleFlush();
    }),
    watcher.onDidDelete((uri) => {
      indexer.markDeleted(uri);
      scheduleFlush();
    }),
  ];

  return new vscode.Disposable(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
    watcher.dispose();
  });
}
