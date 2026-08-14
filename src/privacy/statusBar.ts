import * as vscode from 'vscode';
import { AuditLog } from './auditLog';
import { PrivacyManager } from './privacyManager';

export function registerPrivacyStatusBar(privacy: PrivacyManager, audit: AuditLog): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('graphweft.privacy', vscode.StatusBarAlignment.Right, 100);
  item.command = 'graphweft.showPrivacyCenter';
  const disposables: vscode.Disposable[] = [item];

  const refresh = (): void => {
    const state = privacy.getState();
    const lock = state.mode === 'local-only' ? '$(lock)' : state.mode === 'preview-before-send' ? '$(eye)' : '$(shield)';
    const detail = state.mode === 'local-only'
      ? 'no model calls'
      : `${state.totalRequests} call${state.totalRequests === 1 ? '' : 's'}`;
    item.text = `${lock} Graphweft: ${detail}`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**Graphweft privacy mode:** \`${state.mode}\``,
        ``,
        `- Total model calls this session: ${state.totalRequests}`,
        `- Total bytes sent: ${(state.totalBytesSent / 1024).toFixed(1)} KB`,
        `- Audit entries: ${audit.count()}`,
        ``,
        `Click to open the Privacy Center.`,
      ].join('\n'),
    );
    item.show();
  };

  disposables.push(privacy.onDidChangeState(refresh));
  disposables.push(audit.onDidAppend(refresh));
  refresh();

  return vscode.Disposable.from(...disposables);
}
