import { GraphweftFile } from './graphTypes';
import * as path from 'path';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

export interface FileGraph {
  nodes: string[];
  adjacency: Map<string, Set<string>>;
  reverseAdjacency: Map<string, Set<string>>;
}

export function buildFileGraph(files: GraphweftFile[]): FileGraph {
  const index = buildFileIndex(files);
  const adjacency = new Map<string, Set<string>>();
  const reverseAdjacency = new Map<string, Set<string>>();

  for (const file of files) {
    adjacency.set(file.path, new Set());
    reverseAdjacency.set(file.path, new Set());
  }

  for (const file of files) {
    for (const target of resolveImports(file, index)) {
      if (target.path === file.path) continue;
      adjacency.get(file.path)!.add(target.path);
      reverseAdjacency.get(target.path)!.add(file.path);
    }
  }

  return { nodes: files.map((f) => f.path), adjacency, reverseAdjacency };
}

/** Lookup tables used to resolve imports to files across languages. Built once per graph. */
interface FileIndex {
  byPath: Map<string, GraphweftFile>;
  /** Declared namespace/package -> files that declare it (C#, Java, Kotlin, Scala, PHP, VB). */
  byModule: Map<string, GraphweftFile[]>;
  /** File base name without extension -> files (Python/Go/Rust module-path & include fallback). */
  byBaseName: Map<string, GraphweftFile[]>;
  /** Directory segment name -> directory prefixes ending in it (workspace-package resolution). */
  byDirName: Map<string, string[]>;
  /**
   * Full directory path -> the files directly inside it. Languages whose unit of import is a
   * *directory* rather than a file (Go packages, Java/Kotlin source dirs) resolve through this.
   */
  byDirPath: Map<string, GraphweftFile[]>;
}

function buildFileIndex(files: GraphweftFile[]): FileIndex {
  const byPath = new Map<string, GraphweftFile>();
  const byModule = new Map<string, GraphweftFile[]>();
  const byBaseName = new Map<string, GraphweftFile[]>();
  const byDirName = new Map<string, string[]>();
  const byDirPath = new Map<string, GraphweftFile[]>();

  for (const file of files) {
    byPath.set(file.path, file);

    const dir = path.posix.dirname(file.path);
    if (dir && dir !== '.') push(byDirPath, dir, file);

    if (file.moduleName) {
      push(byModule, file.moduleName, file);
    }

    const base = path.posix.basename(file.path).replace(/\.[^.]+$/u, '');
    if (base) push(byBaseName, base, file);

    let prefix = '';
    for (const segment of path.posix.dirname(file.path).split('/')) {
      if (!segment || segment === '.') continue;
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const prefixes = byDirName.get(segment);
      if (!prefixes) byDirName.set(segment, [prefix]);
      else if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
  }

  return { byPath, byModule, byBaseName, byDirName, byDirPath };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export interface DegreeRow {
  path: string;
  inDegree: number;
  outDegree: number;
  totalDegree: number;
}

export function computeDegrees(graph: FileGraph): DegreeRow[] {
  return graph.nodes
    .map((node) => {
      const inDegree = graph.reverseAdjacency.get(node)?.size ?? 0;
      const outDegree = graph.adjacency.get(node)?.size ?? 0;
      return { path: node, inDegree, outDegree, totalDegree: inDegree + outDegree };
    })
    .sort((a, b) => b.totalDegree - a.totalDegree || a.path.localeCompare(b.path));
}

export interface PathResult {
  found: boolean;
  path: string[];
  hopCount: number;
}

export function shortestPath(graph: FileGraph, from: string, to: string): PathResult {
  if (from === to) return { found: true, path: [from], hopCount: 0 };
  if (!graph.adjacency.has(from) || !graph.adjacency.has(to)) {
    return { found: false, path: [], hopCount: 0 };
  }

  const queue: string[] = [from];
  const visited = new Set<string>([from]);
  const parent = new Map<string, string>();
  const undirected = (node: string): Iterable<string> => [
    ...(graph.adjacency.get(node) ?? []),
    ...(graph.reverseAdjacency.get(node) ?? []),
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === to) {
      const result: string[] = [];
      let cursor: string | undefined = to;
      while (cursor) {
        result.unshift(cursor);
        cursor = parent.get(cursor);
      }
      return { found: true, path: result, hopCount: result.length - 1 };
    }

    for (const neighbor of undirected(current)) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      parent.set(neighbor, current);
      queue.push(neighbor);
    }
  }

  return { found: false, path: [], hopCount: 0 };
}

