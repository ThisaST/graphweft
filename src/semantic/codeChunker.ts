/**
 * AST-aware code chunking for the semantic index. Instead of blind fixed-size text slices,
 * chunks follow the code's own structure, reusing what the graph index already knows:
 *
 *   1. one chunk per top-level symbol (function/class/method…) — the symbol's source lines,
 *      prefixed with a "situating header" (file path › parent › signature) so the vector
 *      carries the code's identity and location, not just its tokens;
 *   2. one file-summary chunk (the existing structured semantic doc) so coarse
 *      "which file does X" queries keep working;
 *   3. a sliding-window fallback for files where the indexers found no symbols
 *      (configs, docs, unsupported languages).
 *
 * Every chunk gets a stable content hash so the indexer re-embeds only what changed.
 * Pure module (no vscode, no IO) — fully unit-testable.
 */
import * as crypto from 'crypto';
import { GraphweftFile, CodeSymbol } from '../graph/graphTypes';
import { buildSemanticDoc } from './semanticDoc';

export type ChunkKind = 'symbol' | 'file-summary' | 'window';

export interface CodeChunk {
  /** Stable identity: `<path>#<kind>:<discriminator>` — unique within a repo. */
  id: string;
  path: string;
  kind: ChunkKind;
  /** Symbol name for `symbol` chunks (qualified with parent when nested). */
  symbol?: string;
  startLine: number;
  endLine: number;
  /** The text that gets embedded (situating header + body). */
  text: string;
  /** SHA-256 (truncated) of `text` — unchanged hash ⇒ reuse the stored vector. */
  hash: string;
}

export interface ChunkOptions {
  /** Max characters of body text per chunk (headers excluded). */
  maxChunkChars?: number;
  /** Max symbol chunks per file (guards pathological generated files). */
  maxChunksPerFile?: number;
  /** Window size in lines for the no-symbols fallback. */
  windowLines?: number;
  /** Overlap in lines between consecutive fallback windows. */
  windowOverlap?: number;
}

const defaults: Required<ChunkOptions> = {
  maxChunkChars: 1500,
  maxChunksPerFile: 200,
  windowLines: 60,
  windowOverlap: 10,
};

/**
 * Chunk one file. `text` is the file's current source (the scanners already hold it);
 * `file` is its graph-index entry with symbols and line ranges.
 */
export function chunkFile(file: GraphweftFile, text: string, options?: ChunkOptions): CodeChunk[] {
  const opts = { ...defaults, ...options };
  const lines = text.split(/\r\n|\r|\n/);
  const chunks: CodeChunk[] = [];

  const summaryText = buildSemanticDoc(file);
  chunks.push(makeChunk(file.path, 'file-summary', 'summary', undefined, 1, Math.max(lines.length, 1), summaryText));

  const symbols = selectChunkableSymbols(file.symbols).slice(0, opts.maxChunksPerFile);
  for (const symbol of symbols) {
    const start = clampLine(symbol.lineRange.start, lines.length);
    const end = clampLine(symbol.lineRange.end, lines.length);
    const body = truncate(lines.slice(start - 1, end).join('\n'), opts.maxChunkChars);
    const qualified = symbol.parentName ? `${symbol.parentName}.${symbol.name}` : symbol.name;
    const header = situatingHeader(file, symbol, qualified);
    chunks.push(
      makeChunk(file.path, 'symbol', `${qualified}@${start}`, qualified, start, end, `${header}\n${body}`),
    );
  }

  if (symbols.length === 0 && lines.length > 0 && text.trim().length > 0) {
    chunks.push(...windowChunks(file.path, lines, opts));
  }

  return chunks;
}

/**
 * Top-level symbols only: methods are covered by their enclosing class chunk, so embedding
 * them separately would duplicate text and bloat the index. Exception: methods whose parent
 * was NOT indexed as a symbol (partial indexers) still get their own chunk.
 */
function selectChunkableSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const names = new Set(symbols.map((symbol) => symbol.name));
  return symbols.filter((symbol) => !symbol.parentName || !names.has(symbol.parentName));
}

/**
 * The situating header is what makes small chunk vectors reliable: the model sees where the
 * code lives and what it is, so "auth middleware in the API layer" can match on structure,
 * not just on tokens that happen to appear in the body.
 */
function situatingHeader(file: GraphweftFile, symbol: CodeSymbol, qualified: string): string {
  const parts = [`// ${file.path}`];
  if (file.moduleName) parts.push(`module ${file.moduleName}`);
  parts.push(`${symbol.type} ${qualified}`);
  if (symbol.signature && symbol.signature !== qualified) parts.push(symbol.signature);
  return parts.join(' › ');
}

function windowChunks(path: string, lines: string[], opts: Required<ChunkOptions>): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const step = Math.max(1, opts.windowLines - opts.windowOverlap);
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + opts.windowLines, lines.length);
    const body = truncate(lines.slice(start, end).join('\n'), opts.maxChunkChars);
    if (body.trim().length === 0) continue;
    chunks.push(
      makeChunk(path, 'window', `${start + 1}`, undefined, start + 1, end, `// ${path} (lines ${start + 1}-${end})\n${body}`),
    );
    if (chunks.length >= opts.maxChunksPerFile || end >= lines.length) break;
  }
  return chunks;
}

function makeChunk(
  path: string,
  kind: ChunkKind,
  discriminator: string,
  symbol: string | undefined,
  startLine: number,
  endLine: number,
  text: string,
): CodeChunk {
  return {
    id: `${path}#${kind}:${discriminator}`,
    path,
    kind,
    symbol,
    startLine,
    endLine,
    text,
    hash: hashChunk(text),
  };
}

export function hashChunk(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function clampLine(line: number, max: number): number {
  return Math.min(Math.max(1, line), Math.max(max, 1));
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n// …truncated`;
}
