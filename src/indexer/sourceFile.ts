/**
 * A scanned source file, decoupled from any host. Both the VS Code scanner and the headless
 * Node scanner produce this shape, so the indexers (and the whole engine) stay host-agnostic.
 * `uri` is a string (e.g. a `file://` URL) rather than a `vscode.Uri`, keeping this vscode-free.
 */
export interface WorkspaceSourceFile {
  uri: string;
  workspaceRelativePath: string;
  text: string;
  isTypescript: boolean;
}
