import * as vscode from 'vscode';
import { PrivacyCenterView } from '../privacy/privacyCenterView';

export const showPrivacyCenterCommandId = 'graphweft.showPrivacyCenter';

export function registerShowPrivacyCenterCommand(view: PrivacyCenterView): vscode.Disposable {
  return vscode.commands.registerCommand(showPrivacyCenterCommandId, () => view.show());
}