export function impactSet(graph: FileGraph, seed: string, maxDepth = 3): string[] {
  if (!graph.reverseAdjacency.has(seed)) return [];
  const result = new Set<string>();
  const queue: Array<{ node: string; depth: number }> = [{ node: seed, depth: 0 }];

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    for (const importer of graph.reverseAdjacency.get(node) ?? []) {
      if (result.has(importer)) continue;
      result.add(importer);
      queue.push({ node: importer, depth: depth + 1 });
    }
  }

  return Array.from(result).sort();
}

/**
 * Personalized PageRank over the file import graph (the technique behind Aider's
 * repo-map). The random walk teleports back to the *seed* files (query matches and
 * workspace hints like the active editor or changed files) instead of uniformly, so
 * files that are structurally central **to the current task** rank highest — not
 * just globally popular utilities.
 *
 * Edges are treated bidirectionally with importers weighted slightly lower, since
 * "X imports Y" makes Y relevant to X more strongly than vice versa.
 *
 * @param seeds map of node -> non-negative personalization weight (need not be normalized)
 * @returns map of node -> PageRank score (sums to ~1 over all nodes)
 */
export function personalizedPageRank(
  graph: FileGraph,
  seeds: Map<string, number>,
  damping = 0.85,
  iterations = 30,
  tolerance = 1e-6,
): Map<string, number> {
  const nodes = graph.nodes;
  const n = nodes.length;
  const ranks = new Map<string, number>();
  if (n === 0) return ranks;

  // Normalized teleport vector; uniform when no valid seeds are provided.
  let seedTotal = 0;
  for (const node of nodes) seedTotal += Math.max(0, seeds.get(node) ?? 0);
  const teleport = new Map<string, number>();
  for (const node of nodes) {
    teleport.set(node, seedTotal > 0 ? Math.max(0, seeds.get(node) ?? 0) / seedTotal : 1 / n);
  }

  const reverseWeight = 0.5;
  // Out-weight per node counting forward edges at 1 and reverse edges at reverseWeight.
  const outWeight = new Map<string, number>();
  for (const node of nodes) {
    const forward = graph.adjacency.get(node)?.size ?? 0;
    const reverse = graph.reverseAdjacency.get(node)?.size ?? 0;
    outWeight.set(node, forward + reverse * reverseWeight);
  }

  for (const node of nodes) ranks.set(node, teleport.get(node)!);

  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    let danglingMass = 0;
    for (const node of nodes) {
      next.set(node, 0);
      if ((outWeight.get(node) ?? 0) === 0) danglingMass += ranks.get(node)!;
    }

    for (const node of nodes) {
      const rank = ranks.get(node)!;
      const weight = outWeight.get(node)!;
      if (weight === 0) continue;
      const share = rank / weight;
      for (const target of graph.adjacency.get(node) ?? []) {
        next.set(target, next.get(target)! + share);
      }
      for (const importer of graph.reverseAdjacency.get(node) ?? []) {
        next.set(importer, next.get(importer)! + share * reverseWeight);
      }
    }

    let delta = 0;
    for (const node of nodes) {
      const value = damping * (next.get(node)! + danglingMass * teleport.get(node)!) + (1 - damping) * teleport.get(node)!;
      delta += Math.abs(value - ranks.get(node)!);
      ranks.set(node, value);
    }
    if (delta < tolerance) break;
  }

  return ranks;
}

/**
 * Community detection via Louvain modularity optimization (graphology), replacing the
 * previous 8-iteration label propagation. Louvain converges to substantially better
 * modularity partitions on sparse import graphs and is deterministic here thanks to a
 * fixed rng seed. Falls back to label propagation if Louvain cannot run (e.g. no edges).
 */
export function communityLabels(graph: FileGraph): Map<string, number> {
  if (graph.nodes.length === 0) return new Map();

  const g = new Graph({ type: 'undirected', multi: false });
  for (const node of graph.nodes) g.addNode(node);
  let edgeCount = 0;
  for (const [source, targets] of graph.adjacency) {
    for (const target of targets) {
      if (source === target) continue;
      if (!g.hasEdge(source, target)) {
        g.addEdge(source, target, { weight: 1 });
        edgeCount++;
      } else {
        g.updateEdgeAttribute(source, target, 'weight', (w) => (w ?? 1) + 1);
      }
    }
  }

  if (edgeCount === 0) {
    // Louvain requires at least one edge; every file is its own singleton community.
    return new Map(graph.nodes.map((node, index) => [node, index]));
  }

  try {
    const partition = louvain(g, { rng: seededRandom(42), getEdgeWeight: 'weight' });
    return normalizeCommunityIds(graph.nodes, (node) => partition[node] ?? -1);
  } catch {
    return labelPropagation(graph);
  }
}

