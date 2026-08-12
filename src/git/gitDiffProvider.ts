import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { isSupportedSourcePath } from '../utils/fileFilters';

export interface GitDiffContext {
  changedFiles: string[];
  diff: string;
  error?: string;
}

const maxDiffCharacters = 20000;

export async function getGitDiffContext(): Promise<GitDiffContext> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return { changedFiles: [], diff: '' };
  }

  try {
    const [changedFilesOutput, diffOutput] = await Promise.all([
      runGit(['diff', '--name-only', 'HEAD', '--'], workspaceFolder.uri.fsPath),
      runGit(['diff', 'HEAD', '--', '*.ts', '*.tsx', '*.js', '*.jsx'], workspaceFolder.uri.fsPath),
    ]);

    return {
      changedFiles: changedFilesOutput
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && isSupportedSourcePath(line)),
      diff: diffOutput.slice(0, maxDiffCharacters),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      changedFiles: [],
      diff: '',
      error: message,
    };
  }
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stdout);
    });
  });
}
