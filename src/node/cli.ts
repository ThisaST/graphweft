#!/usr/bin/env node
/**
 * graphweft CLI — runs the local code-graph engine headlessly (no VS Code). Usable directly,
 * and as a shell tool by any AI coding tool (Claude Code, Codex, Copilot CLI) that can run
 * commands. The MCP server wraps this same engine for richer integrations.
 *
 *   graphweft index   [dir]                 build the graph, print a summary
 *   graphweft search  [dir] <query...>      ranked, structure-aware context for a query (JSON)
 *   graphweft impact  [dir] <file>          files that transitively depend on <file>
 *   graphweft path    [dir] <fileA> <fileB> shortest dependency path
 *   graphweft report  [dir]                 full graph report (markdown)
 *
 * `dir` defaults to the current directory.
 */
import { GraphweftEngine } from './graphweftEngine';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') {
    printUsage();
    return command ? 0 : 1;
  }

  // First non-flag arg is an optional directory; default to cwd if it looks like a query/flag.
  const engine = new GraphweftEngine();

  switch (command) {
    case 'index': {
      const dir = rest[0] ?? '.';
      const summary = await engine.indexDirectory(dir);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }
    case 'search': {
      const { dir, args } = splitDirAndArgs(rest);
      if (args.length === 0) return fail('search needs a query: graphweft search [dir] <query...>');
      await engine.indexDirectory(dir);
      process.stdout.write(`${JSON.stringify(engine.search(args.join(' ')), null, 2)}\n`);
      return 0;
    }
    case 'impact': {
      const { dir, args } = splitDirAndArgs(rest);
      if (args.length === 0) return fail('impact needs a file: graphweft impact [dir] <file>');
      await engine.indexDirectory(dir);
      const impacted = engine.impact(args[0]);
      process.stdout.write(`${JSON.stringify({ seed: args[0], impacted }, null, 2)}\n`);
      return 0;
    }
    case 'path': {
      const { dir, args } = splitDirAndArgs(rest);
      if (args.length < 2) return fail('path needs two files: graphweft path [dir] <a> <b>');
      await engine.indexDirectory(dir);
      process.stdout.write(`${JSON.stringify(engine.path(args[0], args[1]), null, 2)}\n`);
      return 0;
    }
    case 'report': {
      const dir = rest[0] ?? '.';
      await engine.indexDirectory(dir);
      process.stdout.write(`${engine.report()}\n`);
      return 0;
    }
    default:
      return fail(`unknown command "${command}"`);
  }
}

/** Treat the first arg as a directory only if it exists-ish (contains a slash or is '.'); else cwd. */
function splitDirAndArgs(rest: string[]): { dir: string; args: string[] } {
  if (rest.length > 1 && (rest[0] === '.' || rest[0].includes('/') || rest[0].includes('\\'))) {
    return { dir: rest[0], args: rest.slice(1) };
  }
  return { dir: '.', args: rest };
}

function fail(message: string): number {
  process.stderr.write(`graphweft: ${message}\n`);
  printUsage();
  return 1;
}

function printUsage(): void {
  process.stderr.write(
    [
      'Usage:',
      '  graphweft index   [dir]',
      '  graphweft search  [dir] <query...>',
      '  graphweft impact  [dir] <file>',
      '  graphweft path    [dir] <fileA> <fileB>',
      '  graphweft report  [dir]',
      '',
    ].join('\n'),
  );
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`graphweft: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
