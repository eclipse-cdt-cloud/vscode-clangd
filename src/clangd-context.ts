import {worker} from 'cluster';
import {read} from 'fs';
import * as vscode from 'vscode';
import {
  ExecuteCommandFeature
} from 'vscode-languageclient/lib/common/executeCommand';
import * as vscodelc from 'vscode-languageclient/node';
import * as languageClient from 'vscode-languageclient/node';
import {
  DynamicFeature,
  ExecuteCommandRequest,
  StaticFeature
} from 'vscode-languageclient/node';

import * as ast from './ast';
import * as config from './config';
import * as configFileWatcher from './config-file-watcher';
import * as fileStatus from './file-status';
import * as inactiveRegions from './inactive-regions';
import * as inlayHints from './inlay-hints';
import * as install from './install';
import * as memoryUsage from './memory-usage';
import * as openConfig from './open-config';
import {Project} from './project/api';
import {
  ClangdProjectService,
  ProjectConfiguration
} from './project/project-service';
import * as switchSourceHeader from './switch-source-header';
import * as typeHierarchy from './type-hierarchy';

export const clangdDocumentSelector: vscodelc.TextDocumentFilter[] = [
  {scheme: 'file', language: 'c'},
  {scheme: 'file', language: 'cpp'},
  {scheme: 'file', language: 'cuda-cpp'},
  {scheme: 'file', language: 'objective-c'},
  {scheme: 'file', language: 'objective-cpp'},
];

const fallbackProjectId = 'none';

export function isClangdDocument(document: vscode.TextDocument) {
  return vscode.languages.match(clangdDocumentSelector, document);
}

class ClangdLanguageClient extends vscodelc.LanguageClient {

  // Override the default implementation for failed requests. The default
  // behavior is just to log failures in the output panel, however output panel
  // is designed for extension debugging purpose, normal users will not open it,
  // thus when the failure occurs, normal users doesn't know that.
  //
  // For user-interactive operations (e.g. applyFixIt, applyTweaks), we will
  // prompt up the failure to users.

  handleFailedRequest<T>(type: vscodelc.MessageSignature, error: any,
                         token: vscode.CancellationToken|undefined,
                         defaultValue: T): T {
    if (error instanceof vscodelc.ResponseError &&
        type.method === 'workspace/executeCommand')
      vscode.window.showErrorMessage(error.message);

    return super.handleFailedRequest(type, token, error, defaultValue);
  }

  override start(): Promise<void> {
    this.deactivateExecuteCommandFeature()
    return super.start();
  }

  // temporary removal of the `ExecuteCommandFeature` which does not support
  // multi-clients at the moment
  private deactivateExecuteCommandFeature() {
    const features: (StaticFeature|DynamicFeature<any>)[] = this['_features'];
    const toRemove =
        features.find(feature => feature instanceof ExecuteCommandFeature)!;
    features.splice(features.indexOf(toRemove), 1);
  }
}

class EnableEditsNearCursorFeature implements vscodelc.StaticFeature {
  initialize() {}
  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities): void {
    const extendedCompletionCapabilities: any =
        capabilities.textDocument?.completion;
    extendedCompletionCapabilities.editsNearCursor = true;
  }
  getState(): vscodelc.FeatureState { return {kind: 'static'}; }
  dispose() {}
}

export class ClangdContext implements vscode.Disposable {
  subscriptions: vscode.Disposable[] = [];
  clients: Map<string, ClangdLanguageClient> = new Map();
  outputChannels: Map<string, vscode.OutputChannel> = new Map();
  registeredFeatures:
      Array<languageClient.StaticFeature|languageClient.DynamicFeature<any>> =
          [];

  private serverOptions?: vscodelc.ServerOptions;

  private unmatchedDocuments: vscode.TextDocument[] = [];
  _activeProjectOverride?: Project;

  get activeProjectOverride(): Project|undefined {
    return this._activeProjectOverride;
  }

  set activeProjectOverride(project: Project|undefined) {
    const oldActiveProject = this._activeProjectOverride;
    this._activeProjectOverride = project;
    if (oldActiveProject) {
      this.disposeClient(oldActiveProject.id);
      this.createClient(oldActiveProject, this.serverOptions!)
    }
    if (project) {
      this.disposeClient(project.id);
      this.createClient(project, this.serverOptions!)
    }
  }

  registerFeature(feature: languageClient.StaticFeature|
                  languageClient.DynamicFeature<any>) {
    this.clients.forEach(client => client.registerFeature(feature));
    this.registeredFeatures.push(feature);
  }
  constructor(private projectService: ClangdProjectService) {}

