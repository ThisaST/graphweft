import { CodeGraphFile } from './graphTypes';
import * as path from 'path';

export interface FileGraph {
  nodes: string[];
  adjacency: Map<string, Set<string>>;
  reverseAdjacency: Map<string, Set<string>>;
}

export function buildFileGraph(files: CodeGraphFile[]): FileGraph {
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
  byPath: Map<string, CodeGraphFile>;
  /** Declared namespace/package -> files that declare it (C#, Java, Kotlin, Scala, PHP, VB). */
  byModule: Map<string, CodeGraphFile[]>;
  /** File base name without extension -> files (Python/Go/Rust module-path & include fallback). */
  byBaseName: Map<string, CodeGraphFile[]>;
  /** Directory segment name -> directory prefixes ending in it (workspace-package resolution). */
  byDirName: Map<string, string[]>;
}

function buildFileIndex(files: CodeGraphFile[]): FileIndex {
  const byPath = new Map<string, CodeGraphFile>();
  const byModule = new Map<string, CodeGraphFile[]>();
  const byBaseName = new Map<string, CodeGraphFile[]>();
  const byDirName = new Map<string, string[]>();

  for (const file of files) {
    byPath.set(file.path, file);

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

  return { byPath, byModule, byBaseName, byDirName };
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

export function communityLabels(graph: FileGraph): Map<string, number> {
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

const FILE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.groovy',
  '.cs', '.vb', '.php', '.rb', '.swift', '.lua',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
];

const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', '__init__.py', 'mod.rs'];

function resolveImports(file: CodeGraphFile, index: FileIndex): CodeGraphFile[] {
  const resolved: CodeGraphFile[] = [];
  const seen = new Set<string>();

  const add = (target: CodeGraphFile | undefined): void => {
    if (target && !seen.has(target.path)) {
      seen.add(target.path);
      resolved.push(target);
    }
  };

  for (const importRef of file.imports) {
    const specifier = importRef.specifier?.trim();
    if (!specifier) continue;

    if (specifier.startsWith('.')) {
      add(resolveRelative(file.path, specifier, index.byPath));
      continue;
    }

    // Namespace / package import (C#, Java, Kotlin, Scala, PHP, VB).
    const namespaceTargets = resolveNamespace(specifier, index.byModule);
    if (namespaceTargets.length > 0) {
      namespaceTargets.forEach(add);
      continue;
    }

    // Workspace package import (`@scope/pkg`, `@scope/pkg/entry`) in a monorepo.
    const workspaceTarget = resolveWorkspacePackage(specifier, index.byDirName, index.byPath);
    if (workspaceTarget) {
      add(workspaceTarget);
      continue;
    }

    // Path-like specifier: C/C++ #include, Ruby require, Lua require, module paths.
    const pathTarget = resolvePathLike(specifier, index.byPath);
    if (pathTarget) {
      add(pathTarget);
      continue;
    }

    // Last-resort: match the final segment against a unique file base name.
    add(resolveByBaseName(specifier, index.byBaseName));
  }

  return resolved;
}

/** Relative import: resolve against the importing file's directory, trying common extensions. */
function resolveRelative(fromPath: string, specifier: string, byPath: Map<string, CodeGraphFile>): CodeGraphFile | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  return firstMatch(candidatePaths(base), byPath);
}

/** Namespace/package import: link to every file declaring that namespace (or its parent). */
function resolveNamespace(specifier: string, byModule: Map<string, CodeGraphFile[]>): CodeGraphFile[] {
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
  byPath: Map<string, CodeGraphFile>,
): CodeGraphFile | undefined {
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
function resolvePathLike(specifier: string, byPath: Map<string, CodeGraphFile>): CodeGraphFile | undefined {
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
function resolveByBaseName(specifier: string, byBaseName: Map<string, CodeGraphFile[]>): CodeGraphFile | undefined {
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

function firstMatch(candidates: string[], byPath: Map<string, CodeGraphFile>): CodeGraphFile | undefined {
  for (const candidate of candidates) {
    const file = byPath.get(candidate);
    if (file) return file;
  }
  return undefined;
}

function baseNameOf(filePath: string): string {
  return path.posix.basename(filePath).replace(/\.[^.]+$/u, '');
}
