/**
 * Tree-sitter based symbol extraction for non-TypeScript languages.
 *
 * Uses `web-tree-sitter` with the prebuilt grammars shipped by `@vscode/tree-sitter-wasm`
 * (the same WASM builds VS Code itself uses), so no native compilation is required.
 *
 * The module is opt-in and fail-safe: callers must await `initTreeSitter()` once; until
 * that resolves (or if WASM loading fails), `extractTreeSitterSymbols` returns `undefined`
 * and callers fall back to the regex-based extraction in `genericIndexer.ts`. Parsing
 * itself is synchronous once initialized, so the incremental reindex path stays fast.
 */
import * as nodePath from 'path';
import { CodeSymbol, CodeSymbolType } from '../graph/graphTypes';

// Loaded lazily so environments without the WASM assets never pay the cost.
type TreeSitterModule = typeof import('web-tree-sitter');
type Parser = import('web-tree-sitter').Parser;
type Language = import('web-tree-sitter').Language;
type SyntaxNode = import('web-tree-sitter').Node;

interface NodeRule {
  /** Tree-sitter node type, e.g. `function_definition`. */
  nodeType: string;
  symbolType: CodeSymbolType;
  /** Field holding the name node (default: `name`). */
  nameField?: string;
}

interface LanguageSpec {
  /** Grammar file name inside @vscode/tree-sitter-wasm/wasm (without extension). */
  grammar: string;
  rules: NodeRule[];
  /** Node types that establish a `parentName` scope for nested symbols. */
  scopeTypes: string[];
}

const LANGUAGE_SPECS: Record<string, LanguageSpec> = {
  '.py': {
    grammar: 'tree-sitter-python',
    rules: [
      { nodeType: 'class_definition', symbolType: 'class' },
      { nodeType: 'function_definition', symbolType: 'function' },
    ],
    scopeTypes: ['class_definition'],
  },
  '.go': {
    grammar: 'tree-sitter-go',
    rules: [
      { nodeType: 'function_declaration', symbolType: 'function' },
      { nodeType: 'method_declaration', symbolType: 'method' },
      { nodeType: 'type_spec', symbolType: 'class' },
    ],
    scopeTypes: [],
  },
  '.java': {
    grammar: 'tree-sitter-java',
    rules: [
      { nodeType: 'class_declaration', symbolType: 'class' },
      { nodeType: 'interface_declaration', symbolType: 'interface' },
      { nodeType: 'enum_declaration', symbolType: 'class' },
      { nodeType: 'record_declaration', symbolType: 'class' },
      { nodeType: 'method_declaration', symbolType: 'method' },
      { nodeType: 'constructor_declaration', symbolType: 'method' },
    ],
    scopeTypes: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'],
  },
  '.cs': {
    grammar: 'tree-sitter-c-sharp',
    rules: [
      { nodeType: 'class_declaration', symbolType: 'class' },
      { nodeType: 'interface_declaration', symbolType: 'interface' },
      { nodeType: 'struct_declaration', symbolType: 'class' },
      { nodeType: 'record_declaration', symbolType: 'class' },
      { nodeType: 'enum_declaration', symbolType: 'class' },
      { nodeType: 'method_declaration', symbolType: 'method' },
      { nodeType: 'constructor_declaration', symbolType: 'method' },
    ],
    scopeTypes: ['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration'],
  },
  '.rs': {
    grammar: 'tree-sitter-rust',
    rules: [
      { nodeType: 'function_item', symbolType: 'function' },
      { nodeType: 'struct_item', symbolType: 'class' },
      { nodeType: 'enum_item', symbolType: 'class' },
      { nodeType: 'trait_item', symbolType: 'interface' },
    ],
    scopeTypes: ['impl_item', 'trait_item'],
  },
  '.rb': {
    grammar: 'tree-sitter-ruby',
    rules: [
      { nodeType: 'class', symbolType: 'class' },
      { nodeType: 'module', symbolType: 'class' },
      { nodeType: 'method', symbolType: 'method' },
      { nodeType: 'singleton_method', symbolType: 'method' },
    ],
    scopeTypes: ['class', 'module'],
  },
  '.php': {
    grammar: 'tree-sitter-php',
    rules: [
      { nodeType: 'class_declaration', symbolType: 'class' },
      { nodeType: 'interface_declaration', symbolType: 'interface' },
      { nodeType: 'trait_declaration', symbolType: 'class' },
      { nodeType: 'function_definition', symbolType: 'function' },
      { nodeType: 'method_declaration', symbolType: 'method' },
    ],
    scopeTypes: ['class_declaration', 'interface_declaration', 'trait_declaration'],
  },
  '.cpp': {
    grammar: 'tree-sitter-cpp',
    rules: [
      { nodeType: 'class_specifier', symbolType: 'class' },
      { nodeType: 'struct_specifier', symbolType: 'class' },
      { nodeType: 'function_definition', symbolType: 'function', nameField: 'declarator' },
    ],
    scopeTypes: ['class_specifier', 'struct_specifier'],
  },
  '.sh': {
    grammar: 'tree-sitter-bash',
    rules: [{ nodeType: 'function_definition', symbolType: 'function' }],
    scopeTypes: [],
  },
};

