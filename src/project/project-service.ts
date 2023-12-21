import * as vscode from 'vscode';

import {isClangdDocument} from '../clangd-context';

import {
  CurrentProjectChange,
  Project,
  ProjectResolutionStrategy,
  ProjectsChange,
  ProjectService,
} from './api';
import {CmakeProjectStrategy} from './cmake-project-strategy';
import {WorkspaceFolderStrategy} from './workspace-folder-strategy';

export namespace ProjectConfiguration {
export const Section = {
  Enabled: 'clangd.multiProject.enabled',
  Strategy: 'clangd.multiProject.strategy',
  ProjectStatus: `clangd.multiProject.status`
} as const;

export function getStrategy(): string {
  return vscode.workspace.getConfiguration().get(Section.Strategy,
                                                 defaultStrategy());
}

export function resetStrategy(): void {
  vscode.workspace.getConfiguration().update(Section.Strategy,
                                             defaultStrategy());
}

export function defaultStrategy(): string {
  return vscode.workspace.getConfiguration()
             .inspect<string>(Section.Strategy)
             ?.defaultValue ??
         WorkspaceFolderStrategy.ID;
}

export function isEnabled(): boolean {
  return vscode.workspace.getConfiguration().get(Section.Enabled,
                                                 defaultIsEnabled());
}

export function defaultIsEnabled(): boolean {
  return vscode.workspace.getConfiguration()
             .inspect<boolean>(Section.Enabled)
             ?.defaultValue ??
         false;
}

export function isProjectStatusEnabled(): boolean {
  return vscode.workspace.getConfiguration().get(Section.ProjectStatus, false);
}
}

export class ClangdProjectService implements ProjectService {

  private subscriptions: vscode.Disposable[] = [];
  private strategies = new Map<string, ProjectResolutionStrategy>();

  private _activeStrategy?: ProjectResolutionStrategy;
  get activeStrategy(): ProjectResolutionStrategy|undefined {
    return this._activeStrategy;
  }

  private _currentProject?: Project;
  get currentProject(): Project|undefined { return this._currentProject; }

  private _isEnabled: boolean = false;
  get isEnabled(): boolean { return this._isEnabled; }

  private onProjectsChangedEmitter = new vscode.EventEmitter<ProjectsChange>();
  get onProjectsChanged(): vscode.Event<ProjectsChange> {
    return this.onProjectsChangedEmitter.event;
  }

  private onCurrentProjectChangedEmitter =
      new vscode.EventEmitter<CurrentProjectChange>();
  get onCurrentProjectChanged(): vscode.Event<CurrentProjectChange> {
    return this.onCurrentProjectChangedEmitter.event;
  }

  get projects(): Project[] { return this._activeStrategy?.projects ?? []; }

  readonly onReady: Promise<void>;
  private resolveReady: () => void;
  private externalRegisteredStrategies = new Set<string>();

  constructor() {
    this.resolveReady = () => {};
    this.onReady = new Promise((resolve) => { this.resolveReady = resolve; });
    vscode.extensions.all
        .filter(ext => ext.packageJSON?.contributes?.clangd?.projectResolution)
        .forEach(ext => getDeclaredStrategies(ext).forEach(
                     id => this.externalRegisteredStrategies.add(id)));
  }

  async initialize(): Promise<void> {
    this.registerStrategy(new WorkspaceFolderStrategy());
    this.registerStrategy(new CmakeProjectStrategy());
    this.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(
            async event => this.handleConfigurationChange(event)),
        vscode.extensions.onDidChange(ext => {
          const allExtensionActivated =
              vscode.extensions.all.every(ext => ext.isActive);
          if (allExtensionActivated) {
            this.updateActiveStrategy(true);
          }
        }),
        vscode.window.onDidChangeActiveTextEditor(editor => {
          if (editor) {
            this.resolve(editor.document.uri, true);
          }
        }));
    this._isEnabled = ProjectConfiguration.isEnabled();
    if (this.isEnabled) {
      await this.updateActiveStrategy(false);
    }

