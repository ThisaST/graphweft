/**
 * Tiny in-memory vector index with cosine top-K search and a compact serialized form.
 *
 * Scale check: one vector per workspace file (not per chunk), so even a 5,000-file repo is a
 * few thousand dot products per query — sub-millisecond, no ANN structure needed. Vectors are
 * stored base64-encoded Float32 to keep the on-disk JSON ~4 bytes/dimension instead of ~8–12
 * for JSON number arrays.
 *
 * Pure module (no vscode) so the math and round-tripping are unit-testable.
 */

export interface VectorEntry {
  /** Workspace-relative file path this vector describes. */
  path: string;
  /** Content hash of the embedded document — unchanged hash ⇒ no re-embed needed. */
  hash: string;
  vector: Float32Array;
}

export interface SemanticMatch {
  path: string;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  similarity: number;
}

interface SerializedEntry {
  path: string;
  hash: string;
  /** base64-encoded little-endian Float32 values. */
  v: string;
}

export interface SerializedIndex {
  /** Provider identity (endpoint+model) the vectors came from; mismatch ⇒ full rebuild. */
  providerId: string;
  entries: SerializedEntry[];
}

export class VectorIndex {
  private readonly entries = new Map<string, VectorEntry>();

  public constructor(public providerId: string = '') {}

  public size(): number {
    return this.entries.size;
  }

  public get(path: string): VectorEntry | undefined {
    return this.entries.get(path);
  }

  public upsert(entry: VectorEntry): void {
    this.entries.set(entry.path, entry);
  }

  public delete(path: string): void {
    this.entries.delete(path);
  }

  /** Drop entries for paths not in `keep` (files deleted/renamed since last index). */
  public retainOnly(keep: ReadonlySet<string>): void {
    for (const path of [...this.entries.keys()]) {
      if (!keep.has(path)) this.entries.delete(path);
    }
  }

  /** Cosine top-K over all entries. `minSimilarity` filters out noise matches. */
  public search(query: Float32Array | number[], topK: number, minSimilarity = 0.3): SemanticMatch[] {
    const q = query instanceof Float32Array ? query : Float32Array.from(query);
    const qNorm = norm(q);
    if (qNorm === 0) return [];

    const matches: SemanticMatch[] = [];
    for (const entry of this.entries.values()) {
      if (entry.vector.length !== q.length) continue;
      const similarity = dot(q, entry.vector) / (qNorm * norm(entry.vector));
      if (similarity >= minSimilarity) {
        matches.push({ path: entry.path, similarity });
      }
    }
    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
  }

  public serialize(): SerializedIndex {
    return {
      providerId: this.providerId,
      entries: [...this.entries.values()].map((entry) => ({
        path: entry.path,
        hash: entry.hash,
        v: encodeVector(entry.vector),
      })),
    };
  }

  public static deserialize(data: SerializedIndex): VectorIndex {
    const index = new VectorIndex(data.providerId);
    for (const entry of data.entries) {
      index.upsert({ path: entry.path, hash: entry.hash, vector: decodeVector(entry.v) });
    }
    return index;
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(v: Float32Array): number {
  return Math.sqrt(dot(v, v));
}

export function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

export function decodeVector(encoded: string): Float32Array {
  const buffer = Buffer.from(encoded, 'base64');
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}
