import * as vscode from 'vscode';

const promptOverheadBytes = 600;

/**
 * Naive baseline = "what would a dump-the-relevant-files RAG have spent?"
 * = sum of file sizes (bytes) for every file the retriever flagged as relevant
 *   + a small fixed prompt overhead.
 *
 * Pulled into its own file so the pure `tokenSavingsAnalyzer` module stays vscode-free
 * and unit-testable outside the extension host.
 */
export async function computeNaiveBaselineBytes(filePaths: string[]): Promise<number> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return 0;

  const sizes = await Promise.all(
    filePaths.map(async (p) => {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, p));
        return stat.size;
      } catch {
        return 0;
      }
    }),
  );

  return sizes.reduce((sum, n) => sum + n, 0) + promptOverheadBytes;
}

/**
 * Same naive baseline as {@link computeNaiveBaselineBytes}, but counted with the model's real
 * tokenizer instead of bytes/4 — reads each relevant file's full contents and sums the token
 * counts. This is the apples-to-apples comparand for the actual context's tokenizer count.
 * Best-effort: unreadable files contribute 0. Returns `undefined` if there's no workspace.
 */
export async function computeNaiveBaselineTokens(
  model: vscode.LanguageModelChat,
  filePaths: string[],
  token?: vscode.CancellationToken,
): Promise<number | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;

  let total = 0;
  for (const p of filePaths) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, p));
      total += await model.countTokens(Buffer.from(bytes).toString('utf8'), token);
    } catch {
      // Unreadable/binary file — skip it.
    }
  }
  return total;
}
