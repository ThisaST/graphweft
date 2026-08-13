import * as vscode from 'vscode';

export const revealFileCommandId = 'graphweft.revealFile';
export const askSuggestedQuestionCommandId = 'graphweft.askSuggestedQuestion';

export function registerRevealFileCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(revealFileCommandId, async (workspacePath: string) => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const uri = vscode.Uri.joinPath(folder.uri, workspacePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      vscode.window.showWarningMessage(`Graphweft: could not open ${workspacePath}`);
    }
  });
}

export function registerAskSuggestedQuestionCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(askSuggestedQuestionCommandId, async (text: string) => {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: `@graphweft ${text}` });
  });
}
