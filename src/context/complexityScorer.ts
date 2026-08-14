import { GraphweftContextPackage } from './contextPackage';
import { TaskType } from './taskClassifier';

/**
 * Cost/capability tier a query is likely to need. `light` = a cheap, fast model
 * is almost certainly enough; `heavy` = reserve a premium reasoning model.
 */
export type ComplexityTier = 'light' | 'standard' | 'heavy';

export interface ComplexityAssessment {
  tier: ComplexityTier;
  /** 0..100 — higher means more reasoning/context likely required. */
  score: number;
  /** Short, human-readable factors that drove the score (for the banner). */
  signals: string[];
}

/** Base difficulty per task type, before query/context adjustments. */
const TASK_BASE: Record<TaskType, number> = {
  impact_analysis: 12,
  explain_flow: 26,
  test_generation: 38,
  code_review: 54,
  bug_fix: 56,
  feature_change: 60,
};

// Phrases that signal a quick, mechanical, or lookup-style ask.
const SIMPLE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(what|where|which|who) (is|are|does|file|files)\b/u, label: 'lookup question' },
  { re: /\b(list|show|print|display|count|find)\b/u, label: 'listing/retrieval' },
  { re: /\b(rename|format|lint|typo|spelling|comment|docstring)\b/u, label: 'mechanical edit' },
  { re: /\b(define|definition|signature|import|export)\b/u, label: 'symbol lookup' },
];

// Phrases that signal deep reasoning, multi-file work, or design judgement.
const COMPLEX_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(refactor|redesign|re-architect|architecture|restructure)\b/u, label: 'refactor/architecture' },
  { re: /\b(why|debug|root cause|race condition|concurrency|deadlock|memory leak)\b/u, label: 'deep debugging' },
  { re: /\b(optimi[sz]e|performance|scal(e|ability)|throughput|latency)\b/u, label: 'performance work' },
  { re: /\b(migrat|upgrade|port|rewrite|overhaul)\b/u, label: 'migration/rewrite' },
  { re: /\b(end[- ]to[- ]end|across (the )?(codebase|app|system)|whole (app|system))\b/u, label: 'cross-cutting scope' },
  { re: /\b(design|trade[- ]?off|strateg|approach|best way)\b/u, label: 'design judgement' },
];

const MULTI_STEP = /\band then\b|\balso\b|;|\bafter that\b|\bnext,?\b|\bfinally\b/iu;

// Operational asks ("run the app", "start the server", "build the project"). These are
// mechanically simple even though they often retrieve many files, so they must not be
// dragged into `heavy` by the blast-radius signal.
const OPERATIONAL = /\b(run|start|launch|serve|execute|exec|boot|build|compile|install|deploy|open)\b/u;

// Informational / lookup asks ("what is X", "what's the use of X", "describe X"). These are
// answered by reading and summarising — not multi-file reasoning — so, like operational
// commands, they should ignore the retrieved-file count.
const INFORMATIONAL = /\b(what is|what are|what does|what's|whats|purpose of|use of|used for|describe|overview of|tell me about)\b/u;

/**
 * Score a query's likely difficulty entirely locally — no model call, no data
 * leaves the machine. Combines the task type, query wording, and the size of the
 * context Graphweft already assembled (file/symbol/snippet counts).
 */
export function assessComplexity(input: {
  task: string;
  taskType: TaskType;
  contextPackage: GraphweftContextPackage;
}): ComplexityAssessment {
  const { task, taskType, contextPackage } = input;
  const normalized = task.toLowerCase();
  const signals: string[] = [];

  let score = TASK_BASE[taskType];

  // Query wording.
  let complexHits = 0;
  for (const { re, label } of COMPLEX_PATTERNS) {
    if (re.test(normalized)) {
      complexHits += 1;
      if (signals.length < 3) signals.push(label);
    }
  }
  score += Math.min(36, complexHits * 12);

  let simpleHits = 0;
  for (const { re, label } of SIMPLE_PATTERNS) {
    if (re.test(normalized)) {
      simpleHits += 1;
      if (complexHits === 0 && signals.length < 3) signals.push(label);
    }
  }
  score -= Math.min(22, simpleHits * 11);

  // Longer prompts usually pack more requirements.
  const words = normalized.split(/\s+/u).filter(Boolean).length;
  if (words >= 40) {
    score += 12;
    signals.push('long, detailed request');
  } else if (words <= 8) {
    score -= 8;
    signals.push('short query');
  }

  if (MULTI_STEP.test(task)) {
    score += 10;
    signals.push('multi-step request');
  }

  // Operational commands and pure informational lookups (with no deep-reasoning words)
  // are simple regardless of how many files retrieval pulled in — so we push the score
  // down and ignore the (usually noisy) blast-radius signal for them.
  const operational = complexHits === 0 && OPERATIONAL.test(normalized);
  const informational = complexHits === 0 && !operational && INFORMATIONAL.test(normalized);
  if (operational) {
    score -= 28;
    signals.unshift('operational command');
  } else if (informational) {
    score -= 20;
    signals.unshift('informational lookup');
  }

  // Size of the context Graphweft assembled is a strong difficulty proxy — but only
  // when the request isn't a plain operational/informational ask.
  const files = contextPackage.relevantFiles.length;
  const snippets = contextPackage.snippets.length;
  if (!operational && !informational) {
    if (files <= 1 && snippets === 0) {
      score -= 10;
      signals.push('single-file context');
    } else {
      score += Math.min(20, Math.max(0, files - 2) * 4);
      score += Math.min(10, snippets * 3);
      if (files >= 5) signals.push(`${files}-file blast radius`);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const tier: ComplexityTier = score < 30 ? 'light' : score <= 60 ? 'standard' : 'heavy';

  if (signals.length === 0) {
    signals.push(taskType.replace(/_/gu, ' '));
  }

  return { tier, score, signals: signals.slice(0, 3) };
}
