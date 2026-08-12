import * as ts from 'typescript';
import { CodeGraphFile, CodeSymbol, CodeSymbolType, ImportReference, LineRange } from '../graph/graphTypes';
import { WorkspaceSourceFile } from './sourceFile';

const routeDecorators = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete']);
const nestControllerDecorators = new Set(['Controller']);
const nestServiceDecorators = new Set(['Injectable']);
const nestModuleDecorators = new Set(['Module']);

export function indexTypeScriptFile(file: WorkspaceSourceFile): CodeGraphFile {
  const scriptKind = getScriptKind(file.workspaceRelativePath);
  const sourceFile = ts.createSourceFile(file.workspaceRelativePath, file.text, ts.ScriptTarget.Latest, true, scriptKind);
  const imports: ImportReference[] = [];
  const symbols: CodeSymbol[] = [];
  const fileDecorators = new Set<string>();

  const visit = (node: ts.Node): void => {
    const decorators = getDecoratorNames(node);
    decorators.forEach((decorator) => fileDecorators.add(decorator));

    if (ts.isImportDeclaration(node)) {
      imports.push(readImportDeclaration(node, sourceFile));
    }

    // `export ... from './x'` re-exports create the same dependency edge as an import.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      imports.push(readExportDeclaration(node, sourceFile));
    }

    if (ts.isClassDeclaration(node) && node.name) {
      symbols.push(readClassSymbol(node, file.workspaceRelativePath, sourceFile, decorators));

      node.members.forEach((member) => {
        if (ts.isMethodDeclaration(member)) {
          const methodSymbol = readMethodSymbol(member, node.name?.text, file.workspaceRelativePath, sourceFile);
          if (methodSymbol) {
            symbols.push(methodSymbol);
          }
        }
      });
    }

    if (ts.isInterfaceDeclaration(node)) {
      symbols.push(createSymbol(node.name.text, 'interface', node, file.workspaceRelativePath, sourceFile, {
        exported: isExported(node),
        decorators,
      }));
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push(readFunctionSymbol(node, node.name.text, file.workspaceRelativePath, sourceFile));
    }

    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      node.declarationList.declarations.forEach((declaration) => {
        const variableSymbol = readVariableSymbol(declaration, exported, file.workspaceRelativePath, sourceFile);
        if (variableSymbol) {
          symbols.push(variableSymbol);
        }
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    uri: file.uri.toString(),
    path: file.workspaceRelativePath,
    imports,
    symbols: dedupeSymbols(symbols),
    decorators: Array.from(fileDecorators).sort(),
  };
}

function readImportDeclaration(node: ts.ImportDeclaration, sourceFile: ts.SourceFile): ImportReference {
  const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : node.moduleSpecifier.getText(sourceFile);
  const importedNames: string[] = [];

  if (node.importClause?.name) {
    importedNames.push(node.importClause.name.text);
  }

  const bindings = node.importClause?.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    importedNames.push(bindings.name.text);
  }

  if (bindings && ts.isNamedImports(bindings)) {
    bindings.elements.forEach((element) => importedNames.push(element.name.text));
  }

  return {
    specifier,
    importedNames,
    isTypeOnly: Boolean(node.importClause?.isTypeOnly),
    line: getLineRange(node, sourceFile).start,
  };
}

function readExportDeclaration(node: ts.ExportDeclaration, sourceFile: ts.SourceFile): ImportReference {
  const moduleSpecifier = node.moduleSpecifier!;
  const specifier = ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : moduleSpecifier.getText(sourceFile);
  const importedNames: string[] = [];

  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    node.exportClause.elements.forEach((element) => importedNames.push(element.name.text));
  }
  if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
    importedNames.push(node.exportClause.name.text);
  }

  return {
    specifier,
    importedNames,
    isTypeOnly: node.isTypeOnly,
    line: getLineRange(node, sourceFile).start,
  };
}

