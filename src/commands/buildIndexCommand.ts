import * as vscode from 'vscode';
import { GraphStore } from '../graph/graphStore';
import { indexGenericFile } from '../indexer/genericIndexer';
import { indexTypeScriptFile } from '../indexer/typescriptAstIndexer';
import { scanWorkspaceSources } from '../indexer/workspaceScanner';

export const buildIndexCommandId = 'codegraph.buildIndex';

export function registerBuildIndexCommand(store: GraphStore): vscode.Disposable {
  return vscode.commands.registerCommand(buildIndexCommandId, async () => {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      await store.clear();
      vscode.window.showWarningMessage('CodeGraph: Open a workspace folder before building an index.');
      return;
    }

    try {
      const indexedFiles = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'CodeGraph: Building local code index',
          cancellable: false,
        },
        async () => {
          const sourceFiles = await scanWorkspaceSources();
          // Route each file to the right indexer: TS/JS through the AST indexer, every other
          // language through the generic indexer (which extracts namespaces/imports for edges).
          // This matches the auto-build path so manual + automatic builds produce the same graph.
          return sourceFiles.map((file) => (file.isTypescript ? indexTypeScriptFile(file) : indexGenericFile(file)));
        },
      );

      if (indexedFiles.length === 0) {
        await store.clear();
        vscode.window.showWarningMessage('CodeGraph: No source files found to index.');
        return;
      }

      await store.replace(indexedFiles);
      const symbolCount = indexedFiles.reduce((count, file) => count + file.symbols.length, 0);
      vscode.window.showInformationMessage(`CodeGraph: Indexed ${indexedFiles.length} files and ${symbolCount} symbols locally.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`CodeGraph: Failed to build index. ${message}`);
    }
  });
}
