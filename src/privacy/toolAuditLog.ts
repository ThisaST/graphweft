import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * A persistent record of every agent tool the model invoked. This is the
 * "actions" counterpart of the model-call {@link AuditLog}: it lets a team see,
 * after the fact, exactly which commands were run and which files were touched
 * by the @codegraph agent — keeping the "local-first, nothing happens without a
 * trace" promise even now that the agent can act on the workspace.
 */
export interface ToolAuditEntry {
  id: string;
  timestamp: string;
  /** Tool name, e.g. `codegraph_runInTerminal`. */
  tool: string;
  /** Short human-readable summary of what was invoked (command line, file path…). */
  summary: string;
  /** Whether this tool mutates the workspace / runs a process (vs. read-only). */
  mutating: boolean;
  /** 'ran' when executed, 'denied' when the user declined confirmation, 'error' on failure. */
  outcome: 'ran' | 'denied' | 'error';
  durationMs?: number;
  errorMessage?: string;
}

const toolLogFileName = 'tool-log.jsonl';

export class ToolAuditLog {
  private readonly logUri: vscode.Uri;
  private readonly entries: ToolAuditEntry[] = [];
  private loaded = false;
  private readonly emitter = new vscode.EventEmitter<ToolAuditEntry>();
  public readonly onDidAppend = this.emitter.event;

  public constructor(storageUri: vscode.Uri) {
    this.logUri = vscode.Uri.joinPath(storageUri, toolLogFileName);
  }

  public getLogPath(): string {
    return this.logUri.fsPath;
  }

  public async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.logUri);
      const text = Buffer.from(bytes).toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.entries.push(JSON.parse(trimmed) as ToolAuditEntry);
        } catch {
          // skip malformed
        }
      }
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
        throw error;
      }
    }
  }

  public async append(entry: Omit<ToolAuditEntry, 'id' | 'timestamp'>): Promise<ToolAuditEntry> {
    await this.load();
    const full: ToolAuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);
    await this.persist();
    this.emitter.fire(full);
    return full;
  }

  public list(limit?: number): ToolAuditEntry[] {
    const reversed = [...this.entries].reverse();
    return limit ? reversed.slice(0, limit) : reversed;
  }

  public count(): number {
    return this.entries.length;
  }

  public async clear(): Promise<void> {
    this.entries.length = 0;
    await this.persist();
  }

  public dispose(): void {
    this.emitter.dispose();
  }

  private async persist(): Promise<void> {
    const dir = vscode.Uri.joinPath(this.logUri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    const text = this.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await vscode.workspace.fs.writeFile(this.logUri, Buffer.from(text, 'utf8'));
  }
}
