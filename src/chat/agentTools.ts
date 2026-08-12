import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { GraphStore } from '../graph/graphStore';
import { buildFileGraph, computeDegrees, impactSet, shortestPath } from '../graph/graphAlgorithms';
import { PrivacyManager } from '../privacy/privacyManager';
import { ToolAuditLog } from '../privacy/toolAuditLog';
import { applyReplace } from './textReplace';

export interface ToolDeps {
  store: GraphStore;
  privacy: PrivacyManager;
  toolAudit: ToolAuditLog;
}

/**
 * Names of the tools CodeGraph registers. The participant passes these to the
 * model so it can act on the workspace (run commands, read/write files) and
 * reason over the local graph — the same agentic capability Copilot's built-in
 * agent has, but routed through CodeGraph's privacy/audit layer.
 *
 * Keep in sync with `contributes.languageModelTools` in package.json.
 */
export const CODEGRAPH_TOOL_NAMES = [
  'codegraph_runInTerminal',
  'codegraph_readFile',
  'codegraph_writeFile',
  'codegraph_replaceInFile',
  'codegraph_listDirectory',
  'codegraph_findFiles',
  'codegraph_impact',
  'codegraph_dependencyPath',
  'codegraph_godNodes',
] as const;

const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

const configRoot = 'codegraph';
function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration(configRoot).get<T>(key, fallback);
}

export function registerCodeGraphTools(deps: ToolDeps): vscode.Disposable[] {
  return [
    vscode.lm.registerTool('codegraph_runInTerminal', new RunInTerminalTool(deps)),
    vscode.lm.registerTool('codegraph_readFile', new ReadFileTool()),
    vscode.lm.registerTool('codegraph_writeFile', new WriteFileTool(deps)),
    vscode.lm.registerTool('codegraph_replaceInFile', new ReplaceInFileTool(deps)),
    vscode.lm.registerTool('codegraph_listDirectory', new ListDirectoryTool()),
    vscode.lm.registerTool('codegraph_findFiles', new FindFilesTool()),
    vscode.lm.registerTool('codegraph_impact', new ImpactTool(deps)),
    vscode.lm.registerTool('codegraph_dependencyPath', new DependencyPathTool(deps)),
    vscode.lm.registerTool('codegraph_godNodes', new GodNodesTool(deps)),
  ];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Resolve a (possibly relative) path against the workspace root, rejecting escapes. */
function resolveInWorkspace(input: string): { uri: vscode.Uri; fsPath: string; rel: string } {
  const root = workspaceRoot();
  if (!root) {
    throw new Error('No open workspace folder.');
  }
  const abs = path.isAbsolute(input) ? path.normalize(input) : path.normalize(path.join(root, input));
  const relToRoot = path.relative(root, abs);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error(`Path "${input}" is outside the workspace; refusing for safety.`);
  }
  return { uri: vscode.Uri.file(abs), fsPath: abs, rel: relToRoot.split(path.sep).join('/') };
}

function textResult(text: string): vscode.LanguageModelToolResult {
  const clipped = text.length > MAX_OUTPUT_CHARS
    ? text.slice(0, MAX_OUTPUT_CHARS) + `\n…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`
    : text;
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clipped)]);
}

