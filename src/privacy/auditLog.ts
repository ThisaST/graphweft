import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface AuditEntry {
  id: string;
  timestamp: string;
  task: string;
  taskType: string;
  modelId: string;
  modelVendor: string;
  promptBytes: number;
  promptSha256: string;
  filesIncluded: string[];
  symbolsIncluded: string[];
  snippetsIncluded: number;
  outcome: 'sent' | 'cancelled' | 'blocked' | 'error';
  durationMs?: number;
  errorMessage?: string;
  /**
   * Byte size of every file the retriever flagged as relevant, plus a small prompt overhead.
   * This is the "naive RAG would dump these files raw" baseline used by the token-savings analyzer.
   * Optional so older log entries written before the analyzer existed still parse.
   */
  naiveBaselineBytes?: number;
  /**
   * Real tokenizer count (model.countTokens) of the first assembled context prompt. When present,
   * the savings analyzer uses this instead of the bytes/4 estimate.
   */
  promptTokens?: number;
  /**
   * Real tokenizer count of the naive file-dump baseline (every relevant file's full contents).
   * Preferred over `naiveBaselineBytes / 4` when present.
   */
  baselineTokens?: number;
  /**
   * Total input tokens consumed across the whole agentic loop — every round re-sends the full
   * conversation, so this is the true end-to-end input cost, not just the first context.
   */
  totalInputTokens?: number;
  /** Number of model round-trips the agent loop made for this request. */
  modelRounds?: number;
  /**
   * Real tokenizer count of all text the model generated across the loop (the completion /
   * output side). Combined with `totalInputTokens` this gives total spend for the request.
   */
  outputTokens?: number;
}

const auditFileName = 'audit-log.jsonl';

export class AuditLog {
  private readonly logUri: vscode.Uri;
  private readonly entries: AuditEntry[] = [];
  private loaded = false;
  private readonly emitter = new vscode.EventEmitter<AuditEntry>();
  public readonly onDidAppend = this.emitter.event;

  public constructor(storageUri: vscode.Uri) {
    this.logUri = vscode.Uri.joinPath(storageUri, auditFileName);
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
          this.entries.push(JSON.parse(trimmed) as AuditEntry);
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

  public async append(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
    await this.load();
    const full: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);
    await this.persist();
    this.emitter.fire(full);
    return full;
  }

  public list(limit?: number): AuditEntry[] {
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

  public static hashPrompt(prompt: string): string {
    return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  }

  private async persist(): Promise<void> {
    const dir = vscode.Uri.joinPath(this.logUri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    const text = this.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await vscode.workspace.fs.writeFile(this.logUri, Buffer.from(text, 'utf8'));
  }
}
