import * as vscode from 'vscode';
import { SemanticIndexer } from '../semantic/semanticIndexer';

export const buildSemanticIndexCommandId = 'graphweft.buildSemanticIndex';

export function registerBuildSemanticIndexCommand(semantic: SemanticIndexer): vscode.Disposable {
  return vscode.commands.registerCommand(buildSemanticIndexCommandId, async () => {
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Graphweft: Building local semantic index',
          cancellable: false,
        },
        async (progress) =>
          semantic.build((done, total) => {
            progress.report({ message: `embedding ${done}/${total} changed files…` });
          }),
      );
      vscode.window.showInformationMessage(
        `Graphweft: Semantic index ready — ${result.total} files (${result.embedded} embedded, ${result.reused} unchanged). All local.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Graphweft: Semantic index failed. ${message}`);
    }
  });
}
