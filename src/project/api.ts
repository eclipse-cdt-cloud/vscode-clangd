import * as vscode from 'vscode'

export interface ProjectService extends vscode.Disposable {
  registerStrategy(strategy: ProjectResolutionStrategy): boolean;
  unregisterStrategy(id: string): boolean
  unregisterStrategy(strategy: ProjectResolutionStrategy): boolean;
  getStrategy(id: string): ProjectResolutionStrategy|undefined
  readonly activeStrategy?: ProjectResolutionStrategy;
  readonly projects: Project[];
  /**
   * The current project is the project associated with the currently
   * focused editor widget.
   */
  readonly currentProject: Project|undefined
  onCurrentProjectChanged: vscode.Event<CurrentProjectChange>;
}

export interface StrategyChangeEvent {
  oldStrategyId?: string
  newStrategyId: string
}

export interface ProjectResolutionStrategy extends vscode.Disposable {
  id: string;
  initialize(): Promise<void>;
  readonly projects: Project[];
  onProjectsChanged: vscode.Event<ProjectsChange>;
  resolve(fileUri: vscode.Uri): Project|undefined;
}

export interface Project {
  id: string;
  label?: string, uri: vscode.Uri;
}

export interface ProjectsChange {
  added?: Project[];
  removed?: Project[];
  updated?: Project[];
}

export interface CurrentProjectChange {
  newProject?: Project, oldProject?: Project;
}
