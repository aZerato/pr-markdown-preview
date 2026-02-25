
[Creer Azure Extension](https://learn.microsoft.com/en-us/azure/devops/extend/get-started/node?view=azure-devops)

## Debug

[Base project](https://github.com/microsoft/azure-devops-extension-hot-reload-and-debug)

> npx webpack --mode development

Change version number in vss-extension.json then :

> npx tfx-cli extension create --manifest-globs vss-extension.json --overrides-file configs/dev.json

> npx webpack-dev-server --mode development