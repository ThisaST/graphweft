/**
 * Agent-in-the-loop benchmark: real CLI coding agents (Claude Code, GitHub Copilot CLI)
 * answering codebase questions under three arms:
 *
 *   A `baseline` — no graphweft MCP server (agent's native tools only)
 *   B `graph`    — graphweft MCP server, embeddings disabled (empty cache + runtime off)
 *   C `hybrid`   — graphweft MCP server with the prebuilt local embedding index
 *
 * Agents keep their native tools in every arm; we measure the *marginal* value of the
 * graphweft tools. Tasks are objective Q&A with hand-verified ground truth (file + fact).
 *
 * Usage:
 *   node out/benchmark/agentBenchmark.js [--agent claude|copilot|both] [--arm A|B|C|all]
 *        [--task <1-based index>] [--out <results.jsonl>] [--dry-run]
 *
 * Requires: `claude` and `copilot` on PATH, repo compiled to out/, and (for arm C) the
 * embedding index built with the default model (`node out/node/cli.js embed .`).
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------- tasks

export interface AgentTask {
  id: string;
  kind: 'lexical' | 'conceptual';
  question: string;
  /** Substring expected in the answer, matched case/path-separator insensitively. */
  expectedPath: string;
  /** All regexes (case-insensitive) must match the answer text. */
  expectedFacts: string[];
}

export const TASKS: AgentTask[] = [
  {
    id: 'watch-debounce',
    kind: 'conceptual',
    question: 'How long does the tool wait after a file changes on disk before it reacts and refreshes its data? Which file implements that delay and what is the value in milliseconds?',
    expectedPath: 'src/indexer/fileWatcher.ts',
    expectedFacts: ['\\b300\\b'],
  },
  {
    id: 'token-budget-clamp',
    kind: 'conceptual',
    question: 'When a caller asks for a context token budget, how is that request limited so it cannot exceed what the model can accept? Which file implements the clamp and what fraction of the model input window is used?',
    expectedPath: 'src/utils/tokenEstimator.ts',
    expectedFacts: ['0\\.6|60\\s?%'],
  },
  {
    id: 'rrf-k',
    kind: 'lexical',
    question: 'What is the value of the constant k used by the reciprocal rank fusion implementation, and which file defines it?',
    expectedPath: 'src/graph/graphRanker.ts',
    expectedFacts: ['\\b60\\b'],
  },
  {
    id: 'chunk-char-cap',
    kind: 'conceptual',
    question: 'When code is split into pieces for the local embedding index, what is the maximum number of characters a single piece may contain? Which file defines it?',
    expectedPath: 'src/semantic/codeChunker.ts',
    expectedFacts: ['\\b1500\\b|1,500'],
  },
  {
    id: 'replace-fallbacks',
    kind: 'conceptual',
    question: 'When applying an AI-suggested text edit, if the exact target text is not found, what looser matching strategies are tried, and in which file?',
    expectedPath: 'src/chat/textReplace.ts',
    expectedFacts: ['normalized[- ]?eol|line[- ]?endings?', 'flexible[- ]?whitespace|whitespace'],
  },
  {
    id: 'privacy-modes',
    kind: 'lexical',
    question: 'What privacy modes does the tool support, and which file defines the list?',
    expectedPath: 'src/privacy/privacyManager.ts',
    expectedFacts: ['local[- ]?only', 'preview[- ]?before[- ]?send', 'standard'],
  },
  {
    id: 'vector-prune',
    kind: 'conceptual',
    question: 'Where are embeddings for deleted files or removed symbols cleaned out of the persistent vector database? Name the file and the method.',
    expectedPath: 'src/semantic/sqliteVectorStore.ts',
    expectedFacts: ['prune'],
  },
  {
    id: 'chunks-per-file-cap',
    kind: 'lexical',
    question: 'What is the maximum number of chunks a single file may contribute to the embedding index, and which file defines that limit?',
    expectedPath: 'src/semantic/codeChunker.ts',
    expectedFacts: ['\\b200\\b'],
  },
];

// ----------------------------------------------------------------------------- arms

export type ArmId = 'A' | 'B' | 'C';

interface ArmSpec {
  id: ArmId;
  label: string;
  /** null = no graphweft MCP server */
  serverEnv: Record<string, string> | null;
}

function armSpecs(workDir: string): ArmSpec[] {
  const emptyCache = path.join(workDir, 'arm-b-cache');
  fs.mkdirSync(emptyCache, { recursive: true });
  return [
    { id: 'A', label: 'baseline (no graphweft)', serverEnv: null },
    { id: 'B', label: 'graphweft graph-only', serverEnv: { GRAPHWEFT_CACHE_DIR: emptyCache, GRAPHWEFT_EMBED_RUNTIME: 'off' } },
    { id: 'C', label: 'graphweft + embeddings', serverEnv: {} },
  ];
}