// Grammar aliases sharing a spec.
LANGUAGE_SPECS['.pyw'] = LANGUAGE_SPECS['.py'];
LANGUAGE_SPECS['.cc'] = LANGUAGE_SPECS['.cpp'];
LANGUAGE_SPECS['.cxx'] = LANGUAGE_SPECS['.cpp'];
LANGUAGE_SPECS['.hpp'] = LANGUAGE_SPECS['.cpp'];
LANGUAGE_SPECS['.bash'] = LANGUAGE_SPECS['.sh'];

let treeSitter: TreeSitterModule | undefined;
let initPromise: Promise<boolean> | undefined;
const parsers = new Map<string, Parser>();
const failedGrammars = new Set<string>();

function wasmDir(): string {
  return nodePath.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm'));
}

/** The web-tree-sitter runtime ships its own .wasm next to its JS entrypoint. */
function runtimeWasmDir(): string {
  return nodePath.dirname(require.resolve('web-tree-sitter'));
}

/**
 * Initialize the tree-sitter runtime. Idempotent; resolves `true` when WASM is ready.
 * Grammars themselves load lazily on first use per language.
 */
export function initTreeSitter(): Promise<boolean> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('web-tree-sitter') as TreeSitterModule;
        await mod.Parser.init({
          locateFile: (file: string) => nodePath.join(runtimeWasmDir(), file),
        });
        treeSitter = mod;
        return true;
      } catch {
        return false;
      }
    })();
  }
  return initPromise;
}

export function isTreeSitterReady(): boolean {
  return treeSitter !== undefined;
}

/** Preload the grammar for an extension so later parses are synchronous. */
export async function loadGrammar(ext: string): Promise<boolean> {
  const spec = LANGUAGE_SPECS[ext];
  if (!spec || !(await initTreeSitter())) return false;
  if (parsers.has(spec.grammar)) return true;
  if (failedGrammars.has(spec.grammar)) return false;
  try {
    const language: Language = await treeSitter!.Language.load(
      nodePath.join(wasmDir(), `${spec.grammar}.wasm`),
    );
    const parser = new treeSitter!.Parser();
    parser.setLanguage(language);
    parsers.set(spec.grammar, parser);
    return true;
  } catch {
    failedGrammars.add(spec.grammar);
    return false;
  }
}

/** Extensions this indexer can upgrade beyond regex extraction. */
export function treeSitterExtensions(): string[] {
  return Object.keys(LANGUAGE_SPECS);
}

/**
 * Extract symbols via tree-sitter. Returns `undefined` when the runtime or the grammar
 * for this language is not (yet) loaded — the caller should fall back to regex.
 */
