#!/usr/bin/env node
/**
 * graphweft CLI — runs the local code-graph engine headlessly (no VS Code). Usable directly,
 * and as a shell tool by any AI coding tool (Claude Code, Codex, Copilot CLI) that can run
 * commands. The MCP server wraps this same engine for richer integrations.
 *
 *   graphweft index    [dir]                 build the graph, print a summary
 *   graphweft search   [dir] <query...>      ranked, structure-aware context for a query (JSON);
 *                                            fuses semantic similarity when an embedding index
 *                                            exists (opt out with --no-semantic)
 *   graphweft embed    [dir]                 build/refresh the local embedding index
 *                                            (--model <hf-id>, --wipe; first run downloads the
 *                                            model to the local cache — fully local after)
 *   graphweft semantic [dir] <query...>      chunk-level semantic code search (JSON)
 *   graphweft impact   [dir] <file>          files that transitively depend on <file>
 *   graphweft path     [dir] <fileA> <fileB> shortest dependency path
 *   graphweft report   [dir]                 full graph report (markdown)
 *
 * `dir` defaults to the current directory.
 */
import * as fs from 'fs/promises';
import { GraphweftEngine } from './graphweftEngine';
import { defaultModelCacheDir, resolveLocalModel } from '../semantic/localEmbeddingProvider';

async function main(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const [command, ...rest] = positional;
  if (!command || command === '-h' || command === '--help' || flags.has('help')) {
    printUsage();
    return command ? 0 : 1;
  }

  // First non-flag arg is an optional directory; default to cwd if it looks like a query/flag.
  const engine = new GraphweftEngine({
    semantic: flags.has('model') ? { local: { model: flags.get('model') } } : undefined,
  });

  switch (command) {
    case 'index': {
      const dir = rest[0] ?? '.';
      const dirError = await checkDirectory(dir);
      if (dirError) return fail(dirError);
      const summary = await engine.indexDirectory(dir);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }
    case 'search': {
      const { dir, args } = splitDirAndArgs(rest);
      if (args.length === 0) return fail('search needs a query: graphweft search [dir] <query...>');
      const dirError = await checkDirectory(dir);
      if (dirError) return fail(dirError);
      await engine.indexDirectory(dir);
      const result = flags.has('no-semantic')
        ? engine.search(args.join(' '))
        : await engine.searchHybrid(args.join(' '));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    case 'embed': {
      const dir = rest[0] ?? '.';
      const dirError = await checkDirectory(dir);
      if (dirError) return fail(dirError);
      await engine.indexDirectory(dir);
      if (flags.has('wipe')) {
        await engine.wipeSemanticIndex();
        process.stdout.write('Semantic index wiped.\n');
        return 0;
      }
      process.stderr.write(
        `Embedding with "${resolveLocalModel(flags.get('model'))}" — first run downloads the model ` +
          `to ${defaultModelCacheDir()} (local-only afterwards)…\n`,
      );
      let lastReported = 0;
      const stats = await engine.buildSemanticIndex((embedded, total) => {
        if (embedded - lastReported >= 64 || embedded === total) {
          process.stderr.write(`  embedded ${embedded}/${total} chunks\n`);
          lastReported = embedded;
        }
      });
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      return 0;
    }
    case 'semantic': {
      const { dir, args } = splitDirAndArgs(rest);
      if (args.length === 0) return fail('semantic needs a query: graphweft semantic [dir] <query...>');
      const dirError = await checkDirectory(dir);
      if (dirError) return fail(dirError);
      await engine.indexDirectory(dir);
      const hits = await engine.semanticSearch(args.join(' '), { topK: flagInt(flags, 'top', 12) });
      process.stdout.write(`${JSON.stringify({ query: args.join(' '), hits }, null, 2)}\n`);
      return 0;
    }
    case 'impact': {
      const { dir, args } = splitDirAndArgs(rest);
      if (args.length === 0) return fail('impact needs a file: graphweft impact [dir] <file>');
      const dirError = await checkDirectory(dir);
      if (dirError) return fail(dirError);
      await engine.indexDirectory(dir);
      const seed = engine.matchPath(args[0]);
      // Without this the command prints an empty list for a typo'd path, which is
      // indistinguishable from "nothing imports this file".
      if (!seed) return fail(`"${args[0]}" is not in the index for ${dir}`);
      const impacted = engine.impact(seed);
      process.stdout.write(`${JSON.stringify({ seed, impacted }, null, 2)}\n`);
      return 0;
    }
    case 'path': {
      const { dir, args } = splitDirAndArgs(rest);
      if (args.length < 2) return fail('path needs two files: graphweft path [dir] <a> <b>');
      const dirError = await checkDirectory(dir);
      if (dirError) return fail(dirError);
      await engine.indexDirectory(dir);
      const unknown = [args[0], args[1]].filter((candidate) => !engine.matchPath(candidate));
      if (unknown.length > 0) return fail(`not in the index for ${dir}: ${unknown.join(', ')}`);
      process.stdout.write(`${JSON.stringify(engine.path(args[0], args[1]), null, 2)}\n`);
      return 0;
    }
    case 'report': {
      const dir = rest[0] ?? '.';
      const dirError = await checkDirectory(dir);
      if (dirError) return fail(dirError);
      await engine.indexDirectory(dir);
      process.stdout.write(`${engine.report()}\n`);
      return 0;
    }
    default:
      return fail(`unknown command "${command}"`);
  }
}

/** Split `--flag[=value]` options from positional args. `--model X` consumes the next arg. */
function parseFlags(argv: string[]): { flags: Map<string, string | undefined>; positional: string[] } {
  const flags = new Map<string, string | undefined>();
  const positional: string[] = [];
  const valueFlags = new Set(['model', 'top']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
    } else if (valueFlags.has(body) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags.set(body, argv[++i]);
    } else {
      flags.set(body, undefined);
    }
  }
  return { flags, positional };
}

function flagInt(flags: Map<string, string | undefined>, name: string, fallback: number): number {
  const raw = flags.get(name);
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Treat the first arg as a directory only if it exists-ish (contains a slash or is '.'); else cwd. */
function splitDirAndArgs(rest: string[]): { dir: string; args: string[] } {
  if (rest.length > 1 && (rest[0] === '.' || rest[0].includes('/') || rest[0].includes('\\'))) {
    return { dir: rest[0], args: rest.slice(1) };
  }
  return { dir: '.', args: rest };
}

/**
 * Verify the target is a readable directory. Without this the scanner just yields no files
 * and every command reports an empty-but-successful result for a mistyped path — which
 * silently passes in scripts and CI.
 */
async function checkDirectory(dir: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return `"${dir}" is not a directory`;
    return undefined;
  } catch {
    return `directory not found: "${dir}"`;
  }
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
      '  graphweft index    [dir]',
      '  graphweft search   [dir] <query...>   [--no-semantic] [--model <hf-id>]',
      '  graphweft embed    [dir]              [--model <hf-id>] [--wipe]',
      '  graphweft semantic [dir] <query...>   [--top <n>] [--model <hf-id>]',
      '  graphweft impact   [dir] <file>',
      '  graphweft path     [dir] <fileA> <fileB>',
      '  graphweft report   [dir]',
      '',
      'Notes:',
      '  --model must match the model the index was built with. Set GRAPHWEFT_EMBED_MODEL',
      '  to apply one model to every command instead of passing --model each time.',
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
