import * as vscode from 'vscode';
import { isSupportedSourceUri } from '../utils/fileFilters';
import { WorkspaceIndexer } from './workspaceIndexer';

const rebuildDelayMs = 750;

export function registerFileSaveWatcher(indexer: WorkspaceIndexer): vscode.Disposable {
  let timeout: NodeJS.Timeout | undefined;

  const disposable = vscode.workspace.onDidSaveTextDocument((document) => {
    if (!isSupportedSourceUri(document.uri)) {
      return;
    }

    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      indexer.rebuild().then(
        (result) => {
          console.log(`CodeGraph: refreshed index after save (${result.filesIndexed} files).`);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`CodeGraph: failed to refresh index after save. ${message}`);
        },
      );
    }, rebuildDelayMs);
  });

  return new vscode.Disposable(() => {
    if (timeout) {
      clearTimeout(timeout);
    }

    disposable.dispose();
  });
}
