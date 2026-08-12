import * as vscode from 'vscode';
import { CodeGraphContextPackage } from '../context/contextPackage';

export function noWorkspaceMessage(): string {
  return 'CodeGraph needs an open workspace folder before it can build a local code graph.';
}

export function modelErrorMessage(error: unknown): string {
  if (error instanceof vscode.LanguageModelError) {
    if (error.code === vscode.LanguageModelError.NoPermissions().code) {
      return 'CodeGraph could not send the request because language model access was not granted. Please allow Copilot language model access and try again.';
    }

    if (error.code === vscode.LanguageModelError.NotFound().code) {
      return 'CodeGraph could not find the selected Copilot language model. Please select an available model and try again.';
    }

    if (error.code === vscode.LanguageModelError.Blocked().code) {
      return 'CodeGraph could not send the request because the selected model is currently blocked or over quota.';
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return `CodeGraph could not complete the model request. ${message}`;
}

/** Small colored icon that conveys context confidence at a glance. */
function confidenceIcon(confidence: CodeGraphContextPackage['confidence']): string {
  switch (confidence) {
    case 'high':
      return '🟢';
    case 'medium':
      return '🟡';
    default:
      return '🔴';
  }
}

export function fallbackAnswer(contextPackage: CodeGraphContextPackage, error: string): string {
  const files =
    contextPackage.relevantFiles.slice(0, 6).map((file) => `- \`${file.path}\` — ${file.reason}`).join('\n') ||
    '- No relevant files found.';
  const missingContext =
    contextPackage.confidence === 'low'
      ? '\n\n> _Confidence is low — the index may be incomplete, the relevant files may not be TypeScript/JavaScript, or the prompt may need a more specific symbol/file name._'
      : '';

  return [
    `> ⚠️ CodeGraph hit a problem before it could produce a full model answer: ${error}`,
    '',
    '---',
    '',
    `**📎 Context used** · ${confidenceIcon(contextPackage.confidence)} confidence: ${contextPackage.confidence}`,
    '',
    files,
    missingContext,
  ].join('\n');
}

export function contextFooter(contextPackage: CodeGraphContextPackage): string {
  const files = contextPackage.relevantFiles.slice(0, 5).map((file) => `- \`${file.path}\` — ${file.reason}`);
  const missingContext =
    contextPackage.confidence === 'low'
      ? '\n\n> _Confidence is low — missing context may include unindexed files, non-JS/TS code, unsaved changes, or a more specific symbol/file name._'
      : '';

  return [
    '',
    '---',
    '',
    `**📎 Context used** · ${confidenceIcon(contextPackage.confidence)} confidence: ${contextPackage.confidence}`,
    '',
    files.length > 0 ? files.join('\n') : '- No strong file matches found.',
    missingContext,
  ].join('\n');
}
