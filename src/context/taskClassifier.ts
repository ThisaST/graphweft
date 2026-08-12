export type TaskType = 'bug_fix' | 'feature_change' | 'explain_flow' | 'test_generation' | 'impact_analysis' | 'code_review';

export function classifyTask(prompt: string): TaskType {
  const normalized = prompt.toLowerCase();

  if (/\b(review|current changes|diff|pr|pull request)\b/u.test(normalized)) {
    return 'code_review';
  }

  if (/\b(impact|impacted|affected|blast radius|what files)\b/u.test(normalized)) {
    return 'impact_analysis';
  }

  if (/\b(test|tests|spec|coverage)\b/u.test(normalized)) {
    return 'test_generation';
  }

  if (/\b(explain|flow|trace|walk through|how does|what is|what are|what does|what's|whats|purpose|used for|use of|describe|overview|tell me about)\b/u.test(normalized)) {
    return 'explain_flow';
  }

  if (/\b(fix|bug|broken|error|issue|failing|failure|regression)\b/u.test(normalized)) {
    return 'bug_fix';
  }

  return 'feature_change';
}
