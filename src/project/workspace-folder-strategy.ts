import * as vscode from 'vscode';

import {Project, ProjectResolutionStrategy, ProjectsChange} from './api';

/**
 * The default project resolution strategy. Considers each workspace folder to
 * be a separate project. Nested workspace folders are considered to be part of
 * the outermost workspace folder/project.
 */
export class WorkspaceFolderStrategy implements ProjectResolutionStrategy {
  static readonly ID = 'workspaceFolders'
  readonly id = WorkspaceFolderStrategy.ID;

  private subscriptions: vscode.Disposable[] = [];
  private sortedWorkspaces: string[] = [];
  readonly projects: Project[] = [];
  private readonly onProjectChangedEmitter =
      new vscode.EventEmitter<ProjectsChange>();

  async initialize(): Promise<void> {
    this.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(event => {
          const added = event.added.map(workspace => {
            const outerWorkspace = this.getOuterMostWorkspaceFolder(workspace);
            return this.createProject(outerWorkspace)
          });
          const removed = event.removed.map(workspace => {
            const outerWorkspace = this.getOuterMostWorkspaceFolder(workspace);
            return this.createProject(outerWorkspace)
          });
          this.onProjectChangedEmitter.fire({added, removed});
        }));
    this.getSortedWorkspaces()
        .map(workspace => this.getOuterMostWorkspaceFolder(workspace))
        .forEach(workspace =>
                     this.projects.push(this.createProject(workspace)));

    this.onProjectChangedEmitter.fire({added: this.projects})
  }

  private createProject(workspace: vscode.WorkspaceFolder): Project {
    return {
      id: workspace.uri.toString(), label: workspace.name, uri: workspace.uri
    }
  }

  private getSortedWorkspaces(): string[] {
    this.sortedWorkspaces = (vscode.workspace.workspaceFolders ?? [])
                                ?.map(folder => this.toUri(folder))
                                .sort((a, b) => a.length - b.length);

    return this.sortedWorkspaces;
  }

  resolve(fileUri: vscode.Uri): Project|undefined {
    return this.projects.find(
        project => fileUri.toString().startsWith(project.uri.toString()))
  }

  private getOuterMostWorkspaceFolder(folder: vscode.WorkspaceFolder|
                                      string): vscode.WorkspaceFolder {
    let uri = typeof folder === `string` ? folder : this.toUri(folder);
    for (const element of this.sortedWorkspaces) {
      if (uri.startsWith(element)) {
        return vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(element))!;
      }
    }
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(uri))!;
  }

  private toUri(folder: vscode.WorkspaceFolder): string {
    const result = folder.uri.toString();
    return result.endsWith('/') ? result : result + '/'
  }

  get onProjectsChanged(): vscode.Event<ProjectsChange> {
    return this.onProjectChangedEmitter.event;
  }

  dispose() {
    this.subscriptions.forEach(subscription => subscription.dispose());
  }
}
