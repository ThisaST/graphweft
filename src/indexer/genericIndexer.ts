import { GraphweftFile, CodeSymbol, CodeSymbolType } from '../graph/graphTypes';
import { extractMultiLangImports } from './multiLangImports';
import { extractModuleDeclaration } from './moduleDeclarations';
import { extractTreeSitterSymbols } from './treeSitterIndexer';
import { WorkspaceSourceFile } from './sourceFile';

interface SymbolPattern {
  type: CodeSymbolType;
  pattern: RegExp;
  nameGroup: number;
}

// Language-specific patterns to extract named definitions.
// Each entry maps a file extension to a list of extraction patterns.
const patternsByExtension: Record<string, SymbolPattern[]> = {
  '.py': [
    { type: 'class', pattern: /^class\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'function', pattern: /^def\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'function', pattern: /^async\s+def\s+(\w+)/gmu, nameGroup: 1 },
  ],
  '.go': [
    { type: 'function', pattern: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gmu, nameGroup: 1 },
    { type: 'class', pattern: /^type\s+(\w+)\s+struct/gmu, nameGroup: 1 },
    { type: 'interface', pattern: /^type\s+(\w+)\s+interface/gmu, nameGroup: 1 },
  ],
  '.rs': [
    { type: 'function', pattern: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'class', pattern: /^(?:pub\s+)?struct\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'interface', pattern: /^(?:pub\s+)?trait\s+(\w+)/gmu, nameGroup: 1 },
  ],
  '.java': [
    { type: 'class', pattern: /(?:^|\s)class\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'interface', pattern: /(?:^|\s)interface\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'function', pattern: /(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+(\w+)\s*\(/gmu, nameGroup: 1 },
  ],
  '.cs': [
    { type: 'class', pattern: /(?:^|\s)class\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'interface', pattern: /(?:^|\s)interface\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'function', pattern: /(?:public|private|protected|internal|static|\s)+[\w<>\[\]]+\s+(\w+)\s*\(/gmu, nameGroup: 1 },
  ],
  '.rb': [
    { type: 'class', pattern: /^class\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'function', pattern: /^\s*def\s+(\w+)/gmu, nameGroup: 1 },
  ],
  '.sh': [
    { type: 'function', pattern: /^(?:function\s+)?(\w+)\s*\(\s*\)/gmu, nameGroup: 1 },
  ],
  '.bash': [
    { type: 'function', pattern: /^(?:function\s+)?(\w+)\s*\(\s*\)/gmu, nameGroup: 1 },
  ],
  '.zsh': [
    { type: 'function', pattern: /^(?:function\s+)?(\w+)\s*\(\s*\)/gmu, nameGroup: 1 },
  ],
  '.ps1': [
    { type: 'function', pattern: /^(?:function|filter)\s+([\w-]+)/gimu, nameGroup: 1 },
  ],
  '.psm1': [
    { type: 'function', pattern: /^(?:function|filter)\s+([\w-]+)/gimu, nameGroup: 1 },
  ],
  '.tf': [
    { type: 'function', pattern: /^resource\s+"[\w-]+"\s+"([\w-]+)"/gmu, nameGroup: 1 },
    { type: 'function', pattern: /^module\s+"([\w-]+)"/gmu, nameGroup: 1 },
    { type: 'function', pattern: /^variable\s+"([\w-]+)"/gmu, nameGroup: 1 },
    { type: 'function', pattern: /^output\s+"([\w-]+)"/gmu, nameGroup: 1 },
  ],
  '.yaml': [
    { type: 'function', pattern: /^(?:  )?name:\s+(.+)/gmu, nameGroup: 1 },
  ],
  '.yml': [
    { type: 'function', pattern: /^(?:  )?name:\s+(.+)/gmu, nameGroup: 1 },
  ],
  '.kt': [
    { type: 'class', pattern: /(?:^|\s)class\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'interface', pattern: /(?:^|\s)interface\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'function', pattern: /(?:^|\s)fun\s+(\w+)/gmu, nameGroup: 1 },
  ],
  '.swift': [
    { type: 'class', pattern: /(?:^|\s)class\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'function', pattern: /(?:^|\s)func\s+(\w+)/gmu, nameGroup: 1 },
  ],
  '.php': [
    { type: 'class', pattern: /(?:^|\s)class\s+(\w+)/gmu, nameGroup: 1 },
    { type: 'function', pattern: /(?:^|\s)function\s+(\w+)/gmu, nameGroup: 1 },
  ],
  '.lua': [
    { type: 'function', pattern: /^(?:local\s+)?function\s+(\w+)/gmu, nameGroup: 1 },
  ],
};

export function indexGenericFile(file: WorkspaceSourceFile): GraphweftFile {
  const ext = getExtension(file.workspaceRelativePath);
  // Prefer AST-accurate tree-sitter extraction; fall back to regex when the WASM
  // runtime or the grammar for this language is unavailable.
  const symbols =
    extractTreeSitterSymbols(file.text, file.workspaceRelativePath, ext) ??
    extractSymbols(file.text, file.workspaceRelativePath, ext);
  const imports = extractMultiLangImports(file.text, ext);
  const moduleName = extractModuleDeclaration(file.text, ext);

  return {
    uri: file.uri.toString(),
    path: file.workspaceRelativePath,
    imports,
    symbols,
    decorators: [],
    moduleName,
  };
}

function extractSymbols(text: string, filePath: string, ext: string): CodeSymbol[] {
  const patterns = patternsByExtension[ext] ?? [];
  const lines = text.split('\n');
  const symbols: CodeSymbol[] = [];
  const seen = new Set<string>();

  for (const { type, pattern, nameGroup } of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    // eslint-disable-next-line no-cond-assign
    while ((match = pattern.exec(text)) !== null) {
      const rawName = match[nameGroup]?.trim();
      if (!rawName) {
        continue;
      }

      const dedupeKey = `${type}:${rawName}`;
      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      const lineNumber = countLines(text, match.index);

      symbols.push({
        id: `${filePath}:${rawName}:${lineNumber}:${type}`,
        name: rawName,
        type,
        filePath,
        lineRange: { start: lineNumber, end: lineNumber },
        signature: rawName,
        snippet: lines[lineNumber - 1]?.trim(),
        exported: true,
        decorators: [],
        tags: [],
      });
    }
  }

  return symbols;
}

function countLines(text: string, index: number): number {
  let count = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') {
      count++;
    }
  }
  return count;
}

function getExtension(filePath: string): string {
  const normalized = filePath.toLowerCase().replace(/\\/gu, '/');
  const base = normalized.split('/').pop() ?? normalized;

  // Handle extensionless Docker-style files
  if (base === 'dockerfile' || base === 'containerfile') {
    return '.dockerfile';
  }

  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot) : '';
}
