import * as assert from 'assert';
import { assessComplexity, ComplexityTier } from '../context/complexityScorer';
import { GraphweftContextPackage } from '../context/contextPackage';
import { TaskType } from '../context/taskClassifier';

function pkg(partial: Partial<GraphweftContextPackage> = {}): GraphweftContextPackage {
  return {
    task: partial.task ?? 'task',
    taskType: partial.taskType ?? 'feature_change',
    confidence: partial.confidence ?? 'medium',
    relevantFiles: partial.relevantFiles ?? [],
    importantSymbols: partial.importantSymbols ?? [],
    dependencyFlow: partial.dependencyFlow ?? [],
    relatedTests: partial.relatedTests ?? [],
    snippets: partial.snippets ?? [],
  };
}

function file(path: string): GraphweftContextPackage['relevantFiles'][number] {
  return { path, reason: 'r', score: 10 };
}

function assess(task: string, taskType: TaskType, p: Partial<GraphweftContextPackage> = {}): ComplexityTier {
  return assessComplexity({ task, taskType, contextPackage: pkg({ ...p, task, taskType }) }).tier;
}

(function simpleLookupIsLight(): void {
  const tier = assess('where is the rate limiter defined', 'impact_analysis', {
    relevantFiles: [file('src/a.ts')],
  });
  assert.strictEqual(tier, 'light', 'short single-file lookup should be light');
})();

(function listingIsLight(): void {
  const tier = assess('list the auth files', 'impact_analysis', { relevantFiles: [file('a.ts')] });
  assert.strictEqual(tier, 'light');
})();

(function runAppIsLightDespiteBigBlastRadius(): void {
  // Regression: "run this application" used to score HEAVY because retrieval pulled
  // in ~16 noisy files. Operational commands must ignore that blast-radius signal.
  const tier = assess('run this application', 'feature_change', {
    relevantFiles: Array.from({ length: 16 }, (_, i) => file(`f${i}.ts`)),
  });
  assert.strictEqual(tier, 'light', 'operational "run the app" should be light even with many retrieved files');
})();

(function startServerIsLight(): void {
  const tier = assess('start the dev server', 'feature_change', {
    relevantFiles: Array.from({ length: 10 }, (_, i) => file(`f${i}.ts`)),
  });
  assert.strictEqual(tier, 'light');
})();

(function operationalWithRealReasoningStillEscalates(): void {
  // "build" is operational, but the deep-reasoning words must still win.
  const { tier } = assessComplexity({
    task: 'build the project then debug why the race condition crashes startup across modules',
    taskType: 'bug_fix',
    contextPackage: pkg({ relevantFiles: [file('a.ts'), file('b.ts'), file('c.ts')] }),
  });
  assert.notStrictEqual(tier, 'light', 'operational keyword should not mask genuine debugging complexity');
})();

(function whatIsXLookupIsNotHeavy(): void {
  // Regression: "What is the use of traefik on this repo?" used to score HEAVY (it fell
  // into feature_change + a big blast radius) and even rerouted UP to a pricier model.
  const { tier } = assessComplexity({
    task: 'What is the use of traefik on this repo?',
    taskType: 'explain_flow',
    contextPackage: pkg({ relevantFiles: Array.from({ length: 14 }, (_, i) => file(`f${i}.ts`)) }),
  });
  assert.notStrictEqual(tier, 'heavy', '"what is the use of X" should not be heavy');
})();

(function describeIsLightweight(): void {
  const tier = assess('describe the auth module', 'explain_flow', {
    relevantFiles: Array.from({ length: 9 }, (_, i) => file(`f${i}.ts`)),
  });
  assert.notStrictEqual(tier, 'heavy', 'informational "describe X" should not be heavy');
})();

(function whyDebugStillEscalates(): void {
  // "why" is debugging, not a lookup — must stay non-light even though it starts with a question word.
  const { tier } = assessComplexity({
    task: 'why does the traefik route intermittently return 502 under load',
    taskType: 'bug_fix',
    contextPackage: pkg({ relevantFiles: [file('a.ts'), file('b.ts')] }),
  });
  assert.notStrictEqual(tier, 'light', 'debugging "why X fails" should not be light');
})();

(function refactorIsHeavy(): void {
  const tier = assess(
    'refactor the session module to remove the race condition and redesign the locking strategy across the app',
    'feature_change',
    { relevantFiles: [file('a.ts'), file('b.ts'), file('c.ts'), file('d.ts'), file('e.ts')], snippets: [{ filePath: 'a', symbolName: 's', code: 'x' }] },
  );
  assert.strictEqual(tier, 'heavy', 'multi-file refactor with deep-reasoning words should be heavy');
})();

(function bugFixDefaultsHeavyish(): void {
  const { tier, score } = assessComplexity({
    task: 'debug why login fails intermittently',
    taskType: 'bug_fix',
    contextPackage: pkg({ relevantFiles: [file('a.ts'), file('b.ts')] }),
  });
  assert.ok(tier !== 'light', `debugging should not be light, got ${tier} (score ${score})`);
})();

(function bigBlastRadiusPushesUp(): void {
  const small = assessComplexity({
    task: 'explain this',
    taskType: 'explain_flow',
    contextPackage: pkg({ relevantFiles: [file('a.ts')] }),
  }).score;
  const big = assessComplexity({
    task: 'explain this',
    taskType: 'explain_flow',
    contextPackage: pkg({ relevantFiles: Array.from({ length: 8 }, (_, i) => file(`f${i}.ts`)) }),
  }).score;
  assert.ok(big > small, `larger context should score higher (${big} vs ${small})`);
})();

(function scoreIsBounded(): void {
  const { score } = assessComplexity({
    task: 'refactor redesign optimize migrate debug why race condition '.repeat(10),
    taskType: 'feature_change',
    contextPackage: pkg({ relevantFiles: Array.from({ length: 30 }, (_, i) => file(`f${i}.ts`)) }),
  });
  assert.ok(score >= 0 && score <= 100, `score must stay in 0..100, got ${score}`);
})();

(function alwaysReturnsSignals(): void {
  const { signals } = assessComplexity({ task: 'x', taskType: 'feature_change', contextPackage: pkg() });
  assert.ok(signals.length > 0, 'should always surface at least one rationale signal');
})();

console.log('complexity.test.ts passed');
