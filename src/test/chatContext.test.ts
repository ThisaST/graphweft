import * as assert from 'assert';
import { buildCodeGraphPrompt } from '../chat/promptBuilder';
import { buildCodeGraphContextPackage } from '../context/contextCompressor';
import { classifyTask } from '../context/taskClassifier';
import { RetrievalResult } from '../graph/graphTypes';

function runTests(): void {
  assert.strictEqual(classifyTask('review my current changes'), 'code_review');
  assert.strictEqual(classifyTask('what files are impacted by this change?'), 'impact_analysis');
  assert.strictEqual(classifyTask('add tests for invite validation'), 'test_generation');
  assert.strictEqual(classifyTask('explain auth flow'), 'explain_flow');
  assert.strictEqual(classifyTask('fix marketplace popover issue'), 'bug_fix');

  const retrieval: RetrievalResult = {
    files: [
      {
        file: {
          uri: 'file:///workspace/src/login.ts',
          path: 'src/login.ts',
          imports: [],
          decorators: [],
          symbols: [],
        },
        score: 72,
        reasons: ['git diff boost', 'symbol in file matches "login"'],
      },
    ],
    symbols: [
      {
        symbol: {
          id: 'src/login.ts:login:1:function',
          name: 'login',
          type: 'function',
          filePath: 'src/login.ts',
          lineRange: { start: 1, end: 6 },
          signature: 'export function login(input: LoginInput): LoginResult',
          snippet: 'export function login(input: LoginInput): LoginResult {\n  return authenticate(input);\n}',
          exported: true,
          decorators: [],
          tags: [],
        },
        score: 80,
        reasons: ['exact symbol name match'],
      },
    ],
    dependencyFlow: ['src/login.ts -> src/authenticate.ts'],
    relatedTests: ['src/login.test.ts'],
    tokenBudget: 6000,
    estimatedTokens: 0,
  };

  const contextPackage = buildCodeGraphContextPackage({
    task: 'review my current changes',
    taskType: 'code_review',
    retrieval,
    gitDiff: {
      changedFiles: ['src/login.ts'],
      diff: 'diff --git a/src/login.ts b/src/login.ts\n+return authenticate(input);',
    },
    maxTokens: 6000,
  });

  assert.strictEqual(contextPackage.taskType, 'code_review');
  assert.strictEqual(contextPackage.confidence, 'high');
  assert.strictEqual(contextPackage.relevantFiles[0]?.path, 'src/login.ts');
  assert.ok(contextPackage.snippets.some((snippet) => snippet.filePath === 'git diff'), 'review context should include git diff snippet');

  const prompt = buildCodeGraphPrompt({ contextPackage });
  assert.ok(prompt.includes('Use the provided CodeGraph context first'), 'prompt should include reliability rule');
  assert.ok(prompt.includes('codegraph_runInTerminal'), 'prompt should advertise the agent tools');
  assert.ok(prompt.includes('"taskType": "code_review"'), 'prompt should include structured context package');
}

runTests();
console.log('chatContext.test.ts passed');
