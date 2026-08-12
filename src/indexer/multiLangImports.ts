import { ImportReference } from '../graph/graphTypes';

interface ImportPattern {
  pattern: RegExp;
  nameGroup: number;
  isTypeOnly?: boolean;
}

const patternsByExtension: Record<string, ImportPattern[]> = {
  '.py': [
    { pattern: /^import\s+([\w.]+)/gmu, nameGroup: 1 },
    { pattern: /^from\s+([\w.]+)\s+import\s+/gmu, nameGroup: 1 },
  ],
  '.go': [
    { pattern: /import\s+"([^"]+)"/gu, nameGroup: 1 },
    { pattern: /import\s*\(\s*([\s\S]*?)\)/gu, nameGroup: 1 },
  ],
  '.rs': [
    { pattern: /^use\s+([\w:]+)/gmu, nameGroup: 1 },
    { pattern: /^mod\s+(\w+)/gmu, nameGroup: 1 },
  ],
  '.java': [
    { pattern: /^import\s+(?:static\s+)?([\w.*]+);/gmu, nameGroup: 1 },
  ],
  '.kt': [
    { pattern: /^import\s+([\w.]+)/gmu, nameGroup: 1 },
  ],
  '.cs': [
    { pattern: /^using\s+([\w.]+);/gmu, nameGroup: 1 },
  ],
  '.cpp': [
    { pattern: /^#include\s+[<"]([^>"]+)[>"]/gmu, nameGroup: 1 },
  ],
  '.c': [
    { pattern: /^#include\s+[<"]([^>"]+)[>"]/gmu, nameGroup: 1 },
  ],
  '.h': [
    { pattern: /^#include\s+[<"]([^>"]+)[>"]/gmu, nameGroup: 1 },
  ],
  '.hpp': [
    { pattern: /^#include\s+[<"]([^>"]+)[>"]/gmu, nameGroup: 1 },
  ],
  '.rb': [
    { pattern: /^require(?:_relative)?\s+['"]([^'"]+)['"]/gmu, nameGroup: 1 },
  ],
  '.php': [
    { pattern: /^use\s+([\w\\]+);/gmu, nameGroup: 1 },
    { pattern: /^(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/gmu, nameGroup: 1 },
  ],
  '.swift': [
    { pattern: /^import\s+(\w+)/gmu, nameGroup: 1 },
  ],
  '.scala': [
    { pattern: /^import\s+([\w.]+)/gmu, nameGroup: 1 },
  ],
  '.clj': [
    { pattern: /\(:require\s+\[([\w.\-/]+)/gu, nameGroup: 1 },
  ],
  '.lua': [
    { pattern: /require\s*\(?\s*['"]([^'"]+)['"]/gu, nameGroup: 1 },
  ],
  '.tf': [
    { pattern: /source\s*=\s*"([^"]+)"/gu, nameGroup: 1 },
  ],
  '.yaml': [
    { pattern: /\$ref:\s*['"]?([^'"\s]+)['"]?/gu, nameGroup: 1 },
  ],
  '.yml': [
    { pattern: /\$ref:\s*['"]?([^'"\s]+)['"]?/gu, nameGroup: 1 },
  ],
};

export function extractMultiLangImports(text: string, ext: string): ImportReference[] {
  const patterns = patternsByExtension[ext] ?? [];
  if (patterns.length === 0) return [];

  const imports: ImportReference[] = [];
  const seen = new Set<string>();

  for (const { pattern, nameGroup } of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[nameGroup];
      if (!raw) continue;

      if (ext === '.go' && /\s/u.test(raw)) {
        for (const inner of raw.split('\n')) {
          const innerMatch = inner.match(/"([^"]+)"/u);
          if (innerMatch) addImport(imports, seen, innerMatch[1], countLines(text, match.index));
        }
        continue;
      }

      const specifier = raw.trim().replace(/\.\*$/u, '').replace(/;$/u, '');
      if (!specifier) continue;
      addImport(imports, seen, specifier, countLines(text, match.index));
    }
  }

  return imports;
}

function addImport(into: ImportReference[], seen: Set<string>, specifier: string, line: number): void {
  const normalized = normalizeSpecifier(specifier);
  if (seen.has(normalized)) return;
  seen.add(normalized);
  into.push({
    specifier: normalized,
    importedNames: [],
    isTypeOnly: false,
    line,
  });
}

function normalizeSpecifier(specifier: string): string {
  return specifier
    .replace(/^\.\//u, './')
    .replace(/\\/gu, '/')
    .trim();
}

function countLines(text: string, index: number): number {
  let count = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}
