/**
 * Tolerant find/replace for the edit tool. A naive `string.includes(find)` fails constantly in
 * practice because the model's `find` text uses `\n` while files (especially C#/.NET on Windows)
 * use `\r\n`, and indentation/trailing whitespace drifts. This matcher tries progressively looser
 * strategies while PRESERVING the file's original line endings on write, so edits don't rewrite
 * every line. Pure module (no vscode) for unit testing.
 */

export type MatchStrategy = 'exact' | 'normalized-eol' | 'flexible-whitespace';

export interface ReplaceResult {
  updated: string;
  count: number;
  strategy: MatchStrategy;
}

/** Replace `find` with `replace` in `original`, tolerating EOL and whitespace differences. */
export function applyReplace(original: string, find: string, replace: string, all = false): ReplaceResult | undefined {
  if (!find) return undefined;

  // 1. Exact, raw match — preserves anything intentional and is cheapest.
  if (original.includes(find)) {
    return { updated: replaceLiteral(original, find, replace, all), count: occurrences(original, find), strategy: 'exact' };
  }

  const eol = detectEol(original);
  const o = toLf(original);
  const f = toLf(find);
  const r = toLf(replace);

  // 2. Match after normalizing line endings to LF (the most common real cause).
  if (o.includes(f)) {
    const updatedLf = replaceLiteral(o, f, r, all);
    return { updated: fromLf(updatedLf, eol), count: occurrences(o, f), strategy: 'normalized-eol' };
  }

  // 3. Per-line whitespace-flexible match: ignore leading/trailing spaces/tabs on each line,
  //    keep exact inner content and line structure. Catches indentation/trailing-space drift.
  const regex = buildFlexibleRegex(f, all);
  if (regex) {
    let count = 0;
    const updatedLf = o.replace(regex, () => {
      count += 1;
      return r;
    });
    if (count > 0) {
      return { updated: fromLf(updatedLf, eol), count, strategy: 'flexible-whitespace' };
    }
  }

  return undefined;
}

export function detectEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/gu) || []).length;
  const lf = (text.match(/(?<!\r)\n/gu) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

function toLf(text: string): string {
  return text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

function fromLf(text: string, eol: '\r\n' | '\n'): string {
  return eol === '\r\n' ? text.replace(/\n/gu, '\r\n') : text;
}

/** Literal (non-regex) replace so `$` in `replace` is never interpreted as a backreference. */
function replaceLiteral(haystack: string, find: string, replace: string, all: boolean): string {
  if (all) return haystack.split(find).join(replace);
  const idx = haystack.indexOf(find);
  if (idx < 0) return haystack;
  return haystack.slice(0, idx) + replace + haystack.slice(idx + find.length);
}

function occurrences(haystack: string, find: string): number {
  if (!find) return 0;
  return haystack.split(find).length - 1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Build a regex matching `findLf` line-by-line, flexible on per-line leading/trailing whitespace. */
function buildFlexibleRegex(findLf: string, all: boolean): RegExp | undefined {
  const lines = findLf.split('\n');
  const body = lines
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.length === 0 ? '[ \\t]*' : `[ \\t]*${escapeRegExp(trimmed)}[ \\t]*`;
    })
    .join('\n');
  try {
    return new RegExp(body, all ? 'gu' : 'u');
  } catch {
    return undefined;
  }
}