/** Deterministic PRNG (mulberry32) so community ids are stable across runs. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Renumber raw community labels to compact 0..n ids ordered by first appearance. */
function normalizeCommunityIds(nodes: string[], labelOf: (node: string) => number | string): Map<string, number> {
  const labels = new Map<string, number>();
  const remap = new Map<number | string, number>();
  for (const node of nodes) {
    const raw = labelOf(node);
    if (!remap.has(raw)) remap.set(raw, remap.size);
    labels.set(node, remap.get(raw)!);
  }
  return labels;
}

/** Legacy label-propagation fallback, kept for graphs Louvain cannot process. */
function labelPropagation(graph: FileGraph): Map<string, number> {
  const labels = new Map<string, number>();
  graph.nodes.forEach((node, index) => labels.set(node, index));

  for (let iteration = 0; iteration < 8; iteration++) {
    let changed = false;
    for (const node of graph.nodes) {
      const neighbors = [
        ...(graph.adjacency.get(node) ?? []),
        ...(graph.reverseAdjacency.get(node) ?? []),
      ];
      if (neighbors.length === 0) continue;
      const counts = new Map<number, number>();
      for (const neighbor of neighbors) {
        const label = labels.get(neighbor)!;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      let bestLabel = labels.get(node)!;
      let bestCount = counts.get(bestLabel) ?? 0;
      for (const [label, count] of counts) {
        if (count > bestCount || (count === bestCount && label < bestLabel)) {
          bestLabel = label;
          bestCount = count;
        }
      }
      if (bestLabel !== labels.get(node)) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const remap = new Map<number, number>();
  for (const label of labels.values()) {
    if (!remap.has(label)) remap.set(label, remap.size);
  }
  for (const [node, label] of labels) {
    labels.set(node, remap.get(label)!);
  }
  return labels;
}

/**
 * Symbol-level reference edge: a named import binds a *symbol* in the target file,
 * giving a finer-grained graph than file→file edges. `fromPath` imports `symbolName`
 * (declared in `toPath`) — e.g. `import { UserService } from './user.service'`.
 */
export interface SymbolReference {
  fromPath: string;
  toPath: string;
  symbolName: string;
  /** Line of the import statement in `fromPath` (1-based), when known. */
  line?: number;
}

/**
 * Build the symbol-level reference graph from named imports resolved against exported
 * symbols. Wildcard/default imports contribute no symbol edges (they stay file-level).
 */
export function buildSymbolReferences(files: GraphweftFile[]): SymbolReference[] {
  const index = buildFileIndex(files);
  const references: SymbolReference[] = [];

  // Exported symbol names per file, for O(1) membership checks.
  const exportedByPath = new Map<string, Set<string>>();
  for (const file of files) {
    exportedByPath.set(file.path, new Set(file.symbols.filter((s) => s.exported).map((s) => s.name)));
  }

  for (const file of files) {
    for (const importRef of file.imports) {
      if (importRef.importedNames.length === 0) continue;
      const targets = resolveSpecifier(file, importRef.specifier, index);
      for (const target of targets) {
        if (target.path === file.path) continue;
        const exported = exportedByPath.get(target.path);
        if (!exported || exported.size === 0) continue;
        for (const name of importRef.importedNames) {
          if (exported.has(name)) {
            references.push({ fromPath: file.path, toPath: target.path, symbolName: name, line: importRef.line });
          }
        }
      }
    }
  }

  return references;
}

/**
 * Symbols referenced (via named imports) by the most files — finer-grained hotspots
 * than file degree: `UserService` being imported from 40 files is a stronger coupling
 * signal than its host file having 40 importers for mixed reasons.
 */
export function symbolUsageCounts(references: SymbolReference[]): Array<{ symbolName: string; definedIn: string; referencedBy: number }> {
  const usage = new Map<string, Set<string>>();
  for (const ref of references) {
    const key = `${ref.toPath}::${ref.symbolName}`;
    const users = usage.get(key) ?? new Set<string>();
    users.add(ref.fromPath);
    usage.set(key, users);
  }
  return Array.from(usage.entries())
    .map(([key, users]) => {
      const separator = key.indexOf('::');
      return { definedIn: key.slice(0, separator), symbolName: key.slice(separator + 2), referencedBy: users.size };
    })
    .sort((a, b) => b.referencedBy - a.referencedBy || a.symbolName.localeCompare(b.symbolName));
}

const FILE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.groovy',
  '.cs', '.vb', '.php', '.rb', '.swift', '.lua',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
];

const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', '__init__.py', 'mod.rs'];

function resolveImports(file: GraphweftFile, index: FileIndex): GraphweftFile[] {
  const resolved: GraphweftFile[] = [];
  const seen = new Set<string>();

  for (const importRef of file.imports) {
    for (const target of resolveSpecifier(file, importRef.specifier, index)) {
      if (!seen.has(target.path)) {
        seen.add(target.path);
        resolved.push(target);
      }
    }
  }

  return resolved;
}

/** Resolve a single import specifier to its target file(s), across all supported languages. */
function resolveSpecifier(file: GraphweftFile, rawSpecifier: string, index: FileIndex): GraphweftFile[] {
  const specifier = rawSpecifier?.trim();
  if (!specifier) return [];

  if (specifier.startsWith('.')) {
    const relative = resolveRelative(file.path, specifier, index.byPath);
    return relative ? [relative] : [];
  }

  // Namespace / package import (C#, Java, Kotlin, Scala, PHP, VB).
  const namespaceTargets = resolveNamespace(specifier, index.byModule);
  if (namespaceTargets.length > 0) return namespaceTargets;

  // Workspace package import (`@scope/pkg`, `@scope/pkg/entry`) in a monorepo.
  const workspaceTarget = resolveWorkspacePackage(specifier, index.byDirName, index.byPath);
  if (workspaceTarget) return [workspaceTarget];

  // Path-like specifier: C/C++ #include, Ruby require, Lua require, module paths.
  const pathTarget = resolvePathLike(specifier, index.byPath);
  if (pathTarget) return [pathTarget];

  // Package-as-directory import (Go module paths, and any language whose import names a
  // directory rather than a file). Must come before the base-name fallback: that fallback
  // only fires when a package's final segment happens to match a unique *file* name, which
  // is an accident rather than a resolution.
  const directoryTargets = resolveDirectoryPackage(specifier, index.byDirPath);
  if (directoryTargets.length > 0) return directoryTargets;

  // Last-resort: match the final segment against a unique file base name.
  const byBase = resolveByBaseName(specifier, index.byBaseName);
  return byBase ? [byBase] : [];
}

/** Relative import: resolve against the importing file's directory, trying common extensions. */
function resolveRelative(fromPath: string, specifier: string, byPath: Map<string, GraphweftFile>): GraphweftFile | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  return firstMatch(candidatePaths(base), byPath);
}

/** Namespace/package import: link to every file declaring that namespace (or its parent). */
function resolveNamespace(specifier: string, byModule: Map<string, GraphweftFile[]>): GraphweftFile[] {
  const direct = byModule.get(specifier);
  if (direct && direct.length > 0) return direct;

  // `import com.example.Thing;` (Java) or `using Foo.Bar.Baz;` — the declared namespace is
  // usually the import minus its final (type) segment. Prefer files in that namespace whose
  // base name matches the trailing segment; otherwise link the whole namespace.
  const lastDot = specifier.lastIndexOf('.');
  if (lastDot <= 0) return [];
  const parent = specifier.slice(0, lastDot);
  const leaf = specifier.slice(lastDot + 1);
  const inParent = byModule.get(parent);
  if (!inParent || inParent.length === 0) return [];

  const leafMatches = inParent.filter((f) => baseNameOf(f.path) === leaf);
  return leafMatches.length > 0 ? leafMatches : inParent;
}

/**
 * Workspace-package import in a monorepo: `@scope/pkg` or `@scope/pkg/entry` (npm), or an
 * unambiguous bare `pkg/entry`. Matches the package segment against a same-named workspace
 * directory, then resolves the entry inside it (directly, or under `src/` or `lib/`), so
 * package-specifier imports link to source files instead of being dropped.
 */
function resolveWorkspacePackage(
  specifier: string,
  byDirName: Map<string, string[]>,
  byPath: Map<string, GraphweftFile>,
): GraphweftFile | undefined {
  const scoped = specifier.startsWith('@');
  const parts = specifier.replace(/\\/gu, '/').split('/').filter(Boolean);
  const packageName = parts[scoped ? 1 : 0];
  if (!packageName) return undefined;
  const subpath = parts.slice(scoped ? 2 : 1).join('/');

  const dirs = byDirName.get(packageName);
  if (!dirs || dirs.length === 0) return undefined;
  // Unscoped bare names (e.g. `utils`) are only linked when the directory name is unambiguous.
  if (!scoped && dirs.length > 1) return undefined;

  const ordered = [...dirs].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  );
  for (const dir of ordered) {
    for (const root of [dir, `${dir}/src`, `${dir}/lib`]) {
      const match = firstMatch(candidatePaths(subpath ? `${root}/${subpath}` : root), byPath);
      if (match) return match;
    }
  }
  return undefined;
}

