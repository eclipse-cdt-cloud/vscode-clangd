import * as vscode from 'vscode';

import {ClangdApiV1, ClangdExtension} from '../api/vscode-clangd';

import {ClangdContextManager} from './clangd-context-manager';

export class ClangdExtensionImpl implements ClangdExtension {
  constructor(private readonly manager: ClangdContextManager) {}

  public getApi(version: 1): ClangdApiV1;
  public getApi(version: number): unknown {
    if (version === 1) {
      // In multi-project mode: the client of the active editor, else the one
      // of the clangd editor focused last.
      const context = this.manager.contextFor(
                          vscode.window.activeTextEditor?.document.uri) ??
                      this.manager.activeContext;
      return {languageClient: context?.client};
    }

    throw new Error(`No API version ${version} found`);
  }
}
