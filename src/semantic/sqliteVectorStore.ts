/**
 * Persistent chunk-vector store for headless hosts (CLI / MCP server), backed by sql.js —
 * already a dependency (the extension's SqliteGraphStore is prior art), pure WASM, no native
 * build. One database per repo, under `~/.graphweft/index/<repo-hash>/semantic.db`, so
 * embeddings survive across CLI invocations and MCP restarts: only changed chunks are ever
 * re-embedded.
 *
 * Vectors are Float32 BLOBs (~4 bytes/dim). Search is brute-force cosine over all chunks —
 * at symbol granularity even large repos stay in the tens of thousands of chunks, which is
 * a few milliseconds of dot products; no ANN structure is warranted yet.
 *
 * No vscode imports — plain node fs.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs, { Database, SqlValue } from 'sql.js';
import { CodeChunk } from './codeChunker';

const SCHEMA_VERSION = 1;
const DB_FILE = 'semantic.db';

export interface ChunkMatch {
  id: string;
  path: string;
  kind: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  /** Cosine similarity in [-1, 1]. */
  similarity: number;
}

export interface VectorStoreStats {
  chunks: number;
  files: number;
  providerId: string;
  dims: number;
}

/** Root of Graphweft's per-repo caches. Env override: GRAPHWEFT_CACHE_DIR. */
export function cacheRootDir(): string {
  return process.env.GRAPHWEFT_CACHE_DIR ?? path.join(os.homedir(), '.graphweft', 'index');
}

/** Stable per-repo cache directory derived from the repo's absolute path. */
export function repoCacheDir(repoRoot: string): string {
  const normalized = path.resolve(repoRoot).toLowerCase().replace(/\\/g, '/');
  const hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
  return path.join(cacheRootDir(), hash);
}

export class SqliteVectorStore {
  private constructor(
    private readonly database: Database,
    private readonly dbPath: string,
  ) {}

  /** Open (or create) the vector store for a repo. Corrupt databases are recreated empty. */
  public static async open(repoRoot: string): Promise<SqliteVectorStore> {
    const dir = repoCacheDir(repoRoot);
    const dbPath = path.join(dir, DB_FILE);
    const sql = await initSqlJs({
      locateFile: (fileName) => require.resolve(`sql.js/dist/${fileName}`),
    });

    let database: Database | undefined;
    if (fs.existsSync(dbPath)) {
      try {
        database = new sql.Database(fs.readFileSync(dbPath));
        const version = readMeta(database, 'schema_version');
        if (version !== String(SCHEMA_VERSION)) database = undefined;
      } catch {
        database = undefined;
      }
    }
    database ??= createEmpty(sql.Database);
    return new SqliteVectorStore(database, dbPath);
  }

  /** In-memory store for tests. */
  public static async openInMemory(): Promise<SqliteVectorStore> {
    const sql = await initSqlJs({
      locateFile: (fileName) => require.resolve(`sql.js/dist/${fileName}`),
    });
    return new SqliteVectorStore(createEmpty(sql.Database), '');
  }

  /** Provider identity the stored vectors came from ('' when empty/new). */
  public getProviderId(): string {
    return readMeta(this.database, 'provider_id') ?? '';
  }

  /** Wipe all vectors and stamp the store for a (new) provider. */
  public reset(providerId: string): void {
    this.database.exec('DELETE FROM chunks;');
    writeMeta(this.database, 'provider_id', providerId);
  }

  /** chunk id → stored content hash, for computing the re-embed set. */
  public getChunkHashes(): Map<string, string> {
    const hashes = new Map<string, string>();
    for (const [id, hash] of this.rows('SELECT id, hash FROM chunks;')) {
      hashes.set(String(id), String(hash));
    }
    return hashes;
  }

