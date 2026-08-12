import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ComplexityTier } from '../context/complexityScorer';

interface CachedClassification {
  tier: ComplexityTier;
  score: number;
  /** ISO timestamp; used to trim the oldest entries when the cache grows. */
  at: string;
}

interface TierChoice {
  modelId: string;
  modelName: string;
  /** How many times the user picked this model for this tier — used to order/default the prompt. */
  count: number;
}

interface ModelPrefsData {
  version: 1;
  /** queryHash -> last classification, so repeated questions never re-hit a model. */
  cache: Record<string, CachedClassification>;
  /** tier -> the model the user tends to choose, so we can default the switch prompt. */
  tierChoices: Partial<Record<ComplexityTier, TierChoice>>;
}

const FILE_NAME = 'model-prefs.json';
const MAX_CACHE_ENTRIES = 500;

function emptyData(): ModelPrefsData {
  return { version: 1, cache: {}, tierChoices: {} };
}

/**
 * Small persisted memory for the model-suggestion feature. Holds two things:
 *  1. a classification cache (so a question we've already graded is free next time), and
 *  2. the user's per-tier model choices (so the switch prompt can default to what they
 *     usually pick).
 *
 * Stored as a single JSON file in global storage — same location pattern as the audit
 * logs. Nothing here ever leaves the machine.
 */
export class ModelPreferenceStore {
  private readonly fileUri: vscode.Uri;
  private data: ModelPrefsData = emptyData();
  private loaded = false;

  public constructor(storageUri: vscode.Uri) {
    this.fileUri = vscode.Uri.joinPath(storageUri, FILE_NAME);
  }

  public async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<ModelPrefsData>;
      this.data = {
        version: 1,
        cache: parsed.cache ?? {},
        tierChoices: parsed.tierChoices ?? {},
      };
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
        // Corrupt/unreadable prefs should never break chat — start clean.
        this.data = emptyData();
      }
    }
  }

  public getCachedClassification(task: string): CachedClassification | undefined {
    return this.data.cache[ModelPreferenceStore.hashQuery(task)];
  }

  public async cacheClassification(task: string, tier: ComplexityTier, score: number): Promise<void> {
    this.data.cache[ModelPreferenceStore.hashQuery(task)] = { tier, score, at: new Date().toISOString() };
    this.trimCache();
    await this.persist();
  }

  public getPreferredModelId(tier: ComplexityTier): string | undefined {
    return this.data.tierChoices[tier]?.modelId;
  }

  public async recordChoice(tier: ComplexityTier, modelId: string, modelName: string): Promise<void> {
    const existing = this.data.tierChoices[tier];
    this.data.tierChoices[tier] = {
      modelId,
      modelName,
      count: existing && existing.modelId === modelId ? existing.count + 1 : 1,
    };
    await this.persist();
  }

  public async clear(): Promise<void> {
    this.data = emptyData();
    await this.persist();
  }

  public dispose(): void {
    // Nothing to dispose; persistence is synchronous-on-write. Kept for symmetry.
  }

  public static hashQuery(task: string): string {
    const normalized = task.trim().toLowerCase().replace(/\s+/gu, ' ');
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  }

  private trimCache(): void {
    const keys = Object.keys(this.data.cache);
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    keys
      .sort((a, b) => this.data.cache[a].at.localeCompare(this.data.cache[b].at))
      .slice(0, keys.length - MAX_CACHE_ENTRIES)
      .forEach((key) => delete this.data.cache[key]);
  }

  private async persist(): Promise<void> {
    const dir = vscode.Uri.joinPath(this.fileUri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(JSON.stringify(this.data, null, 2), 'utf8'));
  }
}
