# clangd-vscode-multi-project

A fork of the [`clangd-vscode`](https://github.com/clangd/vscode-clangd) extension that add support to properly handle multiple projects in one workspace.
To achieve this each project is managed by a dedicated clangd client/server. This ensures that all resources that are associated with one project
are handled in an isolated context and keeps project indexes strictly separated from each other.

A central `ProjectService` is used to identify each project in an open workspace/folder base on a defined `ProjectResolution` strategy.
Adopters can define custom resolution strategies tailored to their needs (configurable via settings)
The project service also keeps track of the currently active project and exposes API to listen to project changes and/or manually change the
active project.

The multi-project support is fully opt-in and can be deactivated. If deactivated this extension will behave  like the upstream `clangd-vscode`
extension.

Note that at the moment this project should be rather seen as a proof-of-concept implementation an is not (yet) a full-fledged replacement
for `vscode-clangd`. The focus has been set on providing the core clangd LSP functionality. Customizations on top like the `Type Hierarchy View`,
`Memory Usage` etc. haven been disabled for now and do not working in `clangd-vscode-multi-project`.

For more detailed information about the setup and feature set please check out the `clangd-vscode` README:
<https://github.com/clangd/vscode-clangd#readme>