function readClassSymbol(
  node: ts.ClassDeclaration,
  filePath: string,
  sourceFile: ts.SourceFile,
  decorators: string[],
): CodeSymbol {
  const className = node.name?.text ?? 'AnonymousClass';
  const classType = getClassSymbolType(className, decorators);
  const tags = [...getNestTags(className, decorators)];

  if (isReactComponentClass(node, sourceFile)) {
    tags.push('react-component');
  }

  return createSymbol(className, classType, node, filePath, sourceFile, {
    exported: isExported(node),
    decorators,
    tags,
  });
}

function readMethodSymbol(
  node: ts.MethodDeclaration,
  parentName: string | undefined,
  filePath: string,
  sourceFile: ts.SourceFile,
): CodeSymbol | undefined {
  const name = getPropertyName(node.name, sourceFile);
  if (!name) {
    return undefined;
  }

  const decorators = getDecoratorNames(node);
  const hasRouteDecorator = decorators.some((decorator) => routeDecorators.has(decorator));
  const symbolType: CodeSymbolType = hasRouteDecorator ? 'routeHandler' : 'method';
  const tags = hasRouteDecorator ? ['nestjs-route'] : [];

  return createSymbol(name, symbolType, node, filePath, sourceFile, {
    exported: false,
    decorators,
    parentName,
    tags,
  });
}

function readFunctionSymbol(
  node: ts.FunctionDeclaration,
  functionName: string,
  filePath: string,
  sourceFile: ts.SourceFile,
): CodeSymbol {
  const type = getFunctionSymbolType(functionName, node);
  const tags = getFunctionTags(functionName, node);

  return createSymbol(functionName, type, node, filePath, sourceFile, {
    exported: isExported(node),
    decorators: getDecoratorNames(node),
    tags,
  });
}

function readVariableSymbol(
  node: ts.VariableDeclaration,
  exported: boolean,
  filePath: string,
  sourceFile: ts.SourceFile,
): CodeSymbol | undefined {
  if (!ts.isIdentifier(node.name) || !node.initializer) {
    return undefined;
  }

  const initializer = unwrapExpression(node.initializer);
  if (!isFunctionLikeInitializer(initializer)) {
    return undefined;
  }

  const name = node.name.text;
  const type = getFunctionSymbolType(name, initializer);

  return createSymbol(name, type, node, filePath, sourceFile, {
    exported,
    decorators: [],
    tags: getFunctionTags(name, initializer),
  });
}

function createSymbol(
  name: string,
  type: CodeSymbolType,
  node: ts.Node,
  filePath: string,
  sourceFile: ts.SourceFile,
  options: {
    exported: boolean;
    decorators: string[];
    parentName?: string;
    tags?: string[];
  },
): CodeSymbol {
  const lineRange = getLineRange(node, sourceFile);
  const snippet = getShortSnippet(lineRange, sourceFile);

  return {
    id: `${filePath}:${name}:${lineRange.start}:${type}`,
    name,
    type,
    filePath,
    lineRange,
    signature: getSignature(node, sourceFile),
    snippet,
    exported: options.exported,
    decorators: options.decorators,
    parentName: options.parentName,
    tags: options.tags ?? [],
  };
}

function getClassSymbolType(className: string, decorators: string[]): CodeSymbolType {
  if (decorators.some((decorator) => nestControllerDecorators.has(decorator)) || className.endsWith('Controller')) {
    return 'nestjsController';
  }

  if (decorators.some((decorator) => nestModuleDecorators.has(decorator)) || className.endsWith('Module')) {
    return 'nestjsModule';
  }

  if (decorators.some((decorator) => nestServiceDecorators.has(decorator)) || className.endsWith('Service')) {
    return 'nestjsService';
  }

  return 'class';
}

function getFunctionSymbolType(name: string, node: ts.Node): CodeSymbolType {
  if (isReactHookName(name)) {
    return 'reactHook';
  }

  if (isReactComponentName(name) && nodeContainsJsx(node)) {
    return 'reactComponent';
  }

  return 'function';
}

