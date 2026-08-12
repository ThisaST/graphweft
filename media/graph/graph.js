/* global cytoscape, acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const data = window.__codegraphData__ || { nodes: [], edges: [] };
  const palette = ['#4f9cf9', '#f97583', '#56d364', '#d29922', '#a371f7', '#f0883e', '#6e7681', '#79c0ff', '#ff7b72', '#3fb950'];

  function colorFor(community) {
    return palette[(community || 0) % palette.length];
  }

  function languageBadge(path) {
    const ext = path.split('.').pop();
    return ext || '';
  }

  const elements = [
    ...data.nodes.map((n) => ({
      data: {
        id: n.id,
        label: shortLabel(n.label || n.id),
        full: n.id,
        community: n.community || 0,
        size: 12 + Math.min(40, (n.degree || 0) * 1.5),
        symbols: n.symbols || 0,
        lang: languageBadge(n.id),
        isGod: n.isGod ? 1 : 0,
      },
    })),
    ...data.edges.map((e) => ({
      data: { source: e.source, target: e.target, weight: e.weight || 1 },
    })),
  ];

  // Cytoscape renders to a <canvas> and cannot resolve CSS `var(--vscode-*)` tokens,
  // so read the theme colors from the document once and pass concrete values.
  const rootStyle = getComputedStyle(document.body);
  const cssVar = (name, fallback) => rootStyle.getPropertyValue(name).trim() || fallback;
  const fg = cssVar('--vscode-editor-foreground', '#cccccc');
  const bg = cssVar('--vscode-editor-background', '#1e1e1e');
  const focus = cssVar('--vscode-focusBorder', '#007fd4');

  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: [
      {
        selector: 'node',
        style: {
          'background-color': (ele) => colorFor(ele.data('community')),
          'width': 'data(size)',
          'height': 'data(size)',
          'label': 'data(label)',
          'font-size': 10,
          'color': fg,
          'text-valign': 'bottom',
          'text-margin-y': 4,
          'text-outline-width': 2,
          'text-outline-color': bg,
          'border-width': 0,
        },
      },
      {
        selector: 'node[isGod = 1]',
        style: {
          'border-width': 2,
          'border-color': '#facc15',
        },
      },
      {
        selector: 'edge',
        style: {
          'width': 1,
          'line-color': 'rgba(127,127,127,0.45)',
          'target-arrow-color': 'rgba(127,127,127,0.6)',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'arrow-scale': 0.7,
        },
      },
      {
        selector: 'node:selected',
        style: {
          'border-width': 3,
          'border-color': focus,
        },
      },
      {
        selector: '.faded',
        style: { 'opacity': 0.15 },
      },
      {
        selector: '.hit',
        style: { 'border-width': 3, 'border-color': '#facc15' },
      },
    ],
    // Start with no automatic layout; we lay out the *visible* subset below so a
    // sparse graph (few edges among many files) isn't scattered into an empty void.
    layout: { name: 'preset' },
    wheelSensitivity: 0.2,
  });

  let currentLayout = 'cose';

  function layoutOptions(name) {
    const base = { name, animate: false, fit: false };
    if (name === 'cose') {
      return { ...base, idealEdgeLength: 80, nodeRepulsion: 6000, componentSpacing: 80 };
    }
    return base;
  }

  // Lay out only the currently visible elements, then frame them. Running the layout
  // on the visible subset (rather than all 396 nodes) is what keeps a 5-edge graph
  // from collapsing to sub-pixel specks after the "only connected" filter is applied.
  function relayout() {
    const visible = cy.elements(':visible');
    if (visible.length === 0) {
      return;
    }
    visible.layout(layoutOptions(currentLayout)).run();
    cy.fit(visible, 40);
  }

  function applyOnlyConnected(on) {
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const isolated = n.connectedEdges().length === 0;
        n.style('display', on && isolated ? 'none' : 'element');
      });
    });
  }

  document.getElementById('stats').textContent = `${cy.nodes().length} files · ${cy.edges().length} edges`;

  document.getElementById('layout').addEventListener('change', (e) => {
    currentLayout = e.target.value;
    relayout();
  });

  document.getElementById('fit').addEventListener('click', () => cy.fit(cy.elements(':visible'), 40));

  document.getElementById('onlyConnected').addEventListener('change', (e) => {
    applyOnlyConnected(e.target.checked);
    relayout();
  });

  // Initial render: honor the default "only connected" checkbox, then lay out + fit
  // just the visible nodes.
  applyOnlyConnected(document.getElementById('onlyConnected').checked);
  relayout();

  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    const term = search.value.trim().toLowerCase();
    cy.elements().removeClass('faded hit');
    if (!term) return;
    const matches = cy.nodes().filter((n) => n.data('full').toLowerCase().includes(term));
    if (matches.length === 0) return;
    cy.elements().addClass('faded');
    matches.removeClass('faded').addClass('hit');
    matches.connectedEdges().removeClass('faded');
    matches.neighborhood().nodes().removeClass('faded');
    cy.fit(matches, 80);
  });

  const hover = document.getElementById('hover');
  cy.on('tap', 'node', (e) => {
    const n = e.target;
    const data = n.data();
    hover.style.display = 'block';
    hover.innerHTML = `
      <h3>${escapeHtml(data.full)}</h3>
      <div>community ${data.community} · ${data.symbols} symbols · ${data.lang}</div>
      <div class="row">
        <button data-action="open" data-path="${escapeAttr(data.full)}">Open file</button>
        <button data-action="ask" data-path="${escapeAttr(data.full)}">Ask @codegraph about this</button>
        <button data-action="impact" data-path="${escapeAttr(data.full)}">Show impact set</button>
      </div>
    `;
    hover.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: btn.dataset.action, path: btn.dataset.path });
      });
    });
  });

  cy.on('tap', (e) => {
    if (e.target === cy) {
      hover.style.display = 'none';
      cy.elements().removeClass('faded hit');
    }
  });

  // Legend
  const communities = new Map();
  cy.nodes().forEach((n) => {
    const c = n.data('community');
    communities.set(c, (communities.get(c) || 0) + 1);
  });
  const sorted = Array.from(communities.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  document.getElementById('legend').innerHTML =
    '<strong>Clusters</strong><br/>' +
    sorted.map(([c, n]) => `<div><span class="swatch" style="background:${colorFor(c)}"></span>#${c} (${n})</div>`).join('');

  function shortLabel(p) {
    const parts = p.split('/');
    return parts.slice(-2).join('/');
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }
})();
