import * as vscode from 'vscode';
import { GraphStore } from '../graph/graphStore';
import { buildFileGraph, computeDegrees, impactSet, shortestPath } from '../graph/graphAlgorithms';
import { buildGraphReport, renderGraphReportMarkdown } from '../report/graphReport';
import { PrivacyManager } from '../privacy/privacyManager';
import { AuditLog } from '../privacy/auditLog';
import { renderSavingsMarkdown, summarizeSavings } from '../privacy/tokenSavingsAnalyzer';
import { listChatModels } from './modelAdvisor';
import { profileModels } from './modelRegistry';
import { renderModelTable } from './modelRecommender';

export interface ParsedSlash {
  command: string;
  args: string[];
  rest: string;
}

export function parseSlash(input: string): ParsedSlash | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const [head, ...rest] = trimmed.split(/\s+/u);
  return {
    command: head.slice(1).toLowerCase(),
    args: rest,
    rest: rest.join(' '),
  };
}

export interface SlashContext {
  store: GraphStore;
  privacy: PrivacyManager;
  audit: AuditLog;
  stream: vscode.ChatResponseStream;
  /** The model the user currently has selected, for highlighting in `/models`. */
  currentModelId?: string;
}

/**
 * Returns true when the slash command was fully handled locally (no model call needed).
 * Returns false when the parent participant should fall through to the LLM with a tweaked prompt.
 */
export async function handleSlashLocally(parsed: ParsedSlash, ctx: SlashContext): Promise<boolean> {
  switch (parsed.command) {
    case 'path':
      return runPath(parsed, ctx);
    case 'impact':
      return runImpact(parsed, ctx);
    case 'report':
      return runReport(ctx);
    case 'viz':
    case 'graph':
      await vscode.commands.executeCommand('graphweft.showGraph', parsed.rest || undefined);
      ctx.stream.markdown('Opened the interactive graph panel. Click any node to reveal it in the editor.');
      return true;
    case 'privacy':
      await vscode.commands.executeCommand('graphweft.showPrivacyCenter');
      ctx.stream.markdown('Opened the Privacy Center. Toggle `local-only` there to disable all model calls.');
      return true;
    case 'savings':
    case 'analyze': {
      const summary = summarizeSavings(ctx.audit.list());
      ctx.stream.markdown(renderSavingsMarkdown(summary));
      return true;
    }
    case 'audit': {
      const last = ctx.audit.list(10);
      if (last.length === 0) {
        ctx.stream.markdown('No model calls have been made yet.');
      } else {
        ctx.stream.markdown(['### Last 10 model calls', '', '| When | Task | Bytes | Files |', '| --- | --- | ---: | --- |']
          .concat(last.map((e) => `| ${e.timestamp} | ${truncate(e.task, 60)} | ${e.promptBytes} | ${e.filesIncluded.slice(0, 2).join(', ')}${e.filesIncluded.length > 2 ? ` +${e.filesIncluded.length - 2}` : ''} |`))
          .join('\n'));
      }
      return true;
    }
    case 'models':
    case 'benchmark': {
      const profiled = profileModels(
        (await listChatModels()).map((m) => ({ id: m.id, name: m.name, vendor: m.vendor, family: m.family, maxInputTokens: m.maxInputTokens })),
      );
      ctx.stream.markdown(renderModelTable(profiled, ctx.currentModelId));
      return true;
    }
    case 'godnodes':
    case 'hubs': {
      const files = ctx.store.getFiles();
      const degrees = computeDegrees(buildFileGraph(files)).slice(0, 15);
      ctx.stream.markdown(['### God Nodes', '', '| File | Total | In | Out |', '| --- | ---: | ---: | ---: |']
        .concat(degrees.map((d) => `| \`${d.path}\` | ${d.totalDegree} | ${d.inDegree} | ${d.outDegree} |`))
        .join('\n'));
      return true;
    }
    case 'wipe':
      await vscode.commands.executeCommand('graphweft.wipeIndex');
      return true;
    case 'help':
      ctx.stream.markdown(helpText());
      return true;
    default:
      return false; // fall through to LLM
  }
}

function runPath(parsed: ParsedSlash, ctx: SlashContext): boolean {
  if (parsed.args.length < 2) {
    ctx.stream.markdown('Usage: `/path <fileA> <fileB>` — finds the shortest import path between two files.');
    return true;
  }
  const files = ctx.store.getFiles();
  const matchA = matchPath(parsed.args[0], files.map((f) => f.path));
  const matchB = matchPath(parsed.args[1], files.map((f) => f.path));
  if (!matchA) {
    ctx.stream.markdown(`No file matches \`${parsed.args[0]}\`.`);
    return true;
  }
  if (!matchB) {
    ctx.stream.markdown(`No file matches \`${parsed.args[1]}\`.`);
    return true;
  }
  const result = shortestPath(buildFileGraph(files), matchA, matchB);
  if (!result.found) {
    ctx.stream.markdown(`No import path found between \`${matchA}\` and \`${matchB}\`.`);
    return true;
  }
  ctx.stream.markdown([`### Shortest path (${result.hopCount} hops)`, '', result.path.map((p) => `1. \`${p}\``).join('\n')].join('\n'));
  return true;
}

function runImpact(parsed: ParsedSlash, ctx: SlashContext): boolean {
  if (parsed.args.length < 1) {
    ctx.stream.markdown('Usage: `/impact <file>` — lists files that transitively depend on this file.');
    return true;
  }
  const files = ctx.store.getFiles();
  const seed = matchPath(parsed.args[0], files.map((f) => f.path));
  if (!seed) {
    ctx.stream.markdown(`No file matches \`${parsed.args[0]}\`.`);
    return true;
  }
  const impacted = impactSet(buildFileGraph(files), seed, 4);
  if (impacted.length === 0) {
    ctx.stream.markdown(`Nothing imports \`${seed}\` (it is a leaf).`);
    return true;
  }
  ctx.stream.markdown([`### Impact set for \`${seed}\` (${impacted.length} files)`, '', ...impacted.map((p) => `- \`${p}\``)].join('\n'));
  return true;
}

function runReport(ctx: SlashContext): boolean {
  const files = ctx.store.getFiles();
  if (files.length === 0) {
    ctx.stream.markdown('No index yet. Run `Graphweft: Build Local Index` first.');
    return true;
  }
  const report = buildGraphReport(files);
  ctx.stream.markdown(renderGraphReportMarkdown(report));
  return true;
}

function matchPath(query: string, paths: string[]): string | undefined {
  if (paths.includes(query)) return query;
  const lower = query.toLowerCase();
  const contains = paths.filter((p) => p.toLowerCase().includes(lower));
  return contains[0];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

export function helpText(): string {
  return [
    '### Graphweft commands',
    '- `@graphweft <task>` — ask any code-aware question (uses local graph + Copilot model)',
    '- `/path <a> <b>` — shortest import path between two files (local, no model call)',
    '- `/impact <file>` — files that transitively depend on this file (local)',
    '- `/godnodes` — most-connected files (local)',
    '- `/report` — full local graph report (local)',
    '- `/viz [query]` — open the interactive graph panel',
    '- `/privacy` — open the Privacy Center, switch privacy mode',
    '- `/models` — benchmark table of available models (capability, cost, speed, context) + your current pick',
    '- `/savings` — token-savings analysis: how many tokens Graphweft saved vs. a naive baseline',
    '- `/audit` — last 10 model calls with byte counts',
    '- `/wipe` — wipe local index and/or audit log',
    '- `/help` — this list',
  ].join('\n');
}