// --------------------------------------------------------------------------- agents

export interface RunResult {
  agent: 'claude' | 'copilot';
  arm: ArmId;
  nudge?: boolean;
  taskId: string;
  kind: string;
  ok: boolean;
  fileHit: boolean;
  factHit: boolean;
  correct: boolean;
  wallMs: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  credits?: number;
  graphweftCalls?: number;
  toolCalls?: number;
  answer: string;
  error?: string;
}

function promptFor(task: AgentTask, repoRoot: string, nudge: boolean): string {
  const base = `Answer this question about the codebase at ${repoRoot}: ${task.question} ` +
    'Cite the repository-relative file path and the exact value(s). Be concise.';
  return nudge
    ? base + ' Use the graphweft MCP tools (graphweft_semantic_search, graphweft_context) to locate the code before reading files.'
    : base;
}

function execCommand(cmdLine: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], { cwd, windowsVerbatimArguments: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch { /* best effort */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, timedOut }); });
    child.on('error', () => { clearTimeout(timer); resolve({ stdout, stderr, code: null, timedOut }); });
  });
}

function quoteArg(value: string): string {
  return '"' + value.replace(/"/g, '\\"') + '"';
}

interface McpFiles {
  claudeConfig: string;
  copilotJson: string | null;
}

/** Write per-arm MCP config files; claude always gets a file (empty for arm A) so --strict-mcp-config isolates user config. */
function writeMcpConfigs(arm: ArmSpec, workDir: string, repoRoot: string): McpFiles {
  const serverJs = path.join(repoRoot, 'out', 'mcp', 'server.js');
  const claudeConfigPath = path.join(workDir, `claude-mcp-${arm.id}.json`);
  if (arm.serverEnv === null) {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({ mcpServers: {} }));
    return { claudeConfig: claudeConfigPath, copilotJson: null };
  }
  const server = {
    command: 'node',
    args: [serverJs, repoRoot],
    env: arm.serverEnv,
  };
  fs.writeFileSync(claudeConfigPath, JSON.stringify({ mcpServers: { graphweft: server } }));
  const copilotConfig = {
    mcpServers: {
      graphweft: { type: 'local', command: 'node', args: [serverJs, repoRoot], env: arm.serverEnv, tools: ['*'] },
    },
  };
  const copilotPath = path.join(workDir, `copilot-mcp-${arm.id}.json`);
  fs.writeFileSync(copilotPath, JSON.stringify(copilotConfig));
  return { claudeConfig: claudeConfigPath, copilotJson: copilotPath };
}

const CLAUDE_MODEL = process.env.AGENT_BENCH_CLAUDE_MODEL ?? 'claude-haiku-4-5';
const RUN_TIMEOUT_MS = 4 * 60 * 1000;

async function runClaude(task: AgentTask, arm: ArmSpec, mcp: McpFiles, repoRoot: string, nudge: boolean): Promise<RunResult> {
  const prompt = promptFor(task, repoRoot, nudge);
  const parts = [
    'claude', '-p', quoteArg(prompt),
    '--output-format', 'stream-json', '--verbose',
    '--model', CLAUDE_MODEL,
    '--max-turns', '15',
    '--strict-mcp-config', '--mcp-config', quoteArg(mcp.claudeConfig),
  ];
  const started = Date.now();
  const res = await execCommand(parts.join(' '), repoRoot, RUN_TIMEOUT_MS);
  const wallMs = Date.now() - started;

  let answer = '';
  let turns: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let costUsd: number | undefined;
  let graphweftCalls = 0;
  let toolCalls = 0;
  let isError = res.timedOut;
  for (const line of res.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let evt: any;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_use') {
          toolCalls += 1;
          if (typeof block.name === 'string' && block.name.startsWith('mcp__graphweft__')) graphweftCalls += 1;
        }
      }
    }
    if (evt.type === 'result') {
      answer = typeof evt.result === 'string' ? evt.result : '';
      turns = evt.num_turns;
      costUsd = evt.total_cost_usd;
      inputTokens = (evt.usage?.input_tokens ?? 0) + (evt.usage?.cache_read_input_tokens ?? 0) + (evt.usage?.cache_creation_input_tokens ?? 0);
      outputTokens = evt.usage?.output_tokens;
      if (evt.is_error) isError = true;
    }
  }
  return finalize({
    agent: 'claude', arm: arm.id, nudge: nudge || undefined, taskId: task.id, kind: task.kind,
    ok: !isError && answer.length > 0,
    wallMs, turns, inputTokens, outputTokens, costUsd, graphweftCalls, toolCalls,
    answer,
    error: isError ? (res.timedOut ? 'timeout' : trimForLog(res.stderr)) : undefined,
  }, task);
}

