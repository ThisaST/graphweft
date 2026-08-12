import * as vscode from 'vscode';
import { AuditLog } from '../privacy/auditLog';
import { renderSavingsMarkdown, summarizeSavings } from '../privacy/tokenSavingsAnalyzer';

export const showSavingsCommandId = 'codegraph.showSavings';

export function registerShowSavingsCommand(audit: AuditLog): vscode.Disposable {
  return vscode.commands.registerCommand(showSavingsCommandId, async () => {
    const summary = summarizeSavings(audit.list());
    const doc = await vscode.workspace.openTextDocument({
      content: renderSavingsMarkdown(summary),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });
}
