import * as vscode from 'vscode';

export type PrivacyMode = 'local-only' | 'preview-before-send' | 'standard';

export interface PrivacyState {
  mode: PrivacyMode;
  totalRequests: number;
  totalBytesSent: number;
  lastRequestAt?: Date;
}

const configRoot = 'codegraph';

export class PrivacyManager {
  private readonly stateEmitter = new vscode.EventEmitter<PrivacyState>();
  public readonly onDidChangeState = this.stateEmitter.event;
  private totalRequests = 0;
  private totalBytesSent = 0;
  private lastRequestAt: Date | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(configRoot)) {
          this.emit();
        }
      }),
    );
  }

  public getMode(): PrivacyMode {
    const value = vscode.workspace.getConfiguration(configRoot).get<string>('privacyMode', 'standard');
    if (value === 'local-only' || value === 'preview-before-send' || value === 'standard') {
      return value;
    }
    return 'standard';
  }

  public isLocalOnly(): boolean {
    return this.getMode() === 'local-only';
  }

  public requiresPreview(): boolean {
    return this.getMode() === 'preview-before-send';
  }

  public async setMode(mode: PrivacyMode): Promise<void> {
    await vscode.workspace
      .getConfiguration(configRoot)
      .update('privacyMode', mode, vscode.ConfigurationTarget.Workspace);
    this.emit();
  }

  public recordRequest(bytes: number): void {
    this.totalRequests += 1;
    this.totalBytesSent += bytes;
    this.lastRequestAt = new Date();
    this.emit();
  }

  public getState(): PrivacyState {
    return {
      mode: this.getMode(),
      totalRequests: this.totalRequests,
      totalBytesSent: this.totalBytesSent,
      lastRequestAt: this.lastRequestAt,
    };
  }

  public dispose(): void {
    this.stateEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private emit(): void {
    this.stateEmitter.fire(this.getState());
  }
}
