/**
 * CodeGraph MCP server — exposes the code graph to any Model Context Protocol client
 * (Copilot agent mode, Claude Desktop/Code, Cursor, …) over stdio, so agents outside
 * the VS Code extension can query the same graph: task-scoped context packages,
 * impact sets, dependency paths, hotspots, communities.
 *
 * Zero-dependency implementation: MCP stdio transport is newline-delimited JSON-RPC 2.0,
 * which node handles natively. No vscode API is used anywhere in this entry point.
 *
 * Usage: node out/mcp/server.js [workspaceRoot]   (defaults to cwd)
 */
import * as fsSync from 'fs';
import * as path from 'path';
import { buildContextMarkdown } from '../compressor/contextCompressor';
import { buildFileGraph, buildSymbolReferences, communityLabels, computeDegrees, impactSet, shortestPath, symbolUsageCounts } from '../graph/graphAlgorithms';
import { GraphRetriever } from '../graph/graphRetriever';
import { InMemoryGraphStore } from '../graph/inMemoryGraphStore';
import { indexGenericFile } from '../indexer/genericIndexer';
import { indexTypeScriptFile } from '../indexer/typescriptAstIndexer';
import { WorkspaceSourceFile } from '../indexer/sourceFile';
import { isSupportedSourcePath } from '../utils/fileFilters';
import { readSourceFile, scanDirectory, toRelativePath } from '../node/nodeScanner';

const protocolVersions = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const serverInfo = { name: 'codegraph-mcp', version: '0.7.0' };

// ---------------------------------------------------------------------------------------
// Headless engine: full scan once, then fs.watch-driven incremental refresh on demand.
// ---------------------------------------------------------------------------------------

class HeadlessCodeGraph {
  private readonly store = new InMemoryGraphStore();
  private built = false;
  private readonly dirty = new Set<string>();
  private watcher?: fsSync.FSWatcher;

  public constructor(private readonly root: string) {}

  public startWatching(): void {
    try {
      // Recursive fs.watch is supported on Windows and macOS; on unsupported platforms
      // the server still works — every tool call simply reuses the last built index.
      this.watcher = fsSync.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const absolute = path.join(this.root, filename.toString());
        // Filter on the workspace-relative path so excluded segments in the absolute
        // root location (e.g. a checkout under a dir named "build") don't misfire.
        if (isSupportedSourcePath(toRelativePath(this.root, absolute))) this.dirty.add(absolute);
      });
    } catch {
      this.watcher = undefined;
    }
  }

  public dispose(): void {
    this.watcher?.close();
  }

  /** Ensure the index exists and reflects all watcher-reported changes. */
  public async ensureFresh(): Promise<void> {
    if (!this.built) {
      const sources = await scanDirectory(this.root);
      await this.store.replace(sources.map(indexSource));
      this.built = true;
      this.dirty.clear();
      return;
    }

    if (this.dirty.size === 0) return;
    const changed = Array.from(this.dirty);
    this.dirty.clear();

    const updated: WorkspaceSourceFile[] = [];
    const removed: string[] = [];
    for (const absolute of changed) {
      const file = await readSourceFile(this.root, absolute);
      if (file) updated.push(file);
      else removed.push(toRelativePath(this.root, absolute));
    }
    await this.store.upsert(updated.map(indexSource), removed);
  }

  public getStore(): InMemoryGraphStore {
    return this.store;
  }
}

function indexSource(file: WorkspaceSourceFile) {
  return file.isTypescript ? indexTypeScriptFile(file) : indexGenericFile(file);
}

// ---------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