async function runCopilot(task: AgentTask, arm: ArmSpec, mcp: McpFiles, repoRoot: string, nudge: boolean): Promise<RunResult> {
  const prompt = promptFor(task, repoRoot, nudge);
  const parts = ['copilot', '-p', quoteArg(prompt), '--allow-all-tools', '--no-color', '--log-level', 'none'];
  if (mcp.copilotJson) {
    parts.push('--additional-mcp-config', quoteArg('@' + mcp.copilotJson));
  }
  const started = Date.now();
  const res = await execCommand(parts.join(' '), repoRoot, RUN_TIMEOUT_MS);
  const wallMs = Date.now() - started;

  // Answer arrives on stdout; the telemetry footer ("AI Credits 20.1 (29s)",
  // "Tokens ↑ 32.2k ... ↓ 13 ...") is written to stderr.
  const footer = res.stdout + '\n' + res.stderr;
  const creditsMatch = /AI\s+Credits?\s+([0-9.]+)/i.exec(footer);
  const credits = creditsMatch ? Number(creditsMatch[1]) : undefined;
  const tokensMatch = /Tokens\s+\S\s*([0-9.]+)(k?).*?\S\s*([0-9.]+)(k?)/i.exec(footer);
  const scale = (v: string, k: string) => Math.round(Number(v) * (k ? 1000 : 1));
  const inputTokens = tokensMatch ? scale(tokensMatch[1], tokensMatch[2]) : undefined;
  const outputTokens = tokensMatch ? scale(tokensMatch[3], tokensMatch[4]) : undefined;
  const answer = res.stdout
    .split(/\r?\n/)
    .filter((l) => !/^\s*(Changes\b|AI\s+Credits?\b|Tokens\b|Resume\b|●)/i.test(l))
    .join('\n')
    .trim();
  const isError = res.timedOut || (res.code !== 0 && answer.length === 0);
  return finalize({
    agent: 'copilot', arm: arm.id, nudge: nudge || undefined, taskId: task.id, kind: task.kind,
    ok: !isError && answer.length > 0,
    wallMs, credits, inputTokens, outputTokens,
    answer,
    error: isError ? (res.timedOut ? 'timeout' : trimForLog(res.stderr || res.stdout)) : undefined,
  }, task);
}

// -------------------------------------------------------------------------- scoring

