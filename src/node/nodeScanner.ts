/**
 * Headless workspace scanner — the Node equivalent of workspaceScanner.ts, with zero VS Code
 * dependency. Walks a directory with `fs`, prunes build/dependency dirs and generated files via
 * the shared (pure) fileFilters, and emits the same `WorkspaceSourceFile` shape the indexers
 * consume. This is what lets the engine run inside an MCP server / CLI / any tool.
 */
import * as fs from 'fs/promises';
import * as nodePath from 'path';
import { pathToFileURL } from 'url';
import { WorkspaceSourceFile } from '../indexer/sourceFile';
import { isExcludedDirSegment, isSupportedSourcePath, isTypescriptSourcePath } from '../utils/fileFilters';

const MAX_FILE_BYTES = 1_500_000; // skip very large files (minified blobs, data dumps)

export interface ScanOptions {
  /** Hard cap on files scanned, to stay responsive on huge repos. */
  maxFiles?: number;
}

export async function scanDirectory(root: string, options: ScanOptions = {}): Promise<WorkspaceSourceFile[]> {
  const maxFiles = options.maxFiles ?? 20000;
  const absRoot = nodePath.resolve(root);
  const out: WorkspaceSourceFile[] = [];
  const stack: string[] = [absRoot];

  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }

    for (const entry of entries) {
      const abs = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isExcludedDirSegment(entry.name) && !entry.name.startsWith('.')) {
          stack.push(abs);
        }
        continue;
      }
      if (!entry.isFile()) continue;

      const rel = toPosix(nodePath.relative(absRoot, abs));
      if (!isSupportedSourcePath(rel)) continue;

      try {
        const stat = await fs.stat(abs);
        if (stat.size > MAX_FILE_BYTES) continue;
        const text = await fs.readFile(abs, 'utf8');
        out.push({
          uri: pathToFileURL(abs).toString(),
          workspaceRelativePath: rel,
          text,
          isTypescript: isTypescriptSourcePath(rel),
        });
      } catch {
        // unreadable/binary — skip
      }
      if (out.length >= maxFiles) break;
    }
  }

  return out.sort((a, b) => a.workspaceRelativePath.localeCompare(b.workspaceRelativePath));
}

/** Workspace-relative posix path for an absolute path under `root`. */
export function toRelativePath(root: string, absolutePath: string): string {
  return toPosix(nodePath.relative(nodePath.resolve(root), absolutePath));
}

/**
 * Read and wrap a single file (incremental refresh path). Returns undefined when the
 * file is filtered out, too large, or unreadable — callers treat that as "removed".
 */
export async function readSourceFile(root: string, absolutePath: string): Promise<WorkspaceSourceFile | undefined> {
  const rel = toRelativePath(root, absolutePath);
  if (!rel || rel.startsWith('..') || !isSupportedSourcePath(rel)) return undefined;
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    const text = await fs.readFile(absolutePath, 'utf8');
    return {
      uri: pathToFileURL(absolutePath).toString(),
      workspaceRelativePath: rel,
      text,
      isTypescript: isTypescriptSourcePath(rel),
    };
  } catch {
    return undefined;
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/gu, '/');
}
