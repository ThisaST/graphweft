import * as vscode from 'vscode';
import { AuditLog, AuditEntry } from './auditLog';
import { PrivacyManager } from './privacyManager';
import { summarizeSavings } from './tokenSavingsAnalyzer';

export class PrivacyCenterView {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    _extensionUri: vscode.Uri,
    private readonly audit: AuditLog,
    private readonly privacy: PrivacyManager,
  ) {
    void _extensionUri;
  }

  public show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'graphweft.privacyCenter',
      'Graphweft Privacy Center',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      for (const d of this.disposables) d.dispose();
      this.disposables.length = 0;
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'setMode' && typeof msg.mode === 'string') {
        await this.privacy.setMode(msg.mode);
        this.refresh();
      } else if (msg?.type === 'clearLog') {
        const ok = await vscode.window.showWarningMessage(
          'Clear the entire Graphweft audit log? This cannot be undone.',
          { modal: true },
          'Clear log',
        );
        if (ok === 'Clear log') {
          await this.audit.clear();
          this.refresh();
        }
      } else if (msg?.type === 'openLogFile') {
        const uri = vscode.Uri.file(this.audit.getLogPath());
        await vscode.commands.executeCommand('vscode.open', uri);
      } else if (msg?.type === 'showEntry' && typeof msg.id === 'string') {
        const entry = this.audit.list().find((e) => e.id === msg.id);
        if (entry) {
          const doc = await vscode.workspace.openTextDocument({
            content: JSON.stringify(entry, null, 2),
            language: 'json',
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        }
      }
    });

    this.disposables.push(
      this.privacy.onDidChangeState(() => this.refresh()),
      this.audit.onDidAppend(() => this.refresh()),
    );

    this.refresh();
  }

  private refresh(): void {
    if (!this.panel) return;
    this.panel.webview.html = this.render(this.audit.list(200));
  }

  private render(entries: AuditEntry[]): string {
    const state = this.privacy.getState();
    const totalKb = (state.totalBytesSent / 1024).toFixed(1);
    const last = state.lastRequestAt ? state.lastRequestAt.toLocaleString() : 'never';
    const modeOptions = (['standard', 'preview-before-send', 'local-only'] as const)
      .map((m) => `<option value="${m}" ${m === state.mode ? 'selected' : ''}>${m}</option>`)
      .join('');
    const savings = summarizeSavings(this.audit.list());
    const savingsBlock = savings.requests === 0
      ? `<div class="savings-empty">No completed model calls yet — the savings analysis will appear here after the first call.</div>`
      : (() => {
          const pct = savings.savingsPercent.toFixed(1);
          const barFill = Math.max(0, Math.min(100, savings.savingsPercent));
          const cost3 = savings.costAtPricePerMillionTokens(3).toFixed(4);
          const cost15 = savings.costAtPricePerMillionTokens(15).toFixed(4);
          const best = savings.bestSavingsRequest
            ? `<div class="hl">Best call: saved <strong>${savings.bestSavingsRequest.savedTokens.toLocaleString()}</strong> tokens (${savings.bestSavingsRequest.savingsPercent.toFixed(1)}%) on <em>${escapeHtml(truncate(savings.bestSavingsRequest.task, 80))}</em></div>`
            : '';
          const worst = savings.worstCaseRequest
            ? `<div class="hl">Most expensive baseline: <em>${escapeHtml(truncate(savings.worstCaseRequest.task, 80))}</em> — naive would have been ${savings.worstCaseRequest.baselineTokens.toLocaleString()} tokens, Graphweft sent ${savings.worstCaseRequest.actualTokens.toLocaleString()}.</div>`
            : '';
          return `
            <div class="savings">
              <h2>Token Savings Analysis</h2>
              <div class="savings-grid">
                <div class="card big"><div class="label">Tokens saved</div><div class="value big-num">${savings.savedTokens.toLocaleString()}</div><div class="sub">${pct}% vs. naive baseline</div></div>
                <div class="card"><div class="label">Tokens actually sent</div><div class="value">${savings.actualTokens.toLocaleString()}</div></div>
                <div class="card"><div class="label">Naive baseline would have sent</div><div class="value">${savings.baselineTokens.toLocaleString()}</div></div>
                <div class="card"><div class="label">Avg saved per call</div><div class="value">${savings.avgSavedTokensPerCall.toLocaleString()}</div></div>
              </div>
              <div class="bar"><div class="bar-fill" style="width:${barFill}%"></div><div class="bar-label">${pct}% saved</div></div>
              <div class="cost-row">
                <span>≈ savings: <strong>$${cost3}</strong> @ $3/M tokens · <strong>$${cost15}</strong> @ $15/M tokens (input)</span>
              </div>
              ${best}
              ${worst}
              <div class="footnote">Baseline = byte sum of every file the retriever flagged as relevant, plus a small prompt overhead. Tokens ≈ bytes / 4. Computed entirely locally.</div>
            </div>`;
        })();

    const rows = entries.length === 0
      ? '<tr><td colspan="6" class="empty">No model requests yet. Graphweft has not sent any data.</td></tr>'
      : entries
          .map((e) => {
            const files = e.filesIncluded.slice(0, 3).join(', ') + (e.filesIncluded.length > 3 ? ` +${e.filesIncluded.length - 3}` : '');
            const outcomeClass = e.outcome === 'sent' ? 'ok' : e.outcome === 'blocked' ? 'blocked' : 'warn';
            return `<tr>
              <td class="ts">${escapeHtml(e.timestamp)}</td>
              <td>${escapeHtml(truncate(e.task, 80))}</td>
              <td>${escapeHtml(e.modelVendor)}/${escapeHtml(e.modelId)}</td>
              <td>${(e.promptBytes / 1024).toFixed(1)} KB</td>
              <td title="${escapeHtml(files)}">${escapeHtml(truncate(files, 60))}</td>
              <td class="${outcomeClass}"><a href="#" data-id="${e.id}" class="view">${e.outcome}</a></td>
            </tr>`;
          })
          .join('');

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root {
    color-scheme: var(--vscode-color-scheme, light dark);
    --cg-gap: 16px;
    --cg-radius: 10px;
    --cg-radius-sm: 7px;
    --cg-border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25)));
    --cg-shadow: 0 1px 2px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10);
    --cg-accent: var(--vscode-textLink-foreground);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 24px clamp(16px, 4vw, 40px) 40px;
    line-height: 1.5;
    max-width: 1100px;
  }
  .app-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand .logo {
    font-size: 20px; line-height: 1; width: 40px; height: 40px; flex: 0 0 40px;
    display: grid; place-items: center; border-radius: 12px;
    background: color-mix(in srgb, var(--cg-accent) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--cg-accent) 35%, transparent);
  }
  .brand h1 { font-size: 19px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  .brand .tagline { font-size: 12px; opacity: 0.6; margin: 2px 0 0; }
  .mode-pill {
    font-size: 11px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
    padding: 5px 12px; border-radius: 999px; white-space: nowrap;
    border: 1px solid transparent;
  }
  .mode-pill.mode-standard { background: color-mix(in srgb, var(--cg-accent) 18%, transparent); color: var(--cg-accent); border-color: color-mix(in srgb, var(--cg-accent) 40%, transparent); }
  .mode-pill.mode-preview-before-send { background: color-mix(in srgb, var(--vscode-testing-iconErrored, #d29922) 18%, transparent); color: var(--vscode-testing-iconErrored, #d29922); border-color: color-mix(in srgb, var(--vscode-testing-iconErrored, #d29922) 40%, transparent); }
  .mode-pill.mode-local-only { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 18%, transparent); color: var(--vscode-testing-iconPassed, #2ea043); border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 40%, transparent); }
  .guarantee {
    background: var(--vscode-textBlockQuote-background);
    border: 1px solid var(--cg-border);
    border-left: 3px solid var(--cg-accent);
    border-radius: var(--cg-radius-sm);
    padding: 12px 16px; margin-bottom: 24px; font-size: 13px;
  }
  h2.section { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.55; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--cg-gap); margin-bottom: 24px; }
  .card {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--cg-border);
    padding: 14px 16px; border-radius: var(--cg-radius);
    transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
  }
  .card:hover { transform: translateY(-1px); box-shadow: var(--cg-shadow); border-color: color-mix(in srgb, var(--cg-accent) 30%, var(--cg-border)); }
  .card .label { font-size: 11px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 20px; font-weight: 650; margin-top: 6px; letter-spacing: -0.01em; }
  .controls { display: flex; gap: 10px; align-items: center; margin: 0 0 20px; flex-wrap: wrap; }
  .controls label { font-size: 12px; opacity: 0.8; display: inline-flex; align-items: center; gap: 6px; }
  select, button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
    padding: 6px 14px; font-family: inherit; font-size: 12px; cursor: pointer;
    border-radius: 7px; transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
  }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border-color: var(--vscode-dropdown-border, var(--cg-border)); }
  button:hover, select:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible, select:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  .table-wrap { border: 1px solid var(--cg-border); border-radius: var(--cg-radius); overflow: hidden; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead th { background: var(--vscode-editor-inactiveSelectionBackground); position: sticky; top: 0; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--cg-border); vertical-align: top; }
  th { font-weight: 600; opacity: 0.7; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  tbody tr { transition: background 0.1s ease; }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  tbody tr:last-child td { border-bottom: none; }
  td.ts { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.75; white-space: nowrap; }
  td.ok a, td.warn a, td.blocked a { font-weight: 600; }
  td.ok { color: var(--vscode-testing-iconPassed, #2ea043); }
  td.warn { color: var(--vscode-testing-iconErrored, #d29922); }
  td.blocked { color: var(--vscode-testing-iconFailed, #f85149); }
  .empty { opacity: 0.55; text-align: center; padding: 32px 0; }
  a.view { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; cursor: pointer; }
  a.view:hover { border-bottom-style: solid; }
  .savings {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--cg-border);
    padding: 18px 20px; border-radius: var(--cg-radius); margin-bottom: 24px;
  }
  .savings h2 { font-size: 14px; font-weight: 600; margin: 0 0 14px; }
  .savings-empty {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px dashed var(--cg-border);
    padding: 18px 20px; border-radius: var(--cg-radius); margin-bottom: 24px; opacity: 0.7; font-size: 13px;
  }
  .savings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 14px; }
  .savings-grid .card { background: var(--vscode-editor-background); }
  .savings-grid .card.big {
    border: 1px solid color-mix(in srgb, var(--cg-accent) 45%, transparent);
    background: color-mix(in srgb, var(--cg-accent) 12%, var(--vscode-editor-background));
  }
  .savings-grid .card.big .value { color: var(--cg-accent); }
  .savings .big-num { font-size: 28px; font-weight: 700; }
  .savings .sub { font-size: 11px; margin-top: 3px; opacity: 0.7; }
  .bar { position: relative; height: 22px; background: var(--vscode-editor-background); border: 1px solid var(--cg-border); border-radius: 999px; overflow: hidden; margin: 10px 0; }
  .bar-fill { position: absolute; top: 0; left: 0; bottom: 0; background: linear-gradient(90deg, #56d364, #4f9cf9); border-radius: 999px; transition: width 0.4s ease; }
  .bar-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; text-shadow: 0 1px 2px rgba(0,0,0,0.35); }
  .cost-row { font-size: 12px; margin: 10px 0 4px; opacity: 0.9; }
  .hl { font-size: 12px; margin-top: 6px; opacity: 0.9; }
  .footnote { font-size: 11px; opacity: 0.55; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--cg-border); }
</style>
</head>
<body>
<header class="app-header">
  <div class="brand">
    <span class="logo">🛡️</span>
    <div>
      <h1>Graphweft Privacy Center</h1>
      <p class="tagline">Local-first · every model call is logged below</p>
    </div>
  </div>
  <span class="mode-pill mode-${escapeHtml(state.mode)}">${escapeHtml(state.mode)}</span>
</header>
<div class="guarantee">
  <strong>Local-first guarantee:</strong> Graphweft indexes and stores everything on this machine. The extension itself makes <em>zero</em> outbound HTTP calls. Prompts are sent only via the Copilot language-model API selected by you, and every send is logged below. Toggle <em>local-only</em> to disable model calls entirely.
</div>
<h2 class="section">Overview</h2>
<div class="grid">
  <div class="card"><div class="label">Privacy mode</div><div class="value">${escapeHtml(state.mode)}</div></div>
  <div class="card"><div class="label">Total model calls</div><div class="value">${state.totalRequests}</div></div>
  <div class="card"><div class="label">Total context sent</div><div class="value">${totalKb} KB</div></div>
  <div class="card"><div class="label">Last call</div><div class="value">${escapeHtml(last)}</div></div>
</div>
${savingsBlock}
<h2 class="section">Audit log</h2>
<div class="controls">
  <label>Mode <select id="mode">${modeOptions}</select></label>
  <button id="openLog" class="secondary">Open raw log</button>
  <button id="clearLog" class="secondary">Clear log</button>
</div>
<div class="table-wrap">
<table>
  <thead><tr><th>When</th><th>Task</th><th>Model</th><th>Bytes</th><th>Files</th><th>Outcome</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('mode').addEventListener('change', (e) => vscode.postMessage({ type: 'setMode', mode: e.target.value }));
  document.getElementById('openLog').addEventListener('click', () => vscode.postMessage({ type: 'openLogFile' }));
  document.getElementById('clearLog').addEventListener('click', () => vscode.postMessage({ type: 'clearLog' }));
  document.querySelectorAll('a.view').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ type: 'showEntry', id: el.dataset.id });
  }));
</script>
</body>
</html>`;
  }

  public dispose(): void {
    this.panel?.dispose();
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}
