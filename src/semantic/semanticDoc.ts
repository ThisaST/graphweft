/**
 * Builds the compact "document" that gets embedded for a file. This is Graphweft's edge over
 * blind text chunking: instead of arbitrary slices of file content, we embed a structured
 * summary drawn from the graph index — path, namespace, symbol signatures, imports — so one
 * small vector captures what the file IS and how it CONNECTS. Typically ~300–800 chars/file,
 * which keeps local embedding fast and the on-disk index small.
 *
 * Pure module (no vscode) for unit testing.
 */
import * as crypto from 'crypto';
import { GraphweftFile } from '../graph/graphTypes';

const MAX_SYMBOLS = 30;
const MAX_IMPORTS = 20;

export function buildSemanticDoc(file: GraphweftFile): string {
  const lines: string[] = [`file: ${file.path}`];

  if (file.moduleName) {
    lines.push(`module: ${file.moduleName}`);
  }
  if (file.decorators.length > 0) {
    lines.push(`decorators: ${file.decorators.join(', ')}`);
  }

  const symbols = file.symbols.slice(0, MAX_SYMBOLS);
  if (symbols.length > 0) {
    lines.push('symbols:');
    for (const symbol of symbols) {
      lines.push(`- ${symbol.type} ${symbol.signature || symbol.name}`);
    }
  }

  const imports = file.imports.slice(0, MAX_IMPORTS).map((imp) => imp.specifier);
  if (imports.length > 0) {
    lines.push(`imports: ${imports.join(', ')}`);
  }

  return lines.join('\n');
}

/** Stable content hash for incremental re-embedding (unchanged doc ⇒ keep stored vector). */
export function hashDoc(doc: string): string {
  return crypto.createHash('sha256').update(doc, 'utf8').digest('hex').slice(0, 16);
}