  public upsert(chunk: CodeChunk, vector: Float32Array | number[]): void {
    const data = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    const blob = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const statement = this.database.prepare(
      `INSERT OR REPLACE INTO chunks (id, path, kind, symbol, start_line, end_line, hash, vector)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    );
    try {
      statement.run([chunk.id, chunk.path, chunk.kind, chunk.symbol ?? null, chunk.startLine, chunk.endLine, chunk.hash, blob]);
    } finally {
      statement.free();
    }
  }

  /** Drop chunks whose id is not in `keep` (deleted files, renamed/removed symbols). */
  public retainOnly(keep: ReadonlySet<string>): number {
    const stale: string[] = [];
    for (const [id] of this.rows('SELECT id FROM chunks;')) {
      if (!keep.has(String(id))) stale.push(String(id));
    }
    if (stale.length > 0) {
      const statement = this.database.prepare('DELETE FROM chunks WHERE id = ?;');
      try {
        for (const id of stale) statement.run([id]);
      } finally {
        statement.free();
      }
    }
    return stale.length;
  }

  /** Brute-force cosine top-K across all stored chunks. */
  public search(query: Float32Array | number[], topK: number, minSimilarity = 0.3): ChunkMatch[] {
    const q = query instanceof Float32Array ? query : Float32Array.from(query);
    const qNorm = norm(q);
    if (qNorm === 0) return [];

    const matches: ChunkMatch[] = [];
    for (const row of this.rows('SELECT id, path, kind, symbol, start_line, end_line, vector FROM chunks;')) {
      const vector = decodeBlob(row[6]);
      if (!vector || vector.length !== q.length) continue;
      const vNorm = norm(vector);
      if (vNorm === 0) continue;
      const similarity = dot(q, vector) / (qNorm * vNorm);
      if (similarity < minSimilarity) continue;
      matches.push({
        id: String(row[0]),
        path: String(row[1]),
        kind: String(row[2]),
        symbol: row[3] === null ? undefined : String(row[3]),
        startLine: Number(row[4]),
        endLine: Number(row[5]),
        similarity,
      });
    }
    return matches
      .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
      .slice(0, topK);
  }

  public stats(): VectorStoreStats {
    const chunkRows = this.rows('SELECT COUNT(*), COUNT(DISTINCT path) FROM chunks;');
    const [count, files] = chunkRows[0] ?? [0, 0];
    const sample = this.rows('SELECT vector FROM chunks LIMIT 1;');
    const dims = sample.length > 0 ? (decodeBlob(sample[0][0])?.length ?? 0) : 0;
    return { chunks: Number(count), files: Number(files), providerId: this.getProviderId(), dims };
  }

  /** Write the database to disk (no-op for in-memory stores). */
  public persist(): void {
    if (!this.dbPath) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, this.database.export());
  }

  /** Delete the on-disk database and clear memory. */
  public wipe(): void {
    this.database.exec('DELETE FROM chunks;');
    writeMeta(this.database, 'provider_id', '');
    if (this.dbPath && fs.existsSync(this.dbPath)) fs.rmSync(this.dbPath);
  }

  private rows(query: string): SqlValue[][] {
    const results = this.database.exec(query);
    return results.length > 0 ? results[0].values : [];
  }
}

function createEmpty(DatabaseCtor: new (data?: Uint8Array) => Database): Database {
  const database = new DatabaseCtor();
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      vector BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks (path);
  `);
  writeMeta(database, 'schema_version', String(SCHEMA_VERSION));
  return database;
}

function readMeta(database: Database, key: string): string | undefined {
  const results = database.exec(`SELECT value FROM meta WHERE key = '${key.replace(/'/g, "''")}';`);
  const value = results[0]?.values[0]?.[0];
  return value === undefined || value === null ? undefined : String(value);
}

function writeMeta(database: Database, key: string, value: string): void {
  const statement = database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?);');
  try {
    statement.run([key, value]);
  } finally {
    statement.free();
  }
}

function decodeBlob(value: SqlValue): Float32Array | undefined {
  if (!(value instanceof Uint8Array)) return undefined;
  // Float32Array views need 4-byte alignment; sql.js blob offsets don't guarantee it.
  const bytes = value.byteOffset % 4 === 0 ? value : value.slice();
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(v: Float32Array): number {
  return Math.sqrt(dot(v, v));
}