function trimForLog(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function scoreAnswer(task: AgentTask, answer: string): { fileHit: boolean; factHit: boolean } {
  const normalized = answer.toLowerCase().replace(/\\/g, '/');
  const fileHit = normalized.includes(task.expectedPath.toLowerCase());
  const factHit = task.expectedFacts.every((f) => new RegExp(f, 'i').test(answer));
  return { fileHit, factHit };
}

function finalize(partial: Omit<RunResult, 'fileHit' | 'factHit' | 'correct'>, task: AgentTask): RunResult {
  const { fileHit, factHit } = scoreAnswer(task, partial.answer);
  return { ...partial, fileHit, factHit, correct: partial.ok && fileHit && factHit };
}

// --------------------------------------------------------------------------- report

export function renderAgentMarkdown(results: RunResult[]): string {
  const lines: string[] = [];
  const agents = [...new Set(results.map((r) => r.agent))];
  const arms: ArmId[] = ['A', 'B', 'C'];
  const armLabel: Record<ArmId, string> = { A: 'baseline', B: 'graph-only', C: 'hybrid (embeddings)' };

  lines.push('## Agent-in-the-loop results');
  lines.push('');
  lines.push('| Agent | Arm | Correct | File hit | Fact hit | Avg wall s | Avg turns | Avg tokens | Avg cost |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const agent of agents) {
    for (const arm of arms) {
      const rows = results.filter((r) => r.agent === agent && r.arm === arm);
      if (rows.length === 0) continue;
      const pct = (fn: (r: RunResult) => boolean) => `${rows.filter(fn).length}/${rows.length}`;
      const avg = (fn: (r: RunResult) => number | undefined) => {
        const vals = rows.map(fn).filter((v): v is number => typeof v === 'number');
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
      };
      const wall = avg((r) => r.wallMs);
      const turns = avg((r) => r.turns);
      const tokens = avg((r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0) || undefined);
      const cost = agent === 'claude' ? avg((r) => r.costUsd) : avg((r) => r.credits);
      lines.push(`| ${agent} | ${armLabel[arm]} | ${pct((r) => r.correct)} | ${pct((r) => r.fileHit)} | ${pct((r) => r.factHit)} | ${wall ? (wall / 1000).toFixed(1) : '—'} | ${turns ? turns.toFixed(1) : '—'} | ${tokens ? Math.round(tokens).toLocaleString() : '—'} | ${cost !== undefined ? (agent === 'claude' ? '$' + cost.toFixed(3) : cost.toFixed(1) + ' cr') : '—'} |`);
    }
  }

  lines.push('');
  lines.push('### By task kind (correct)');
  lines.push('');
  lines.push('| Agent | Arm | Lexical | Conceptual |');
  lines.push('|---|---|---|---|');
  for (const agent of agents) {
    for (const arm of arms) {
      const rows = results.filter((r) => r.agent === agent && r.arm === arm);
      if (rows.length === 0) continue;
      const byKind = (kind: string) => {
        const k = rows.filter((r) => r.kind === kind);
        return k.length ? `${k.filter((r) => r.correct).length}/${k.length}` : '—';
      };
      lines.push(`| ${agent} | ${armLabel[arm]} | ${byKind('lexical')} | ${byKind('conceptual')} |`);
    }
  }

  lines.push('');
  lines.push('### Per-run detail');
  lines.push('');
  lines.push('| Agent | Arm | Task | Kind | Correct | File | Fact | Wall s | Turns | CG calls | Cost |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const cost = r.agent === 'claude'
      ? (r.costUsd !== undefined ? '$' + r.costUsd.toFixed(3) : '—')
      : (r.credits !== undefined ? r.credits.toFixed(1) + ' cr' : '—');
    lines.push(`| ${r.agent} | ${r.arm} | ${r.taskId} | ${r.kind} | ${r.correct ? '✅' : '❌'} | ${r.fileHit ? '✓' : '✗'} | ${r.factHit ? '✓' : '✗'} | ${(r.wallMs / 1000).toFixed(0)} | ${r.turns ?? '—'} | ${r.graphweftCalls ?? '—'} | ${cost} |`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------------------ cli

interface CliArgs {
  agents: Array<'claude' | 'copilot'>;
  arms: ArmId[];
  taskIndex?: number;
  out: string;
  dryRun: boolean;
  nudge: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { agents: ['claude', 'copilot'], arms: ['A', 'B', 'C'], out: 'agent-bench-results.jsonl', dryRun: false, nudge: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') {
      const v = argv[++i];
      args.agents = v === 'both' ? ['claude', 'copilot'] : [v as 'claude' | 'copilot'];
    } else if (a === '--arm') {
      const v = argv[++i];
      args.arms = v === 'all' ? ['A', 'B', 'C'] : [v as ArmId];
    } else if (a === '--task') {
      args.taskIndex = Number(argv[++i]);
    } else if (a === '--out') {
      args.out = argv[++i];
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--nudge') {
      args.nudge = true;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..', '..');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bench-'));
  const arms = armSpecs(workDir).filter((a) => args.arms.includes(a.id));
  const tasks = args.taskIndex ? [TASKS[args.taskIndex - 1]] : TASKS;

  const total = args.agents.length * arms.length * tasks.length;
  console.log(`agent benchmark: ${args.agents.join('+')} × arms [${arms.map((a) => a.id).join(',')}] × ${tasks.length} tasks = ${total} runs`);
  console.log(`repo: ${repoRoot}`);
  console.log(`results: ${args.out}`);
  if (args.dryRun) {
    for (const arm of arms) {
      const mcp = writeMcpConfigs(arm, workDir, repoRoot);
      console.log(`arm ${arm.id}: claude=${mcp.claudeConfig} copilot=${mcp.copilotJson ?? '(none)'}`);
    }
    return;
  }

  const results: RunResult[] = [];
  let n = 0;
  for (const arm of arms) {
    const mcp = writeMcpConfigs(arm, workDir, repoRoot);
    for (const task of tasks) {
      for (const agent of args.agents) {
        n += 1;
        process.stdout.write(`[${n}/${total}] ${agent} arm=${arm.id} task=${task.id} ... `);
        const started = Date.now();
        const result = agent === 'claude'
          ? await runClaude(task, arm, mcp, repoRoot, args.nudge)
          : await runCopilot(task, arm, mcp, repoRoot, args.nudge);
        results.push(result);
        fs.appendFileSync(args.out, JSON.stringify(result) + '\n');
        console.log(`${result.correct ? 'CORRECT' : result.ok ? 'wrong' : 'ERROR'} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
      }
    }
  }

  const md = renderAgentMarkdown(results);
  const mdPath = args.out.replace(/\.jsonl$/, '.md');
  fs.writeFileSync(mdPath, md);
  console.log(`\n${md}\n\nwrote ${args.out} and ${mdPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
