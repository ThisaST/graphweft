import * as vscode from 'vscode';
import { GraphStore } from '../graph/graphStore';
import { buildGraphReport, renderGraphReportMarkdown } from '../report/graphReport';

export const showReportCommandId = 'codegraph.showReport';

export function registerShowReportCommand(store: GraphStore): vscode.Disposable {
  return vscode.commands.registerCommand(showReportCommandId, async () => {
    const files = store.getFiles();
    if (files.length === 0) {
      vscode.window.showWarningMessage('CodeGraph: no local index yet. Run `CodeGraph: Build Local Index` first.');
      return;
    }
    const report = buildGraphReport(files);
    const markdown = renderGraphReportMarkdown(report);
    const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
  });
}