/** Path-like specifier (`sub/dir/file`, `file.h`, `a.b.c` module path). */
function resolvePathLike(specifier: string, byPath: Map<string, GraphweftFile>): GraphweftFile | undefined {
  const normalized = specifier.replace(/\\/gu, '/').replace(/^@\//u, '').replace(/^\/+/u, '');

  // As-written (e.g. `#include "net/socket.h"`), with extension candidates.
  const direct = firstMatch(candidatePaths(normalized), byPath);
  if (direct) return direct;

  // By trailing path segment, so `pkg/util/log` matches `.../util/log.go`.
  for (const [filePath, file] of byPath) {
    if (filePath === normalized || filePath.endsWith(`/${normalized}`)) return file;
  }

  // Dotted module path -> directory path (`foo.bar.baz` -> `foo/bar/baz.*`).
  if (normalized.includes('.') && !normalized.includes('/')) {
    const asPath = normalized.replace(/\./gu, '/');
    const bySlash = firstMatch(candidatePaths(asPath), byPath);
    if (bySlash) return bySlash;
    for (const [filePath, file] of byPath) {
      if (filePath.endsWith(`/${asPath}`)) return file;
    }
  }

  return undefined;
}

/** Match the final segment of a module path against a uniquely-named file. */
/**
 * Resolve an import that names a **directory** to every file in it.
 *
 * Go is the motivating case: `github.com/org/repo/internal/billing/api` must resolve to the
 * directory `internal/billing/api`, because a Go package *is* a directory and the importer
 * depends on all of its files. The module prefix (`github.com/org/repo`) is not part of the
 * repository layout, so we drop leading segments one at a time and take the longest suffix
 * that is a real directory — longest-first, so `internal/billing/api` wins over a bare `api`.
 *
 * Single-segment specifiers are ignored outright: those are overwhelmingly standard-library
 * imports (`context`, `fmt`), and matching them against a same-named directory would invent
 * edges that do not exist.
 */
function resolveDirectoryPackage(
  specifier: string,
  byDirPath: Map<string, GraphweftFile[]>,
): GraphweftFile[] {
  const normalized = specifier.replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '');
  if (!normalized.includes('/')) return [];

  const segments = normalized.split('/').filter(Boolean);
  for (let start = 0; start < segments.length; start++) {
    const candidate = segments.slice(start).join('/');
    const files = byDirPath.get(candidate);
    if (files && files.length > 0) return files;
  }
  return [];
}

function resolveByBaseName(specifier: string, byBaseName: Map<string, GraphweftFile[]>): GraphweftFile | undefined {
  const parts = specifier.replace(/^@/u, '').split(/[.\\/:]/u).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return undefined;
  const matches = byBaseName.get(last);
  // Only link when unambiguous, to avoid spurious edges from a common name.
  return matches && matches.length === 1 ? matches[0] : undefined;
}

function candidatePaths(base: string): string[] {
  return [base, ...FILE_EXTENSIONS.map((ext) => `${base}${ext}`), ...INDEX_FILES.map((file) => path.posix.join(base, file))];
}

function firstMatch(candidates: string[], byPath: Map<string, GraphweftFile>): GraphweftFile | undefined {
  for (const candidate of candidates) {
    const file = byPath.get(candidate);
    if (file) return file;
  }
  return undefined;
}

function baseNameOf(filePath: string): string {
  return path.posix.basename(filePath).replace(/\.[^.]+$/u, '');
}