function matchPath(query: string, paths: string[]): string | undefined {
  if (paths.includes(query)) return query;
  const lower = query.toLowerCase();
  return paths.find((p) => p.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------------------
// codegraph_runInTerminal — execute a shell command and capture output
// ---------------------------------------------------------------------------

interface RunInTerminalInput {
  command: string;
  explanation?: string;
  cwd?: string;
}

class RunInTerminalTool implements vscode.LanguageModelTool<RunInTerminalInput> {
  /** Reused integrated terminal so repeated commands share one visible panel. */
  private terminal: vscode.Terminal | undefined;

  public constructor(private readonly deps: ToolDeps) {
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === this.terminal) {
        this.terminal = undefined;
      }
    });
  }

  public prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunInTerminalInput>,
  ): vscode.PreparedToolInvocation {
    const command = options.input.command ?? '';
    const prepared: vscode.PreparedToolInvocation = {
      invocationMessage: `Running \`${command}\``,
    };
    if (!cfg<boolean>('autoApproveCommands', false)) {
      prepared.confirmationMessages = {
        title: 'Run command in terminal?',
        message: new vscode.MarkdownString(
          `${options.input.explanation ? options.input.explanation + '\n\n' : ''}CodeGraph wants to run:\n\n\`\`\`\n${command}\n\`\`\`\n\nThis runs in the **CodeGraph Agent** terminal in your workspace folder.`,
        ),
      };
    }
    return prepared;
  }

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInTerminalInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const command = (options.input.command ?? '').trim();
    if (!command) {
      return textResult('Error: no command provided.');
    }
    const root = workspaceRoot();
    if (!root) {
      return textResult('Error: no open workspace folder to run the command in.');
    }
    const cwd = options.input.cwd ? resolveInWorkspace(options.input.cwd).fsPath : root;
    const startedAt = Date.now();
    try {
      const { code, output, visible } = await this.runInIntegratedTerminal(command, cwd, token);
      await this.deps.toolAudit.append({
        tool: 'codegraph_runInTerminal',
        summary: command,
        mutating: true,
        outcome: 'ran',
        durationMs: Date.now() - startedAt,
      });
      const exitLabel = code === undefined ? 'unknown' : String(code);
      const note = visible
        ? ''
        : '\n(Shell integration was unavailable, so output was captured headlessly and is not shown in a terminal panel.)';
      const header = `$ ${command}\n(cwd: ${path.relative(root, cwd) || '.'}, exit code: ${exitLabel})${note}\n\n`;
      return textResult(header + (output.trim() || '(no output)'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.toolAudit.append({
        tool: 'codegraph_runInTerminal',
        summary: command,
        mutating: true,
        outcome: 'error',
        errorMessage: message,
        durationMs: Date.now() - startedAt,
      });
      return textResult(`Command failed: ${message}`);
    }
  }

  /**
   * Run the command in a real, visible VS Code terminal using shell integration
   * (so the user sees it execute, just like Copilot's agent) and capture its
   * output + exit code. Falls back to headless capture if the shell does not
   * provide shell integration in time.
   */
  private async runInIntegratedTerminal(
    command: string,
    cwd: string,
    token: vscode.CancellationToken,
  ): Promise<{ code: number | undefined; output: string; visible: boolean }> {
    const terminal = this.ensureTerminal(cwd);
    terminal.show(true);

    const integration = await waitForShellIntegration(terminal, 5000);
    if (!integration) {
      const { code, output } = await runShellHeadless(command, cwd, token);
      return { code: code ?? undefined, output, visible: false };
    }

    const execution = integration.executeCommand(command);

    let output = '';
    const readPromise = (async () => {
      try {
        for await (const chunk of execution.read()) {
          if (output.length < MAX_OUTPUT_CHARS * 2) output += chunk;
        }
      } catch {
        // stream ended/errored — whatever we captured is fine
      }
    })();

    const code = await new Promise<number | undefined>((resolve) => {
      const timer = setTimeout(() => {
        endSub.dispose();
        cancelSub.dispose();
        resolve(undefined);
      }, DEFAULT_COMMAND_TIMEOUT_MS);
      const endSub = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          clearTimeout(timer);
          endSub.dispose();
          cancelSub.dispose();
          resolve(event.exitCode);
        }
      });
      const cancelSub = token.onCancellationRequested(() => {
        clearTimeout(timer);
        endSub.dispose();
        cancelSub.dispose();
        resolve(undefined);
      });
    });

    await readPromise;
    return { code, output: stripAnsi(output), visible: true };
  }

  private ensureTerminal(cwd: string): vscode.Terminal {
    if (!this.terminal || this.terminal.exitStatus !== undefined) {
      this.terminal = vscode.window.createTerminal({ name: 'CodeGraph Agent', cwd });
    }
    return this.terminal;
  }
}

/** Resolve the terminal's shell integration, waiting briefly if it is still initializing. */
function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(undefined);
    }, timeoutMs);
    const sub = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        clearTimeout(timer);
        sub.dispose();
        resolve(event.shellIntegration);
      }
    });
  });
}

function stripAnsi(text: string): string {
  // ESC/BEL built from char codes so no literal control chars live in the source.
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const csi = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
  const osc = new RegExp(ESC + '\\][\\s\\S]*?(?:' + BEL + '|' + ESC + '\\\\)', 'g');
  const lone = new RegExp(ESC, 'g');
  return text.replace(osc, '').replace(csi, '').replace(lone, '');
}

