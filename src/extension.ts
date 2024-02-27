import {basename} from 'path';
import * as vscode from 'vscode';

import {ClangdContext} from './clangd-context';
import {Project} from './project/api';
import {CmakeProjectStrategy} from './project/cmake-project-strategy';
import {
  ClangdProjectService,
  ProjectConfiguration
} from './project/project-service';

let projectService: ClangdProjectService|undefined;
/**
 *  This method is called when the extension is activated. The extension is
 *  activated the very first time a command is executed.
 */
export async function activate(context: vscode.ExtensionContext):
    Promise<ClangdProjectService> {
  if (!projectService) {
    projectService = new ClangdProjectService();
    await projectService.initialize();
  }
  const clangdContext = new ClangdContext(projectService);

  context.subscriptions.push(clangdContext);

  // An empty place holder for the activate command, otherwise we'll get an
  // "command is not registered" error.
  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.activate', async () => {}));
  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.restart', async () => {
        await clangdContext.dispose();
        await clangdContext.activate(context.globalStoragePath);
      }));

  await clangdContext.activate(context.globalStoragePath);

  const shouldCheck = vscode.workspace.getConfiguration('clangd').get(
      'detectExtensionConflicts');
  if (shouldCheck) {
    const interval = setInterval(function() {
      const cppTools = vscode.extensions.getExtension('ms-vscode.cpptools');
      if (cppTools && cppTools.isActive) {
        const cppToolsConfiguration =
            vscode.workspace.getConfiguration('C_Cpp');
        const cppToolsEnabled =
            cppToolsConfiguration.get<string>('intelliSenseEngine');
        if (cppToolsEnabled?.toLowerCase() !== 'disabled') {
          vscode.window
              .showWarningMessage(
                  'You have both the Microsoft C++ (cpptools) extension and ' +
                      'clangd extension enabled. The Microsoft IntelliSense features ' +
                      'conflict with clangd\'s code completion, diagnostics etc.',
                  'Disable IntelliSense', 'Never show this warning')
              .then(selection => {
                if (selection == 'Disable IntelliSense') {
                  cppToolsConfiguration.update(
                      'intelliSenseEngine', 'disabled',
                      vscode.ConfigurationTarget.Global);
                } else if (selection == 'Never show this warning') {
                  vscode.workspace.getConfiguration('clangd').update(
                      'detectExtensionConflicts', false,
                      vscode.ConfigurationTarget.Global);
                  clearInterval(interval);
                }
              });
        }
      }
    }, 5000);
  }
  new CmakeProjectStrategy();

  if (projectService && ProjectConfiguration.isProjectStatusEnabled()) {
    const projectStatusItem =
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
    const command = 'clangd.change.activeProjectOverride'
    projectStatusItem.command = command;
    context.subscriptions.push(
        projectStatusItem, vscode.commands.registerCommand(command, () => {
          const options: vscode.QuickPickOptions = {
            placeHolder: clangdContext.activeProjectOverride?.label,
            canPickMany: false,
            title:
                'Choose the project default project for project external files'
          };
          const items: vscode.QuickPickItem[] =
              projectService?.projects.map(project => ({
                                             label: project.label ?? project.id,
                                             detail: project.id
                                           })) ??
              [];
          items?.push({
            label: 'None',
            description: 'Auto resolve to the last active project'
          });
          vscode.window.showQuickPick(items, options).then(async value => {
            if (value?.detail) {
              const project = await projectService?.resolve(
                  vscode.Uri.parse(value.detail), true)
              clangdContext.activeProjectOverride = project;
              updateProjectStatusItem(projectStatusItem,
                                      projectService!.currentProject,
                                      clangdContext);
            }
          })
        }), projectService.onCurrentProjectChanged(change => {
          if (change.newProject) {
            updateProjectStatusItem(projectStatusItem, change.newProject,
                                    clangdContext);
          }
        }));
  }
  return projectService;
}

function updateProjectStatusItem(item: vscode.StatusBarItem,
                                 project: Project|undefined,
                                 context: ClangdContext) {
  if (project) {
    const activeProjectOverride = context.activeProjectOverride;
    const activeProject = activeProjectOverride ?? project;
    item.text = `Project: ${activeProject.label ?? activeProject.id}`
    item.tooltip = `FallbackProject: ${
        activeProjectOverride
            ? activeProjectOverride.label ?? activeProjectOverride.id
            : 'Auto'}`
    item.show();
  }
}