    if (this.externalRegisteredStrategies.size === 0) {
      return this.resolveReady();
    }
  }

  private handleConfigurationChange(event: vscode.ConfigurationChangeEvent):
      void {
    const configuration = vscode.workspace.getConfiguration();
    let needsClangdRestart = false;
    if (event.affectsConfiguration(ProjectConfiguration.Section.Enabled)) {
      this._isEnabled = ProjectConfiguration.isEnabled();
      needsClangdRestart = true;
    } else if (event.affectsConfiguration(
                   ProjectConfiguration.Section.Strategy)) {
      this.updateActiveStrategy(true);
      needsClangdRestart = true;
    }

    if (needsClangdRestart) {
      vscode.commands.executeCommand('clangd.restart')
    }
  }

  private async updateActiveStrategy(validate: boolean): Promise<void> {
    const newStrategyId = ProjectConfiguration.getStrategy();
    const newStrategy = this.strategies.get(newStrategyId);
    if (newStrategy) {
      if (newStrategy === this._activeStrategy) {
        return;
      }
      this._activeStrategy = newStrategy;
      this._activeStrategy.onProjectsChanged(
          event => {this.onProjectsChangedEmitter.fire(event)});
      await this._activeStrategy.initialize();
      return;
    }

    if (validate) {
      const strategyNotFoundMsg = `No project resolution strategy with id '${
          newStrategyId}' is registered!`;
      vscode.window.showWarningMessage(strategyNotFoundMsg)
      console.warn(strategyNotFoundMsg);
      const defaultStrategy = ProjectConfiguration.defaultStrategy();
      const resetInfoMsg =
          `Reset project resolution strategy to '${defaultStrategy}'`;
      vscode.window.showWarningMessage(resetInfoMsg)
      console.warn(resetInfoMsg);
      this._activeStrategy = this.strategies.get(defaultStrategy)!;
    }
  }

  getStrategy(id: string): ProjectResolutionStrategy|undefined {
    return this.strategies.get(id);
  }

  registerStrategy(strategy: ProjectResolutionStrategy): boolean {
    if (!this.strategies.has(strategy.id)) {
      this.strategies.set(strategy.id, strategy)
      if (this.externalRegisteredStrategies.size > 0) {
        this.externalRegisteredStrategies.delete(strategy.id);
        if (this.externalRegisteredStrategies.size === 0) {
          this.resolveReady();
        }
      }
      return true;
    }
    console.warn(
        `Could not register project resolution strategy. Another registry with the same id is already registered!`,
        strategy)
    return false;
  }

  async resolve(fileUri: vscode.Uri,
                updateCurrent = false): Promise<Project|undefined> {
    await this.onReady;
    if (!this.isEnabled) {
      return undefined;
    }
    if (!this._activeStrategy) {
      await this.updateActiveStrategy(true);
    }
    const newProject = this._activeStrategy?.resolve(fileUri);
    if (newProject && updateCurrent) {
      const oldCurrentProject = this._currentProject;
      this._currentProject = newProject;
      if (oldCurrentProject !== newProject)
        this.onCurrentProjectChangedEmitter.fire(
            {newProject, oldProject: oldCurrentProject})
    }
    return newProject;
  }

  unregisterStrategy(id: string): boolean;
  unregisterStrategy(strategy: ProjectResolutionStrategy): boolean;
  unregisterStrategy(idOrStrategy: string|ProjectResolutionStrategy): boolean {
    const id =
        typeof idOrStrategy === `string` ? idOrStrategy : idOrStrategy.id;
    const toDelete = this.strategies.get(id);
    if (toDelete) {
      this.strategies.delete(toDelete.id);
      toDelete.dispose();
      if (this._activeStrategy?.id === toDelete.id) {
        ProjectConfiguration.resetStrategy();
      }
    }
    return !!toDelete;
  }

  dispose() {
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.strategies.forEach(strategy => strategy.dispose());
    this.strategies.clear();
  }
}

function getDeclaredStrategies(ext: vscode.Extension<unknown>): string[] {
  const declaration = ext.packageJSON?.contributes?.clangd?.projectResolution;

  if (Array.isArray(declaration)) {
    return declaration;
  }
  if (typeof declaration === `string`) {
    return [declaration];
  }

  return [];
}