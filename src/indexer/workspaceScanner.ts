import * as vscode from 'vscode';
import { excludeGlob, genericSourceGlob, isGeneratedArtifact, isTypescriptSourcePath, sourceGlob } from '../utils/fileFilters';
import { WorkspaceSourceFile } from './sourceFile';

export type { WorkspaceSourceFile } from './sourceFile';

export async function scanWorkspaceSources(): Promise<WorkspaceSourceFile[]> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    return [];
  }

  const [tsUris, genericUris] = await Promise.all([
    vscode.workspace.findFiles(sourceGlob, excludeGlob),
    vscode.workspace.findFiles(genericSourceGlob, excludeGlob),
  ]);

  // Directory artifacts are already dropped by `excludeGlob`; this also drops generated files
  // that live outside those dirs (e.g. a `*.GlobalUsings.g.cs` or checked-in `*.min.js`).
  const allUris = dedupeUris([...tsUris, ...genericUris]).filter((uri) => !isGeneratedArtifact(uri.fsPath));
  const files = await Promise.all(
    allUris.map(async (uri): Promise<WorkspaceSourceFile> => {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return {
        uri: uri.toString(),
        workspaceRelativePath: vscode.workspace.asRelativePath(uri, false),
        text: Buffer.from(bytes).toString('utf8'),
        isTypescript: isTypescriptSourcePath(uri.fsPath),
      };
    }),
  );

  return files.sort((left, right) => left.workspaceRelativePath.localeCompare(right.workspaceRelativePath));
}

function dedupeUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  return uris.filter((uri) => {
    const key = uri.toString();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