function buildTools(engine: HeadlessCodeGraph): ToolDefinition[] {
  const files = () => engine.getStore().getFiles();

  return [
    {
      name: 'codegraph_context',
      description:
        'Build a compressed, task-scoped context package (ranked files, symbols, dependency flow, related tests) from the code graph. Use this before working on a task to know which files matter.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task or question to gather code context for.' },
          tokenBudget: { type: 'number', description: 'Approximate token budget for the package (default 6000).' },
        },
        required: ['task'],
      },
      run: async (args) => {
        const task = expectString(args, 'task');
        const budget = typeof args.tokenBudget === 'number' ? args.tokenBudget : 6000;
        const retrieval = new GraphRetriever(engine.getStore()).retrieve(task, budget);
        return buildContextMarkdown(task, retrieval, budget);
      },
    },
    {
      name: 'codegraph_impact',
      description:
        'List files that (transitively) import a given file — the blast radius of changing it. Paths are workspace-relative.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of the file being changed.' },
          maxDepth: { type: 'number', description: 'Maximum reverse-dependency depth (default 3).' },
        },
        required: ['path'],
      },
      run: async (args) => {
        const target = expectString(args, 'path');
        const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 3;
        const affected = impactSet(buildFileGraph(files()), target, maxDepth);
        if (affected.length === 0) return `No files import ${target} (or it is not in the index).`;
        return `Files affected by changing ${target} (depth ≤ ${maxDepth}):\n${affected.map((p) => `- ${p}`).join('\n')}`;
      },
    },
    {
      name: 'codegraph_path',
      description: 'Find the shortest import-dependency path between two files.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Workspace-relative source file path.' },
          to: { type: 'string', description: 'Workspace-relative target file path.' },
        },
        required: ['from', 'to'],
      },
      run: async (args) => {
        const from = expectString(args, 'from');
        const to = expectString(args, 'to');
        const result = shortestPath(buildFileGraph(files()), from, to);
        if (!result.found) return `No dependency path between ${from} and ${to}.`;
        return `${result.hopCount} hop(s): ${result.path.join(' -> ')}`;
      },
    },
    {
      name: 'codegraph_hotspots',
      description:
        'List the most connected files (highest import degree) — likely architectural hubs and risky god nodes.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many files to return (default 15).' },
        },
      },
      run: async (args) => {
        const limit = typeof args.limit === 'number' ? args.limit : 15;
        const rows = computeDegrees(buildFileGraph(files())).slice(0, limit);
        if (rows.length === 0) return 'The index is empty.';
        return rows.map((r) => `- ${r.path} (in ${r.inDegree}, out ${r.outDegree})`).join('\n');
      },
    },
    {
      name: 'codegraph_communities',
      description: 'Group files into architectural clusters (Louvain community detection on the import graph).',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const labels = communityLabels(buildFileGraph(files()));
        const groups = new Map<number, string[]>();
        for (const [file, label] of labels) {
          const members = groups.get(label) ?? [];
          members.push(file);
          groups.set(label, members);
        }
        const sorted = Array.from(groups.entries())
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 12);
        return sorted
          .map(([id, members]) => `Cluster #${id} (${members.length} files):\n${members.slice(0, 12).map((m) => `  - ${m}`).join('\n')}${members.length > 12 ? '\n  …' : ''}`)
          .join('\n\n');
      },
    },
    {
      name: 'codegraph_symbol_refs',
      description:
        'Symbol-level references: which files import a given symbol (by named import), or — without a symbol — the most-imported symbols in the codebase.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name to look up. Omit to list the top most-imported symbols.' },
          limit: { type: 'number', description: 'Max results (default 15).' },
        },
      },
      run: async (args) => {
        const limit = typeof args.limit === 'number' ? args.limit : 15;
        const references = buildSymbolReferences(files());
        if (typeof args.symbol === 'string' && args.symbol.length > 0) {
          const matches = references.filter((ref) => ref.symbolName === args.symbol);
          if (matches.length === 0) return `No named-import references to "${args.symbol}" found.`;
          const byDefinition = new Map<string, string[]>();
          for (const ref of matches) {
            const users = byDefinition.get(ref.toPath) ?? [];
            users.push(ref.fromPath);
            byDefinition.set(ref.toPath, users);
          }
          return Array.from(byDefinition.entries())
            .map(([definedIn, users]) => `${args.symbol} (defined in ${definedIn}) is imported by:\n${[...new Set(users)].slice(0, limit).map((u) => `- ${u}`).join('\n')}`)
            .join('\n\n');
        }
        const top = symbolUsageCounts(references).slice(0, limit);
        if (top.length === 0) return 'No symbol-level references resolved.';
        return top.map((s) => `- ${s.symbolName} (${s.definedIn}) — imported by ${s.referencedBy} file(s)`).join('\n');
      },
    },
    {
      name: 'codegraph_stats',
      description: 'Summary statistics for the code graph index (file, symbol and edge counts).',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const all = files();
        const graph = buildFileGraph(all);
        let edges = 0;
        for (const targets of graph.adjacency.values()) edges += targets.size;
        const symbols = all.reduce((count, file) => count + file.symbols.length, 0);
        return `Indexed ${all.length} files, ${symbols} symbols, ${edges} import edges.`;
      },
    },
  ];
}

function expectString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required string argument "${key}"`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio (newline-delimited)
// ---------------------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: number | string | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

export function startServer(root: string): void {
  const engine = new HeadlessCodeGraph(root);
  engine.startWatching();
  const tools = buildTools(engine);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.length === 0) continue;
      void handleLine(line);
    }
  });
  process.stdin.on('end', () => {
    engine.dispose();
    process.exit(0);
  });

  async function handleLine(line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      replyError(null, -32700, 'Parse error');
      return;
    }

    const { id, method, params } = request;
    const isNotification = id === undefined;

    try {
      switch (method) {
        case 'initialize': {
          const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
          reply(id ?? null, {
            protocolVersion: protocolVersions.has(requested) ? requested : '2024-11-05',
            capabilities: { tools: {} },
            serverInfo,
          });
          return;
        }
        case 'ping':
          if (!isNotification) reply(id ?? null, {});
          return;
        case 'tools/list':
          reply(id ?? null, {
            tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          });
          return;
        case 'tools/call': {
          const name = typeof params?.name === 'string' ? params.name : '';
          const tool = toolsByName.get(name);
          if (!tool) {
            replyError(id ?? null, -32602, `Unknown tool: ${name}`);
            return;
          }
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          try {
            await engine.ensureFresh();
            const text = await tool.run(args);
            reply(id ?? null, { content: [{ type: 'text', text }] });
          } catch (error) {
            reply(id ?? null, {
              content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            });
          }
          return;
        }
        default:
          // Notifications (notifications/initialized, notifications/cancelled, …) need no reply.
          if (!isNotification) replyError(id ?? null, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (!isNotification) {
        replyError(id ?? null, -32603, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  process.stderr.write(`codegraph-mcp serving ${root}\n`);
  startServer(root);
}
