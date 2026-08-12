import { RankedSymbolResult, RetrievalResult } from '../graph/graphTypes';

const defaultTokenBudget = 3000;
const snippetSymbolLimit = 3;

export function buildContextMarkdown(task: string, retrieval: RetrievalResult, maxTokens = retrieval.tokenBudget || defaultTokenBudget): string {
  const writer = new BudgetedMarkdownWriter(maxTokens);

  writer.forceLine('# CodeGraph Context Package');
  writer.forceLine('');
  writer.forceLine('## Task');
  writer.forceLine(task);
  writer.forceLine('');
  writer.forceLine('## Relevant Files');
  appendRelevantFiles(writer, retrieval);
  writer.forceLine('');
  writer.forceLine('## Important Symbols');
  appendImportantSymbols(writer, retrieval);
  writer.forceLine('');
  writer.forceLine('## Compact Snippets');
  appendSnippets(writer, retrieval.symbols.slice(0, snippetSymbolLimit));
  writer.forceLine('');
  writer.forceLine('## Dependency Flow');
  appendDependencyFlow(writer, retrieval);
  writer.forceLine('');
  writer.forceLine('## Related Tests');
  appendRelatedTests(writer, retrieval);
  writer.forceLine('');
  writer.forceLine('## Suggested Copilot Instruction');
  writer.tryLine(buildCopilotInstruction(task, retrieval));
  writer.forceLine('');
  writer.forceLine(`_Estimated tokens: ${writer.estimatedTokens()} / ${maxTokens}_`);

  retrieval.estimatedTokens = writer.estimatedTokens();
  return writer.toString();
}

function appendRelevantFiles(writer: BudgetedMarkdownWriter, retrieval: RetrievalResult): void {
  if (retrieval.files.length === 0) {
    writer.tryLine('- No matching files found. Build or refresh the index, then try a more specific task description.');
    return;
  }

  for (const result of retrieval.files) {
    if (!writer.tryLine(`- ${result.file.path}: ${formatReasons(result.reasons)}`)) {
      writer.tryLine('- Additional lower-ranked files omitted to stay within the token budget.');
      return;
    }
  }
}

function appendImportantSymbols(writer: BudgetedMarkdownWriter, retrieval: RetrievalResult): void {
  if (retrieval.symbols.length === 0) {
    writer.tryLine('- No matching symbols found.');
    return;
  }

  for (const result of retrieval.symbols) {
    const symbol = result.symbol;
    const parent = symbol.parentName ? `${symbol.parentName}.` : '';
    const line = `- ${parent}${symbol.name} | ${symbol.type} | ${symbol.filePath}:${symbol.lineRange.start}-${symbol.lineRange.end} | ${formatReasons(result.reasons)}\n  Signature: \`${symbol.signature}\``;

    if (!writer.tryLine(line)) {
      writer.tryLine('- Additional lower-ranked symbols omitted to stay within the token budget.');
      return;
    }
  }
}

function appendSnippets(writer: BudgetedMarkdownWriter, symbols: RankedSymbolResult[]): void {
  const snippets = symbols.filter((result) => result.symbol.snippet);

  if (snippets.length === 0) {
    writer.tryLine('- No small snippets available for the top symbols.');
    return;
  }

  for (const result of snippets) {
    const symbol = result.symbol;
    const parent = symbol.parentName ? `${symbol.parentName}.` : '';
    const snippetBlock = [`### ${parent}${symbol.name}`, `\`${symbol.filePath}:${symbol.lineRange.start}\``, '', '```ts', symbol.snippet ?? '', '```'].join('\n');

    if (!writer.tryLine(snippetBlock)) {
      writer.tryLine('- Additional snippets omitted to stay within the token budget.');
      return;
    }
  }
}

function appendDependencyFlow(writer: BudgetedMarkdownWriter, retrieval: RetrievalResult): void {
  if (retrieval.dependencyFlow.length === 0) {
    writer.tryLine('- No direct local import relationships found among the selected files.');
    return;
  }

  for (const flow of retrieval.dependencyFlow) {
    if (!writer.tryLine(`- ${flow}`)) {
      writer.tryLine('- Additional dependency relationships omitted to stay within the token budget.');
      return;
    }
  }
}

function appendRelatedTests(writer: BudgetedMarkdownWriter, retrieval: RetrievalResult): void {
  if (retrieval.relatedTests.length === 0) {
    writer.tryLine('- No likely related test files found by .spec, .test, or __tests__ naming.');
    return;
  }

  for (const filePath of retrieval.relatedTests) {
    if (!writer.tryLine(`- ${filePath}`)) {
      writer.tryLine('- Additional related tests omitted to stay within the token budget.');
      return;
    }
  }
}

function buildCopilotInstruction(task: string, retrieval: RetrievalResult): string {
  const fileList = retrieval.files.map((result) => result.file.path).join(', ') || 'the relevant files in the workspace';
  return `Use the CodeGraph context above to help with this task: "${task}". Focus on ${fileList}. Prefer the listed signatures and compact snippets over reading full files, keep changes local where possible, and consider the related tests.`;
}

function formatReasons(reasons: string[]): string {
  return reasons.length > 0 ? reasons.join('; ') : 'related by graph ranking';
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

class BudgetedMarkdownWriter {
  private readonly lines: string[] = [];
  private usedTokens = 0;

  public constructor(private readonly maxTokens: number) {}

  public forceLine(line: string): void {
    this.lines.push(line);
    this.usedTokens += estimateTokens(`${line}\n`);
  }

  public tryLine(line: string): boolean {
    const cost = estimateTokens(`${line}\n`);

    if (this.usedTokens + cost > this.maxTokens) {
      return false;
    }

    this.lines.push(line);
    this.usedTokens += cost;
    return true;
  }

  public estimatedTokens(): number {
    return this.usedTokens;
  }

  public toString(): string {
    return this.lines.join('\n');
  }
}