/** Fallback used only when the shell provides no shell integration. */
function runShellHeadless(
  command: string,
  cwd: string,
  token: vscode.CancellationToken,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      windowsHide: true,
    });

    let output = '';
    const append = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT_CHARS * 2) {
        output += chunk.toString('utf8');
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${DEFAULT_COMMAND_TIMEOUT_MS / 1000}s`));
    }, DEFAULT_COMMAND_TIMEOUT_MS);

    const cancel = token.onCancellationRequested(() => {
      child.kill();
      reject(new Error('cancelled'));
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      cancel.dispose();
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      cancel.dispose();
      resolve({ code, output });
    });
  });
}

// ---------------------------------------------------------------------------
// codegraph_readFile — read a workspace file (read-only, no confirmation)
// ---------------------------------------------------------------------------

interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

class ReadFileTool implements vscode.LanguageModelTool<ReadFileInput> {
  public prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ReadFileInput>,
  ): vscode.PreparedToolInvocation {
    return { invocationMessage: `Reading \`${options.input.path}\`` };
  }

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReadFileInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { uri, rel } = resolveInWorkspace(options.input.path);
      // Reading a directory throws a raw EISDIR; intercept it with a clear, actionable
      // message so the model self-corrects (and the chat shows a clean note, not a stack).
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        return textResult(
          `"${rel}" is a directory, not a file. Use codegraph_listDirectory to see its contents, or codegraph_findFiles to locate files inside it.`,
        );
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      // Split on CRLF or LF so the numbered view never carries a stray trailing \r — otherwise
      // the model copies that \r into a `find` string that then won't match cleanly.
      const allLines = Buffer.from(bytes).toString('utf8').split(/\r?\n/u);
      const start = Math.max(1, options.input.startLine ?? 1);
      const end = Math.min(allLines.length, options.input.endLine ?? allLines.length);
      const slice = allLines.slice(start - 1, end);
      const numbered = slice.map((line, i) => `${start + i}\t${line}`).join('\n');
      return textResult(`# ${rel} (lines ${start}-${end} of ${allLines.length})\n${numbered}`);
    } catch (error) {
      return textResult(`Error reading file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// codegraph_writeFile — create/overwrite a file (confirmation by default)
// ---------------------------------------------------------------------------

interface WriteFileInput {
  path: string;
  content: string;
}

class WriteFileTool implements vscode.LanguageModelTool<WriteFileInput> {
  public constructor(private readonly deps: ToolDeps) {}

  public async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<WriteFileInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const prepared: vscode.PreparedToolInvocation = { invocationMessage: `Writing \`${options.input.path}\`` };
    if (!cfg<boolean>('autoApproveEdits', false)) {
      let exists = false;
      try {
        const { uri } = resolveInWorkspace(options.input.path);
        await vscode.workspace.fs.stat(uri);
        exists = true;
      } catch {
        exists = false;
      }
      prepared.confirmationMessages = {
        title: exists ? 'Overwrite file?' : 'Create file?',
        message: new vscode.MarkdownString(
          `CodeGraph wants to ${exists ? 'overwrite' : 'create'} \`${options.input.path}\` (${Buffer.byteLength(options.input.content ?? '', 'utf8')} bytes).`,
        ),
      };
    }
    return prepared;
  }

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<WriteFileInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { uri, rel } = resolveInWorkspace(options.input.path);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(options.input.content ?? '', 'utf8'));
      await this.deps.toolAudit.append({
        tool: 'codegraph_writeFile',
        summary: rel,
        mutating: true,
        outcome: 'ran',
      });
      return textResult(`Wrote ${Buffer.byteLength(options.input.content ?? '', 'utf8')} bytes to ${rel}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.toolAudit.append({ tool: 'codegraph_writeFile', summary: options.input.path, mutating: true, outcome: 'error', errorMessage: message });
      return textResult(`Error writing file: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// codegraph_replaceInFile — targeted string replacement (confirmation)
// ---------------------------------------------------------------------------

interface ReplaceInFileInput {
  path: string;
  find: string;
  replace: string;
  all?: boolean;
}

class ReplaceInFileTool implements vscode.LanguageModelTool<ReplaceInFileInput> {
  public constructor(private readonly deps: ToolDeps) {}

  public prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ReplaceInFileInput>,
  ): vscode.PreparedToolInvocation {
    const prepared: vscode.PreparedToolInvocation = { invocationMessage: `Editing \`${options.input.path}\`` };
    if (!cfg<boolean>('autoApproveEdits', false)) {
      prepared.confirmationMessages = {
        title: 'Apply edit?',
        message: new vscode.MarkdownString(
          `CodeGraph wants to replace ${options.input.all ? 'all occurrences' : 'the first occurrence'} of a snippet in \`${options.input.path}\`.`,
        ),
      };
    }
    return prepared;
  }

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReplaceInFileInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const { uri, rel } = resolveInWorkspace(options.input.path);
      const original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const { find, replace, all } = options.input;
      // Tolerant match: handles CRLF-vs-LF (common on Windows/.NET) and indentation/trailing-
      // whitespace drift, and preserves the file's original line endings on write.
      const result = applyReplace(original, find, replace, all);
      if (!result) {
        return textResult(
          `Error: the "find" text was not found in ${rel} (tried exact, line-ending-normalized, and ` +
            'whitespace-flexible matching). Re-read the file with codegraph_readFile and copy the snippet ' +
            'exactly as shown, or use codegraph_writeFile to rewrite the file.',
        );
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(result.updated, 'utf8'));
      await this.deps.toolAudit.append({ tool: 'codegraph_replaceInFile', summary: rel, mutating: true, outcome: 'ran' });
      const how = result.strategy === 'exact' ? '' : ` (matched via ${result.strategy})`;
      return textResult(`Replaced ${result.count} occurrence(s) in ${rel}${how}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.toolAudit.append({ tool: 'codegraph_replaceInFile', summary: options.input.path, mutating: true, outcome: 'error', errorMessage: message });
      return textResult(`Error editing file: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// codegraph_listDirectory — list entries in a folder (read-only)
// ---------------------------------------------------------------------------

interface ListDirectoryInput {
  path?: string;
}

class ListDirectoryTool implements vscode.LanguageModelTool<ListDirectoryInput> {
  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListDirectoryInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const target = options.input.path && options.input.path.trim() ? options.input.path : '.';
      const { uri, rel } = resolveInWorkspace(target);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const lines = entries
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, type]) => `${type === vscode.FileType.Directory ? '📁' : '📄'} ${name}`);
      return textResult(`# ${rel || '.'} (${entries.length} entries)\n${lines.join('\n')}`);
    } catch (error) {
      return textResult(`Error listing directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// codegraph_findFiles — glob search for filenames (read-only)
// ---------------------------------------------------------------------------

interface FindFilesInput {
  glob: string;
  maxResults?: number;
}

class FindFilesTool implements vscode.LanguageModelTool<FindFilesInput> {
  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FindFilesInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const glob = options.input.glob?.trim() || '**/*';
    const max = Math.min(Math.max(options.input.maxResults ?? 50, 1), 500);
    const uris = await vscode.workspace.findFiles(glob, '**/{node_modules,dist,build,.git}/**', max);
    const paths = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort();
    return textResult(`# Files matching ${glob} (${paths.length})\n${paths.map((p) => `- ${p}`).join('\n') || '(none)'}`);
  }
}