export function extractTreeSitterSymbols(text: string, filePath: string, ext: string): CodeSymbol[] | undefined {
  const spec = LANGUAGE_SPECS[ext];
  if (!spec || !treeSitter) return undefined;
  const parser = parsers.get(spec.grammar);
  if (!parser) return undefined;

  const tree = parser.parse(text);
  if (!tree) return undefined;
  try {
    const ruleByNode = new Map(spec.rules.map((rule) => [rule.nodeType, rule]));
    const scopeTypes = new Set(spec.scopeTypes);
    const lines = text.split('\n');
    const symbols: CodeSymbol[] = [];
    walk(tree.rootNode, undefined);
    return symbols;

    function walk(node: SyntaxNode, parentName: string | undefined): void {
      const rule = ruleByNode.get(node.type);
      let scopeName = parentName;

      if (rule) {
        const name = symbolName(node, rule);
        if (name) {
          const startLine = node.startPosition.row + 1;
          symbols.push({
            id: `${filePath}:${name}:${startLine}:${rule.symbolType}`,
            name,
            type: rule.symbolType,
            filePath,
            lineRange: { start: startLine, end: node.endPosition.row + 1 },
            signature: firstLineOf(node),
            snippet: lines[startLine - 1]?.trim(),
            exported: isExported(node, ext),
            decorators: [],
            parentName,
            tags: ['tree-sitter'],
          });
          if (scopeTypes.has(node.type)) scopeName = name;
        }
      } else if (scopeTypes.has(node.type)) {
        // Scope without a rule (e.g. rust impl_item): derive scope name from its type field.
        const typeNode = node.childForFieldName('type') ?? node.childForFieldName('name');
        if (typeNode) scopeName = typeNode.text;
      }

      for (const child of node.namedChildren) {
        if (child) walk(child, scopeName);
      }
    }
  } finally {
    tree.delete();
  }
}

function symbolName(node: SyntaxNode, rule: NodeRule): string | undefined {
  const nameNode = node.childForFieldName(rule.nameField ?? 'name');
  if (!nameNode) return undefined;
  if (rule.nameField === 'declarator') {
    // C/C++: dig through the declarator chain to the identifier.
    let current: SyntaxNode | null = nameNode;
    while (current) {
      if (current.type === 'identifier' || current.type === 'field_identifier' || current.type === 'qualified_identifier') {
        return current.text;
      }
      current = current.childForFieldName('declarator') ?? current.namedChildren[0] ?? null;
    }
    return undefined;
  }
  return nameNode.text;
}

function firstLineOf(node: SyntaxNode): string {
  const newline = node.text.indexOf('\n');
  const line = newline >= 0 ? node.text.slice(0, newline) : node.text;
  return line.trim().slice(0, 200);
}

function isExported(node: SyntaxNode, ext: string): boolean {
  if (ext === '.rs') {
    // Rust: visible outside the crate only with a visibility modifier.
    return node.namedChildren.some((child) => child?.type === 'visibility_modifier');
  }
  if (ext === '.go') {
    // Go: exported identifiers start with an uppercase letter.
    const name = node.childForFieldName('name')?.text ?? '';
    return /^[A-Z]/u.test(name);
  }
  // Other languages: keep parity with the regex indexer (everything visible).
  return true;
}

/**
 * Load the tree-sitter grammars needed for the languages present in `paths`.
 *
 * `extractTreeSitterSymbols` is synchronous, so a grammar that has not been loaded yet
 * makes it return `undefined` and the caller silently falls back to regex extraction —
 * which misses nested symbols (methods inside a Python class, functions in a Rust `impl`).
 * Every host that indexes a batch of files must call this first. Failures are intentionally
 * swallowed: the regex fallback still covers those files.
 */
export async function preloadGrammarsForPaths(paths: readonly string[]): Promise<void> {
  const known = new Set(treeSitterExtensions());
  const wanted = new Set<string>();
  for (const filePath of paths) {
    const dot = filePath.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = filePath.slice(dot).toLowerCase();
    if (known.has(ext)) wanted.add(ext);
  }
  await Promise.all([...wanted].map((ext) => loadGrammar(ext).catch(() => false)));
}
