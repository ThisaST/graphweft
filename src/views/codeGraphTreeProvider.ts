import * as vscode from 'vscode';
import { GraphStore } from '../graph/graphStore';
import { buildFileGraph, communityLabels, computeDegrees } from '../graph/graphAlgorithms';
import { PrivacyManager } from '../privacy/privacyManager';
import { AuditLog } from '../privacy/auditLog';
import { summarizeSavings } from '../privacy/tokenSavingsAnalyzer';

type Node =
  | { kind: 'section'; id: string; label: string; description?: string; icon?: string; collapsed?: boolean }
  | { kind: 'godNode'; path: string; total: number; inDeg: number; outDeg: number }
  | { kind: 'community'; id: number; size: number; members: string[] }
  | { kind: 'file'; path: string }
  | { kind: 'question'; text: string }
  | { kind: 'auditEntry'; id: string; label: string; tooltip: string }
  | { kind: 'privacy'; label: string; description: string }
  | { kind: 'action'; command: string; label: string; description?: string; icon?: string }
  | { kind: 'empty'; label: string };

export class CodeGraphTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    private readonly store: GraphStore,
    private readonly privacy: PrivacyManager,
    private readonly audit: AuditLog,
  ) {
    privacy.onDidChangeState(() => this.refresh());
    audit.onDidAppend(() => this.refresh());
  }

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public getTreeItem(element: Node): vscode.TreeItem {
    switch (element.kind) {
      case 'section': {
        const item = new vscode.TreeItem(
          element.label,
          element.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.contextValue = `section.${element.id}`;
        item.description = element.description;
        if (element.icon) item.iconPath = new vscode.ThemeIcon(element.icon);
        return item;
      }
      case 'godNode': {
        const item = new vscode.TreeItem(element.path, vscode.TreeItemCollapsibleState.None);
        item.description = `${element.total} (in ${element.inDeg}, out ${element.outDeg})`;
        item.iconPath = new vscode.ThemeIcon('star-full');
        item.command = { command: 'codegraph.revealFile', title: 'Open', arguments: [element.path] };
        item.contextValue = 'godNode';
        return item;
      }
      case 'community': {
        const item = new vscode.TreeItem(`Cluster #${element.id}`, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${element.size} files`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(element.path, vscode.TreeItemCollapsibleState.None);
        item.iconPath = vscode.ThemeIcon.File;
        item.resourceUri = workspaceUri(element.path);
        item.command = { command: 'codegraph.revealFile', title: 'Open', arguments: [element.path] };
        return item;
      }
      case 'question': {
        const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('comment-discussion');
        item.command = { command: 'codegraph.askSuggestedQuestion', title: 'Ask', arguments: [element.text] };
        return item;
      }
      case 'auditEntry': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.tooltip = element.tooltip;
        item.iconPath = new vscode.ThemeIcon('shield');
        item.command = { command: 'codegraph.showPrivacyCenter', title: 'Open Privacy Center' };
        return item;
      }
      case 'privacy': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.description;
        item.iconPath = new vscode.ThemeIcon(element.label.includes('local-only') ? 'lock' : 'shield');
        item.command = { command: 'codegraph.showPrivacyCenter', title: 'Open Privacy Center' };
        return item;
      }
      case 'action': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.description;
        item.iconPath = element.icon ? new vscode.ThemeIcon(element.icon) : undefined;
        item.command = { command: element.command, title: element.label };
        return item;
      }
      case 'empty': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  public getChildren(element?: Node): Node[] {
    if (!element) {
      // Headline counts on section headers (cheap), and collapse secondary sections so the
      // panel opens scannable instead of a long wall of rows.
      const savings = summarizeSavings(this.audit.list());
      const auditCount = this.audit.count();
      return [
        { kind: 'section', id: 'privacy', label: 'Privacy', icon: 'shield' },
        {
          kind: 'section',
          id: 'savings',
          label: 'Token Savings',
          icon: 'graph-line',
          description: savings.requests > 0 ? `${savings.savingsPercent.toFixed(0)}% saved` : undefined,
        },
        { kind: 'section', id: 'actions', label: 'Actions', icon: 'zap' },
        { kind: 'section', id: 'godNodes', label: 'God Nodes', icon: 'star-full' },
        { kind: 'section', id: 'communities', label: 'Communities', icon: 'symbol-namespace', collapsed: true },
        { kind: 'section', id: 'questions', label: 'Suggested Questions', icon: 'comment-discussion', collapsed: true },
        {
          kind: 'section',
          id: 'audit',
          label: 'Recent Model Calls',
          icon: 'history',
          description: auditCount > 0 ? String(auditCount) : undefined,
          collapsed: true,
        },
      ];
    }

    if (element.kind === 'section') {
      switch (element.id) {
        case 'privacy':
          return this.privacyChildren();
        case 'savings':
          return this.savingsChildren();
        case 'actions':
          return this.actionChildren();
        case 'godNodes':
          return this.godNodeChildren();
        case 'communities':
          return this.communityChildren();
        case 'questions':
          return this.questionChildren();
        case 'audit':
          return this.auditChildren();
      }
    }

    if (element.kind === 'community') {
      return element.members.map((path) => ({ kind: 'file' as const, path }));
    }

    return [];
  }

  private privacyChildren(): Node[] {
    const state = this.privacy.getState();
    return [
      { kind: 'privacy', label: `Mode: ${state.mode}`, description: state.mode === 'local-only' ? 'no model calls' : `${state.totalRequests} call(s) this session` },
      { kind: 'privacy', label: `Bytes sent: ${(state.totalBytesSent / 1024).toFixed(1)} KB`, description: 'this session' },
      { kind: 'privacy', label: `Audit entries: ${this.audit.count()}`, description: 'lifetime' },
    ];
  }

  private actionChildren(): Node[] {
    return [
      { kind: 'action', command: 'codegraph.showGraph', label: 'Open interactive graph', icon: 'graph' },
      { kind: 'action', command: 'codegraph.showReport', label: 'Generate graph report', icon: 'preview' },
      { kind: 'action', command: 'codegraph.showSavings', label: 'Token Savings Analysis', icon: 'graph-line' },
      { kind: 'action', command: 'codegraph.buildIndex', label: 'Rebuild local index', icon: 'sync' },
      { kind: 'action', command: 'codegraph.showPrivacyCenter', label: 'Privacy Center', icon: 'shield' },
      { kind: 'action', command: 'codegraph.wipeIndex', label: 'Wipe local data', icon: 'trash' },
    ];
  }

  private savingsChildren(): Node[] {
    const summary = summarizeSavings(this.audit.list());
    if (summary.requests === 0) {
      return [{ kind: 'empty', label: 'No model calls yet — savings will appear after the first call' }];
    }
    const pct = summary.savingsPercent.toFixed(1);
    return [
      {
        kind: 'privacy',
        label: `Saved: ${summary.savedTokens.toLocaleString()} tokens (${pct}%)`,
        description: `${summary.requests} call${summary.requests === 1 ? '' : 's'}`,
      },
      {
        kind: 'privacy',
        label: `Sent: ${summary.actualTokens.toLocaleString()} tokens`,
        description: `${(summary.actualBytes / 1024).toFixed(1)} KB`,
      },
      {
        kind: 'privacy',
        label: `Naive baseline: ${summary.baselineTokens.toLocaleString()} tokens`,
        description: `${(summary.baselineBytes / 1024).toFixed(1)} KB`,
      },
      {
        kind: 'privacy',
        label: `Avg saved per call: ${summary.avgSavedTokensPerCall.toLocaleString()}`,
        description: `≈ $${summary.costAtPricePerMillionTokens(3).toFixed(4)} @ $3/M`,
      },
      { kind: 'action', command: 'codegraph.showSavings', label: 'Open full analysis…', icon: 'graph-line' },
    ];
  }

  private godNodeChildren(): Node[] {
    const files = this.store.getFiles();
    if (files.length === 0) return [{ kind: 'empty', label: 'No index yet — click Rebuild local index' }];
    const degrees = computeDegrees(buildFileGraph(files)).filter((d) => d.totalDegree > 0).slice(0, 12);
    if (degrees.length === 0) return [{ kind: 'empty', label: 'No connected files detected' }];
    return degrees.map((d) => ({ kind: 'godNode' as const, path: d.path, total: d.totalDegree, inDeg: d.inDegree, outDeg: d.outDegree }));
  }

  private communityChildren(): Node[] {
    const files = this.store.getFiles();
    if (files.length === 0) return [{ kind: 'empty', label: 'No index yet' }];
    const labels = communityLabels(buildFileGraph(files));
    const groups = new Map<number, string[]>();
    for (const [path, label] of labels) {
      const arr = groups.get(label) ?? [];
      arr.push(path);
      groups.set(label, arr);
    }
    return Array.from(groups.entries())
      .filter(([, members]) => members.length > 1)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8)
      .map(([id, members]) => ({ kind: 'community' as const, id, size: members.length, members: members.slice(0, 30) }));
  }

  private questionChildren(): Node[] {
    const files = this.store.getFiles();
    if (files.length === 0) return [{ kind: 'empty', label: 'No index yet' }];
    const degrees = computeDegrees(buildFileGraph(files));
    const top = degrees.slice(0, 3).filter((d) => d.totalDegree > 0).map((d) => d.path);
    const questions: string[] = [];
    for (const path of top) {
      questions.push(`explain how \`${path}\` is used`);
    }
    questions.push('review my current changes');
    questions.push('what files are impacted by my staged changes?');
    questions.push('/help — list slash commands');
    return questions.map((q) => ({ kind: 'question' as const, text: q }));
  }

  private auditChildren(): Node[] {
    const entries = this.audit.list(8);
    if (entries.length === 0) return [{ kind: 'empty', label: 'No model calls yet' }];
    return entries.map((e) => ({
      kind: 'auditEntry' as const,
      id: e.id,
      label: `${formatTime(e.timestamp)} · ${truncate(e.task, 40)}`,
      tooltip: `${e.modelVendor}/${e.modelId} · ${e.promptBytes} bytes · ${e.outcome}`,
    }));
  }
}

function workspaceUri(workspacePath: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, workspacePath) : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

function formatTime(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString();
  } catch {
    return iso;
  }
}
