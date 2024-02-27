import * as fs from 'fs';
import {glob} from 'glob';
import * as path from 'path';
import * as vscode from 'vscode';

import {Project, ProjectResolutionStrategy, ProjectsChange} from './api';

export class CmakeProjectStrategy implements ProjectResolutionStrategy {
  static readonly ID = 'cmake.build'
  readonly id = CmakeProjectStrategy.ID;
  private subscriptions: vscode.Disposable[] = [];
  private readonly pattern = '**/build';
  readonly projects: Project[] = [];
  private readonly onProjectChangedEmitter =
      new vscode.EventEmitter<ProjectsChange>();

  async initialize(): Promise<void> {
    this.configureFileWatcher();
    await this.findProjects();
  }

  private configureFileWatcher(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(this.pattern);
    watcher.onDidCreate(uri => {
      const projectDir = this.getProjectDirectory(uri.fsPath);
      if (projectDir) {
        const project = this.createProject(projectDir);
        this.projects.push(project);
        this.onProjectChangedEmitter.fire({added: [project]})
      }
    })
    watcher
        .onDidDelete(uri => {
          const projectDir = this.getProjectDirectory(uri.fsPath);
          if (projectDir) {

            const index = this.projects.indexOf(this.createProject(projectDir));
            if (index >= 0) {
              const removed = this.projects.splice(index);
              this.onProjectChangedEmitter.fire({removed});
            }
          }
        })

            this.subscriptions.push(watcher)
  }

  private async findProjects(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const options = {
        cwd: folder.uri.fsPath,
        nocase: true,
        mark: true,
        onlyDirectories: true,
      };
      const matches = await new Promise<string[]>((resolve, reject) => {
        glob(this.pattern, options, (err, matches) => {
          if (err) {
            reject(err);
          } else {
            resolve(matches);
          }
        });
      });

      matches
          .forEach(match => {
            const projectDir =
                this.getProjectDirectory(path.join(options.cwd, match));
            if (projectDir) {
              this.projects.push(this.createProject(projectDir))
            }
          })

              this.onProjectChangedEmitter.fire({added: this.projects})
    }
  }

  private createProject(projectUri: vscode.Uri): Project {
    return {
      id: projectUri.toString(), label: path.basename(projectUri.fsPath),
          uri: projectUri
    }
  }

  private getProjectDirectory(buildDir: string): vscode.Uri|undefined {
    const compilationDb = path.join(buildDir, 'compile_commands.json')
    if (fs.existsSync(compilationDb)) {
      return vscode.Uri.file(
          buildDir.substring(0, buildDir.lastIndexOf('/build')));
    }
    return undefined;
  }

  resolve(fileUri: vscode.Uri): Project|undefined{return this.projects.find(
      project => fileUri.toString().startsWith(project.uri.toString()))}

  get onProjectsChanged(): vscode.Event<ProjectsChange> {
    return this.onProjectChangedEmitter.event;
  }

  dispose() {
    this.subscriptions.forEach(subscription => subscription.dispose());
  }
}