  get client(): ClangdLanguageClient {
    throw new Error(
        'Invalid access. Context.client is currently not implemented');
  }

  async activate(globalStoragePath: string) {
    const clangdPath = await install.activate(this, globalStoragePath);
    if (!clangdPath)
      return;

    const clangd: vscodelc.Executable = {
      command: clangdPath,
      args: await config.get<string[]>('arguments'),
      options: {cwd: vscode.workspace.rootPath || process.cwd()}
    };
    const traceFile = config.get<string>('trace');
    if (!!traceFile) {
      const trace = {CLANGD_TRACE: traceFile};
      clangd.options = {env: {...process.env, ...trace}};
    }
    this.serverOptions = clangd;

    if (this.projectService.isEnabled) {
      const onDidOpenTextDocument = (document: vscode.TextDocument) =>
          this.didOpenTextDocument(document, this.serverOptions!);
      this.subscriptions.push(
          vscode.workspace.onDidOpenTextDocument(onDidOpenTextDocument))
      vscode.workspace.textDocuments.forEach(onDidOpenTextDocument);
      this.projectService.onProjectsChanged(change => {
        if (!this._activeProjectOverride) {
          return;
        }
        if (change.removed?.includes(this._activeProjectOverride)) {
          this.clients.get(this._activeProjectOverride.id)?.dispose();
          this._activeProjectOverride = undefined;
        } else if (change.updated?.includes(this._activeProjectOverride)) {
          this.clients.get(this._activeProjectOverride.id)?.dispose();
          this.createClient(this._activeProjectOverride, this.serverOptions!);
        }
      })
    } else {
      const client =
          this.createNewClient(this.serverOptions, this.getClientOptions())
      client.clientOptions.errorHandler = client.createDefaultErrorHandler(
          // max restart count
          config.get<boolean>('restartAfterCrash') ? /*default*/ 4 : 0);
      client.registerFeature(new EnableEditsNearCursorFeature);
      this.clients.set('*', client);
      client.start();
    }

    // typeHierarchy.activate(this);
    // inlayHints.activate(this);
    // memoryUsage.activate(this);
    // ast.activate(this);
    // openConfig.activate(this);
    console.log('Clang Language Server is now active!');
    // fileStatus.activate(this);
    // switchSourceHeader.activate(this);
    // configFileWatcher.activate(this);
  }

  private getClientOptions(project?: Project): vscodelc.LanguageClientOptions {
    let documentSelector: vscodelc.TextDocumentFilter[] = [];
    if (project) {
      documentSelector = clangdDocumentSelector.map(
          selector => ({...selector, pattern: `${project.uri.fsPath}/**/*`}));
    }
    if (!project || this.getActiveProject() === project) {
      documentSelector.push(...this.unmatchedDocuments.map(
          document => ({'pattern': document.uri.fsPath})));
    }

    const outputChannel = this.getOutputChannel(project);

    return {
      // Register the server for c-family and cuda files.
      documentSelector: documentSelector,
      initializationOptions: {
        clangdFileStatus: true,
        fallbackFlags: config.get<string[]>('fallbackFlags')
      },

      outputChannel,
      // Do not switch to output window when clangd returns output.
      revealOutputChannelOn: vscodelc.RevealOutputChannelOn.Never,

      // We hack up the completion items a bit to prevent VSCode from re-ranking
      // and throwing away all our delicious signals like type information.
      //
      // VSCode sorts by (fuzzymatch(prefix, item.filterText), item.sortText)
      // By adding the prefix to the beginning of the filterText, we get a
      // perfect
      // fuzzymatch score for every item.
      // The sortText (which reflects clangd ranking) breaks the tie.
      // This also prevents VSCode from filtering out any results due to the
      // differences in how fuzzy filtering is applies, e.g. enable dot-to-arrow
      // fixes in completion.
      //
      // We also mark the list as incomplete to force retrieving new rankings.
      // See https://github.com/microsoft/language-server-protocol/issues/898
      middleware: {
        provideCompletionItem: async (document, position, context, token,
                                      next) => {
          let list = await next(document, position, context, token);
          if (!config.get<boolean>('serverCompletionRanking'))
            return list;
          let items = (Array.isArray(list) ? list : list!.items).map(item => {
            // Gets the prefix used by VSCode when doing fuzzymatch.
            let prefix = document.getText(
                new vscode.Range((item.range as vscode.Range).start, position))
            if (prefix)
            item.filterText = prefix + '_' + item.filterText;
            // Workaround for https://github.com/clangd/vscode-clangd/issues/357
            // clangd's used of commit-characters was well-intentioned, but
            // overall UX is poor. Due to vscode-languageclient bugs, we didn't
            // notice until the behavior was in several releases, so we need
            // to override it on the client.
            item.commitCharacters = [];
            return item;
          })
          return new vscode.CompletionList(items, /*isIncomplete=*/ true);
        },
        // VSCode applies fuzzy match only on the symbol name, thus it throws
        // away all results if query token is a prefix qualified name.
        // By adding the containerName to the symbol name, it prevents VSCode
        // from filtering out any results, e.g. enable workspaceSymbols for
        // qualified symbols.
        provideWorkspaceSymbols: async (query, token, next) => {
          let symbols = await next(query, token);
          return symbols?.map(symbol => {
            // Only make this adjustment if the query is in fact qualified.
            // Otherwise, we get a suboptimal ordering of results because
            // including the name's qualifier (if it has one) in symbol.name
            // means vscode can no longer tell apart exact matches from
            // partial matches.
            if (query.includes('::')) {
              if (symbol.containerName)
                symbol.name = `${symbol.containerName}::${symbol.name}`;
              // Clean the containerName to avoid displaying it twice.
              symbol.containerName = '';
            }
            return symbol;
          })
        },
        didClose: async document => this.didCloseTextDocument(document),
      },
    };
  }

