import * as vscode from 'vscode';
import { buildContextMarkdown } from '../compressor/contextCompressor';
import { GraphRetriever } from '../graph/graphRetriever';
import { GraphStore } from '../graph/graphStore';
import { buildIndexCommandId } from './buildIndexCommand';

export const prepareContextCommandId = 'graphweft.prepareContext';

export function registerPrepareContextCommand(store: GraphStore): vscode.Disposable {
  return vscode.commands.registerCommand(prepareContextCommandId, async () => {
    if (!store.hasIndex()) {
      const action = await vscode.window.showWarningMessage('Graphweft: Build the local index before preparing context.', 'Build Index');
      if (action === 'Build Index') {
        await vscode.commands.executeCommand(buildIndexCommandId);
      }

      if (!store.hasIndex()) {
        return;
      }
    }

    const task = await vscode.window.showInputBox({
      title: 'Graphweft: Prepare Copilot Context',
      prompt: 'Describe the task you want Copilot Chat to help with.',
      placeHolder: 'Example: update auth controller validation and related tests',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? 'Enter a task description.' : undefined),
    });

    if (!task) {
      return;
    }

    const retriever = new GraphRetriever(store);
    const markdown = buildContextMarkdown(task.trim(), retriever.retrieve(task));
    const document = await vscode.workspace.openTextDocument({
      content: markdown,
      language: 'markdown',
    });

    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.showInformationMessage('Graphweft: Copilot context package prepared.');
  });
}