// ---------------------------------------------------------------------------
// Graph-native tools — CodeGraph's differentiator (local, no file/process I/O)
// ---------------------------------------------------------------------------

interface ImpactInput {
  file: string;
  depth?: number;
}

class ImpactTool implements vscode.LanguageModelTool<ImpactInput> {
  public constructor(private readonly deps: ToolDeps) {}

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ImpactInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const files = this.deps.store.getFiles();
    const seed = matchPath(options.input.file, files.map((f) => f.path));
    if (!seed) {
      return textResult(`No indexed file matches "${options.input.file}".`);
    }
    const impacted = impactSet(buildFileGraph(files), seed, options.input.depth ?? 4);
    return textResult(
      `Impact set for ${seed} (${impacted.length} files that transitively import it):\n${impacted.map((p) => `- ${p}`).join('\n') || '(none — it is a leaf)'}`,
    );
  }
}

interface DependencyPathInput {
  from: string;
  to: string;
}

class DependencyPathTool implements vscode.LanguageModelTool<DependencyPathInput> {
  public constructor(private readonly deps: ToolDeps) {}

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DependencyPathInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const files = this.deps.store.getFiles();
    const paths = files.map((f) => f.path);
    const from = matchPath(options.input.from, paths);
    const to = matchPath(options.input.to, paths);
    if (!from || !to) {
      return textResult(`Could not match ${!from ? `"${options.input.from}"` : `"${options.input.to}"`} to an indexed file.`);
    }
    const result = shortestPath(buildFileGraph(files), from, to);
    if (!result.found) {
      return textResult(`No import path connects ${from} and ${to}.`);
    }
    return textResult(`Shortest path (${result.hopCount} hops):\n${result.path.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
  }
}

interface GodNodesInput {
  limit?: number;
}

class GodNodesTool implements vscode.LanguageModelTool<GodNodesInput> {
  public constructor(private readonly deps: ToolDeps) {}

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GodNodesInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const files = this.deps.store.getFiles();
    const limit = Math.min(Math.max(options.input.limit ?? 15, 1), 100);
    const degrees = computeDegrees(buildFileGraph(files)).slice(0, limit);
    return textResult(
      `Most-connected files (degree centrality):\n${degrees.map((d) => `- ${d.path} — total ${d.totalDegree} (in ${d.inDegree}, out ${d.outDegree})`).join('\n') || '(no index)'}`,
    );
  }
}
