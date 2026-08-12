import * as assert from 'assert';
import { profileModel, ProfiledModel, ModelMeta } from '../chat/modelRegistry';
import { deriveRequirement, recommendModels, scoreModel } from '../chat/modelRecommender';

function meta(id: string, family: string, name = id, maxInputTokens?: number): ModelMeta {
  return { id, name, vendor: 'test', family, maxInputTokens };
}

function profiled(...models: ModelMeta[]): ProfiledModel[] {
  return models.map(profileModel);
}

// --- registry profiling ---

(function classifiesKnownFamilies(): void {
  assert.ok(profileModel(meta('claude-opus-4', 'claude-opus-4')).axes.capability >= 90, 'opus is top capability');
  assert.ok(profileModel(meta('gpt-4o-mini', 'gpt-4o-mini')).axes.cost <= 25, 'mini is cheap');
  assert.ok(profileModel(meta('o3-mini', 'o3-mini')).axes.reasoning, 'reasoning mini flagged as reasoning');
  const haiku = profileModel(meta('claude-haiku', 'claude-3-5-haiku'));
  assert.ok(haiku.axes.speed >= 90 && haiku.axes.capability < 70, 'haiku fast + lighter');
})();

(function fallsBackForUnknownModels(): void {
  const unknown = profileModel(meta('acme-turbo-mini', 'acme-turbo-mini'));
  assert.strictEqual(unknown.source, 'heuristic');
  assert.ok(unknown.axes.capability < 70, 'mini signal => lighter capability');
})();

(function usesRealContextWindowWhenProvided(): void {
  const m = profileModel(meta('gpt-4o', 'gpt-4o', 'GPT-4o', 64000));
  assert.strictEqual(m.axes.contextTokens, 64000, 'maxInputTokens overrides registry default');
})();

// --- requirement derivation ---

(function heavyTaskWantsReasoning(): void {
  const req = deriveRequirement('heavy', 'feature_change', 5000);
  assert.ok(req.wantsReasoning && !req.preferCheap);
})();

(function bugFixWantsReasoningEvenIfStandard(): void {
  assert.ok(deriveRequirement('standard', 'bug_fix', 5000).wantsReasoning);
})();

(function lightTaskPrefersCheap(): void {
  const req = deriveRequirement('light', 'explain_flow', 1000);
  assert.ok(req.preferCheap && !req.wantsReasoning);
})();

(function bigPromptWantsLongContext(): void {
  assert.ok(deriveRequirement('standard', 'feature_change', 50000).wantsLongContext);
})();

// --- scoring & ranking ---

(function lightTaskPrefersCheaperModel(): void {
  const models = profiled(meta('claude-opus-4', 'claude-opus-4'), meta('gpt-4o-mini', 'gpt-4o-mini'));
  const req = deriveRequirement('light', 'explain_flow', 1000);
  const mini = models.find((m) => m.id === 'gpt-4o-mini')!;
  const opus = models.find((m) => m.id === 'claude-opus-4')!;
  assert.ok(scoreModel(mini, req).fit > scoreModel(opus, req).fit, 'cheap model wins a light task');
})();

(function heavyTaskPrefersCapableModel(): void {
  const models = profiled(meta('claude-opus-4', 'claude-opus-4'), meta('gpt-4o-mini', 'gpt-4o-mini'));
  const req = deriveRequirement('heavy', 'bug_fix', 4000);
  const mini = models.find((m) => m.id === 'gpt-4o-mini')!;
  const opus = models.find((m) => m.id === 'claude-opus-4')!;
  assert.ok(scoreModel(opus, req).fit > scoreModel(mini, req).fit, 'capable model wins a heavy task');
})();

(function excludesModelsThatCannotHoldPrompt(): void {
  const small = profileModel(meta('tiny', 'tiny-model', 'Tiny', 8000));
  const big = profileModel(meta('gpt-4o', 'gpt-4o', 'GPT-4o', 128000));
  const req = deriveRequirement('standard', 'feature_change', 20000); // 20k > 8k*0.9
  const { ranked } = recommendModels([small, big], req, 'other');
  assert.ok(!ranked.some((r) => r.model.id === 'tiny'), 'a model too small for the prompt is dropped');
  assert.ok(ranked.some((r) => r.model.id === 'gpt-4o'));
})();

(function surfacesMultipleDistinctSuggestions(): void {
  const models = profiled(
    meta('claude-opus-4', 'claude-opus-4'),
    meta('gpt-4o', 'gpt-4o'),
    meta('gpt-4o-mini', 'gpt-4o-mini'),
    meta('gemini-2.5-pro', 'gemini-2.5-pro'),
  );
  const req = deriveRequirement('heavy', 'bug_fix', 4000);
  const { suggestions } = recommendModels(models, req, 'gpt-4o-mini', 3);
  assert.ok(suggestions.length >= 2, 'should surface more than one option');
  const ids = new Set(suggestions.map((s) => s.model.id));
  assert.strictEqual(ids.size, suggestions.length, 'suggestions are distinct models');
  assert.ok(!ids.has('gpt-4o-mini'), 'current model is not re-suggested');
})();

(function reportsCurrentFit(): void {
  const models = profiled(meta('gpt-4o', 'gpt-4o'), meta('claude-opus-4', 'claude-opus-4'));
  const req = deriveRequirement('standard', 'feature_change', 4000);
  const { currentFit } = recommendModels(models, req, 'gpt-4o');
  assert.ok(typeof currentFit === 'number', 'current model fit is reported');
})();

console.log('modelRecommender.test.ts passed');
