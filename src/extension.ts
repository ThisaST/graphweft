import * as vscode from 'vscode';
import { registerCodeGraphParticipant } from './chat/codegraphParticipant';
import { registerCodeGraphTools } from './chat/agentTools';
import { registerBuildIndexCommand } from './commands/buildIndexCommand';
import { registerBuildSemanticIndexCommand } from './commands/buildSemanticIndexCommand';
import { SemanticIndexer } from './semantic/semanticIndexer';
import { registerShowGraphCommand } from './commands/showGraphCommand';
import { registerShowPrivacyCenterCommand } from './commands/showPrivacyCenterCommand';
import { registerShowReportCommand } from './commands/showReportCommand';
import { registerShowSavingsCommand } from './commands/showSavingsCommand';
import { registerWipeIndexCommand } from './commands/wipeIndexCommand';
import { SqliteGraphStore } from './graph/sqliteGraphStore';
import { registerFileSystemWatcher } from './indexer/fileWatcher';
import { WorkspaceIndexer } from './indexer/workspaceIndexer';
import { AuditLog } from './privacy/auditLog';
import { PrivacyCenterView } from './privacy/privacyCenterView';
import { PrivacyManager } from './privacy/privacyManager';
import { registerPrivacyStatusBar } from './privacy/statusBar';
import { ToolAuditLog } from './privacy/toolAuditLog';
import { ModelPreferenceStore } from './privacy/modelPreferenceStore';
import { CodeGraphTreeProvider } from './views/codeGraphTreeProvider';
import { registerAskSuggestedQuestionCommand, registerRevealFileCommand } from './views/revealFileCommand';
import { GraphWebview } from './viz/graphWebview';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const graphStore = new SqliteGraphStore(context.globalStorageUri);
  await graphStore.initialize();
  const indexer = new WorkspaceIndexer(graphStore);
  const semantic = new SemanticIndexer(graphStore, context.globalStorageUri);

  const privacy = new PrivacyManager();
  const audit = new AuditLog(context.globalStorageUri);
  await audit.load();
  const toolAudit = new ToolAuditLog(context.globalStorageUri);
  await toolAudit.load();
  const modelPrefs = new ModelPreferenceStore(context.globalStorageUri);
  await modelPrefs.load();

  const privacyCenter = new PrivacyCenterView(context.extensionUri, audit, privacy);
  const graphView = new GraphWebview(context.extensionUri, graphStore);
  const treeProvider = new CodeGraphTreeProvider(graphStore, privacy, audit);

  const treeView = vscode.window.createTreeView('codegraph.sidebar', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,
    { dispose: () => privacy.dispose() },
    { dispose: () => audit.dispose() },
    { dispose: () => toolAudit.dispose() },
    { dispose: () => modelPrefs.dispose() },
    { dispose: () => privacyCenter.dispose() },
    ...registerCodeGraphTools({ store: graphStore, privacy, toolAudit, indexer }),
    registerCodeGraphParticipant({
      store: graphStore,
      indexer,
      privacy,
      audit,
      modelPrefs,
      semantic,
      iconUri: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png'),
    }),
    registerBuildIndexCommand(graphStore),
    registerBuildSemanticIndexCommand(semantic),
    registerShowGraphCommand(graphView),
    registerShowReportCommand(graphStore),
    registerShowSavingsCommand(audit),
    registerShowPrivacyCenterCommand(privacyCenter),
    registerWipeIndexCommand(graphStore, audit),
    registerRevealFileCommand(),
    registerAskSuggestedQuestionCommand(),
    registerFileSystemWatcher(indexer),
    registerPrivacyStatusBar(privacy, audit),
    vscode.commands.registerCommand('codegraph.refreshSidebar', () => treeProvider.refresh()),
  );

  // Live-update UI surfaces whenever the index changes (saves, agent writes, git ops).
  context.subscriptions.push(
    { dispose: () => indexer.dispose() },
    indexer.onDidChangeIndex(() => {
      treeProvider.refresh();
      graphView.refresh();
    }),
  );
}

export function deactivate(): void {
  // The SQLite-backed graph is flushed on writes and reused on the next activation.
}
