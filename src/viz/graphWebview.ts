import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { GraphStore } from '../graph/graphStore';
import { buildFileGraph, communityLabels, computeDegrees, impactSet } from '../graph/graphAlgorithms';

interface NodeJson {
  id: string;
  label: string;
  community: number;
  degree: number;
  symbols: number;
  isGod: boolean;
}

interface EdgeJson {
  source: string;
  target: string;
  weight: number;
}

interface GraphJson {
  nodes: NodeJson[];
  edges: EdgeJson[];
}

export class GraphWebview {
  private panel?: vscode.WebviewPanel;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: GraphStore,
  ) {}

  public show(filter?: string): void {
    if (this.panel) {
      this.panel.reveal();
      this.render(filter);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'codegraph.graphView',
      'CodeGraph: Local Graph',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'media'),
          vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'cytoscape', 'dist'),
        ],
      },
    );

    this.panel.onDidDispose(() => (this.panel = undefined));
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'open' && typeof msg.path === 'string') {
        await openFile(msg.path);
      } else if (msg?.type === 'ask' && typeof msg.path === 'string') {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: `@codegraph explain ${msg.path}` });
      } else if (msg?.type === 'impact' && typeof msg.path === 'string') {
        const impacted = impactSet(buildFileGraph(this.store.getFiles()), msg.path, 4);
        await vscode.window.showInformationMessage(`Impact set for ${msg.path}: ${impacted.length} files`, { modal: false });
        const doc = await vscode.workspace.openTextDocument({
          content: ['# Impact set', `Seed: ${msg.path}`, '', ...impacted.map((p) => `- ${p}`)].join('\n'),
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    });

    this.render(filter);
  }

  private render(filter?: string): void {
    if (!this.panel) return;
    const webview = this.panel.webview;
    const files = this.store.getFiles();
    if (files.length === 0) {
      webview.html = emptyHtml('CodeGraph has no local index yet. Run `CodeGraph: Build Local Index` first.');
      return;
    }

    const graphJson = this.buildGraphJson(files, filter);

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'graph', 'graph.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'graph', 'graph.css'));
    const cytoscapeFsUri = vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js');
    const cytoscapeUri = webview.asWebviewUri(cytoscapeFsUri);
    const nonce = crypto.randomBytes(16).toString('hex');
    const cspSource = webview.cspSource;

    const html = baseTemplate
      .replace(/\$\{cspSource\}/g, cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{styleUri\}/g, styleUri.toString())
      .replace(/\$\{cytoscapeUri\}/g, cytoscapeUri.toString())
      .replace(/\$\{scriptUri\}/g, scriptUri.toString())
      .replace(/\$LOCK_BADGE\$/g, '🔒 local-only render')
      .replace('<script nonce="', `<script nonce="${nonce}">window.__codegraphData__=${JSON.stringify(graphJson)};</script><script nonce="`);

    webview.html = html;
  }

  private buildGraphJson(files: import('../graph/graphTypes').CodeGraphFile[], filter?: string): GraphJson {
    const graph = buildFileGraph(files);
    const degrees = new Map(computeDegrees(graph).map((d) => [d.path, d]));
    const labels = communityLabels(graph);
    const godPaths = new Set(computeDegrees(graph).slice(0, 8).map((d) => d.path));

    const allowed = filter
      ? new Set(files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())).map((f) => f.path))
      : undefined;

    const nodes: NodeJson[] = files
      .filter((f) => (allowed ? allowed.has(f.path) : true))
      .map((f) => ({
        id: f.path,
        label: f.path.split('/').slice(-2).join('/'),
        community: labels.get(f.path) ?? 0,
        degree: degrees.get(f.path)?.totalDegree ?? 0,
        symbols: f.symbols.length,
        isGod: godPaths.has(f.path),
      }));

    const nodeSet = new Set(nodes.map((n) => n.id));
    const edges: EdgeJson[] = [];
    for (const [from, targets] of graph.adjacency) {
      if (!nodeSet.has(from)) continue;
      for (const to of targets) {
        if (!nodeSet.has(to)) continue;
        edges.push({ source: from, target: to, weight: 1 });
      }
    }

    return { nodes, edges };
  }
}

async function openFile(workspacePath: string): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;
  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, workspacePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    } catch {
      // try next folder
    }
  }
  vscode.window.showWarningMessage(`CodeGraph: could not open ${workspacePath}`);
}

function emptyHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8" /><style>
    html, body { height: 100%; margin: 0; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: grid; place-items: center; padding: 24px;
    }
    .empty-card {
      max-width: 420px; text-align: center;
      border: 1px dashed var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
      border-radius: 12px; padding: 32px 28px;
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .empty-card .glyph { font-size: 34px; line-height: 1; margin-bottom: 12px; }
    .empty-card p { margin: 0; font-size: 13px; opacity: 0.85; }
    .empty-card code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.18)); padding: 1px 6px; border-radius: 5px; }
  </style></head><body>
    <div class="empty-card"><div class="glyph">🕸️</div><p>${message}</p></div>
  </body></html>`;
}

const baseTemplate = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src \${cspSource} data:; style-src \${cspSource} 'unsafe-inline'; script-src \${cspSource} 'nonce-\${nonce}';" />
<link rel="stylesheet" href="\${styleUri}" />
</head>
<body>
  <div id="toolbar">
    <input type="text" id="search" placeholder="Search files…" />
    <label><input type="checkbox" id="onlyConnected" checked /> only connected</label>
    <label>Layout:
      <select id="layout">
        <option value="cose">force (cose)</option>
        <option value="concentric">concentric</option>
        <option value="breadthfirst">breadth-first</option>
        <option value="grid">grid</option>
      </select>
    </label>
    <button id="fit">Fit</button>
    <span class="spacer"></span>
    <span class="badge" id="stats"></span>
    <span class="badge lock">\$LOCK_BADGE\$</span>
  </div>
  <div id="legend"></div>
  <div id="cy"></div>
  <div id="hover"></div>
  <script nonce="\${nonce}" src="\${cytoscapeUri}"></script>
  <script nonce="\${nonce}" src="\${scriptUri}"></script>
</body>
</html>`;