  private getOutputChannel(project?: Project): vscode.OutputChannel {
    const channel = this.outputChannels.get(project?.id ?? fallbackProjectId);
    if (channel) {
      return channel;
    }

    const newChannel = vscode.window.createOutputChannel(
        `clangd ${project ? '[' + (project.label ?? project.id) + ']' : ''}`)
    const id = project?.id ?? fallbackProjectId;
    this.outputChannels.set(id, newChannel)

    return newChannel;
  }

  private disposeClient(id: string) {
    const client = this.clients.get(id);
    if (client) {
      this.clients.delete(id);
      client.dispose();
    }
  }

  private getActiveProject(): Project|undefined {
    return this._activeProjectOverride ?? this.projectService.currentProject;
  }

  private async didOpenTextDocument(document: vscode.TextDocument,
                                    serverOptions: vscodelc.ServerOptions):
      Promise<void> {
    if (!isClangdDocument(document)) {
      return;
    }

    let project = await this.projectService.resolve(document.uri, true);
    if (!project) {
      const activeProject = this.getActiveProject();
      if (!this.unmatchedDocuments.includes(document)) {
        this.unmatchedDocuments.push(document);
      }
      this.disposeClient(activeProject?.id ?? fallbackProjectId);
      this.createClient(activeProject, serverOptions);
    } else {
      this.createClient(project, serverOptions);
    }
  }

  private createClient(project: Project|undefined,
                       serverOptions: vscodelc.ServerOptions):
      ClangdLanguageClient {
    const client =
        this.createNewClient(serverOptions, this.getClientOptions(project))
    client.clientOptions.errorHandler = client.createDefaultErrorHandler(
        // max restart count
        config.get<boolean>('restartAfterCrash') ? /*default*/ 4 : 0);
    client.registerFeature(new EnableEditsNearCursorFeature);
    this.clients.set(project?.id ?? fallbackProjectId, client);
    client.start()
    return client;
  }

  private async didCloseTextDocument(document: vscode.TextDocument):
      Promise<void> {
    if (!isClangdDocument(document)) {
      return;
    }

    const project = await this.projectService.resolve(document.uri);
    if (!project) {
      const index = this.unmatchedDocuments.indexOf(document);
      if (index < -1) {
        this.unmatchedDocuments.splice(index);
      }
      return;
    }

    if (project === this._activeProjectOverride) {
      return;
    }
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.toString().startsWith(project.uri.toString()) &&
          !document.isClosed) {
        // There is still a document that needs the clangd client => exit early
        // and do nothing
        return
      }
    }
    this.disposeClient(project.id)
  }

  private createNewClient(serverOptions: vscodelc.ServerOptions,
                          clientOptions: vscodelc.LanguageClientOptions):
      ClangdLanguageClient {
    const client = new ClangdLanguageClient('Clang Language Server',
                                            serverOptions, clientOptions);
    client.clientOptions.errorHandler = client.createDefaultErrorHandler(
        // max restart count
        config.get<boolean>('restartAfterCrash') ? /*default*/ 4 : 0);
    client.registerFeature(new EnableEditsNearCursorFeature);
    return client;
  }

  get visibleClangdEditors(): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter(
        (e) => isClangdDocument(e.document));
  }

  dispose() {
    this.subscriptions.forEach((d) => { d.dispose(); });
    this.clients.forEach(client => client.dispose());
    this.clients.clear();
    this.outputChannels.forEach(channel => channel.dispose());
    this.outputChannels.clear();
  }
}