function getFunctionTags(name: string, node: ts.Node): string[] {
  const tags: string[] = [];

  if (isReactHookName(name)) {
    tags.push('react-hook');
  }

  if (isReactComponentName(name) && nodeContainsJsx(node)) {
    tags.push('react-component');
  }

  return tags;
}

function getNestTags(className: string, decorators: string[]): string[] {
  const tags: string[] = [];

  if (decorators.some((decorator) => nestControllerDecorators.has(decorator)) || className.endsWith('Controller')) {
    tags.push('nestjs-controller');
  }

  if (decorators.some((decorator) => nestServiceDecorators.has(decorator)) || className.endsWith('Service')) {
    tags.push('nestjs-service');
  }

  if (decorators.some((decorator) => nestModuleDecorators.has(decorator)) || className.endsWith('Module')) {
    tags.push('nestjs-module');
  }

  return tags;
}

function isReactComponentClass(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): boolean {
  return Boolean(
    node.heritageClauses?.some((clause) =>
      clause.types.some((typeNode) => {
        const text = typeNode.expression.getText(sourceFile);
        return text === 'Component' || text === 'React.Component' || text === 'PureComponent' || text === 'React.PureComponent';
      }),
    ),
  );
}

function getDecoratorNames(node: ts.Node): string[] {
  if (!ts.canHaveDecorators(node)) {
    return [];
  }

  return (ts.getDecorators(node) ?? [])
    .map((decorator) => getDecoratorName(decorator.expression))
    .filter((name): name is string => Boolean(name));
}

function getDecoratorName(expression: ts.Expression): string | undefined {
  if (ts.isCallExpression(expression)) {
    return getDecoratorName(expression.expression);
  }

  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  return undefined;
}

function isExported(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword),
  );
}

function isFunctionLikeInitializer(node: ts.Expression): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) {
    return unwrapExpression(expression.expression);
  }

  return expression;
}

function getPropertyName(name: ts.PropertyName, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isPrivateIdentifier(name)) {
    return name.text;
  }

  return name.getText(sourceFile);
}

function isReactComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function isReactHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name);
}

function nodeContainsJsx(node: ts.Node): boolean {
  let containsJsx = false;

  const visit = (child: ts.Node): void => {
    if (containsJsx) {
      return;
    }

    if (
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child) ||
      ts.isJsxOpeningElement(child)
    ) {
      containsJsx = true;
      return;
    }

    ts.forEachChild(child, visit);
  };

  visit(node);
  return containsJsx;
}

function getLineRange(node: ts.Node, sourceFile: ts.SourceFile): LineRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

  return { start, end };
}

function getSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
  const text = node.getText(sourceFile).trim();
  const bodyStart = findFirstTopLevelBodyStart(text);
  const signatureText = bodyStart >= 0 ? text.slice(0, bodyStart).trimEnd() : text;
  return compactLines(signatureText).slice(0, 600);
}

function findFirstTopLevelBodyStart(text: string): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '(') {
      parenDepth += 1;
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === '[') {
      bracketDepth += 1;
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (char === '<') {
      angleDepth += 1;
    } else if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (char === '{' && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      return index;
    }
  }

  return -1;
}

function getShortSnippet(lineRange: LineRange, sourceFile: ts.SourceFile): string | undefined {
  const lineCount = lineRange.end - lineRange.start + 1;
  if (lineCount > 40) {
    return undefined;
  }

  return sourceFile.text
    .split(/\r?\n/u)
    .slice(lineRange.start - 1, lineRange.end)
    .join('\n')
    .trim();
}

function compactLines(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }

  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }

  if (filePath.endsWith('.js')) {
    return ts.ScriptKind.JS;
  }

  return ts.ScriptKind.TS;
}

function dedupeSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const seen = new Set<string>();

  return symbols.filter((symbol) => {
    if (seen.has(symbol.id)) {
      return false;
    }

    seen.add(symbol.id);
    return true;
  });
}
