import * as vscode from 'vscode';
import { GraphWebview } from '../viz/graphWebview';

export const showGraphCommandId = 'codegraph.showGraph';

export function registerShowGraphCommand(view: GraphWebview): vscode.Disposable {
  return vscode.commands.registerCommand(showGraphCommandId, (filter?: string) => view.show(filter));
}
