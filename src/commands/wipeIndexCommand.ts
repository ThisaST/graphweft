import * as vscode from 'vscode';
import { GraphStore } from '../graph/graphStore';
import { AuditLog } from '../privacy/auditLog';

export const wipeIndexCommandId = 'graphweft.wipeIndex';

export function registerWipeIndexCommand(store: GraphStore, audit: AuditLog): vscode.Disposable {
  return vscode.commands.registerCommand(wipeIndexCommandId, async () => {
    const choice = await vscode.window.showWarningMessage(
      'Wipe the Graphweft local index and audit log for this workspace?',
      { modal: true, detail: 'Removes the SQLite graph and JSONL audit log. Source files are not touched.' },
      'Wipe index only',
      'Wipe index + audit log',
    );

    if (!choice) return;

    await store.clear();
    if (choice === 'Wipe index + audit log') {
      await audit.clear();
    }
    vscode.window.showInformationMessage('Graphweft: local index wiped. Run `Graphweft: Build Local Index` to rebuild.');
  });
}
