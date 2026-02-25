
# Pr Markdown Preview

Ajoute un onglet de comparaison des fichiers Markdown modifiés dans un mode Preview.

## Debug

[Projet de base](https://github.com/microsoft/azure-devops-extension-hot-reload-and-debug)

Il faut compiler l'app pour générer le dist/ :

> npx webpack --mode development

Ensuite vous devez changer le numéro de version dans vss-extension.json puis vous allez pouvoir packager l'extension en mode "dev" :

> npx tfx-cli extension create --manifest-globs vss-extension.json --overrides-file configs/dev.json

Déployez l'extension dans le marketplace, puis vous allez pouvoir lancer l'application localement via :

> npx webpack-dev-server --mode development

Ouvrez dans le navigateur l'url, et ignorer l'alert du certificat car nous sommes en locahost\* :

[](https://localhost:3000/dist/PrMarkdownPreview/PrMarkdownPreview.html)

Vous avez à approuver une notification de votre navigateur, car du contexte du site https://dev.azure.com/ notre extension souhaite communiquer avec le localhost :

![Azure site notification](./img/debug-az-ext.png)

\* Si vous avez un soucis comme quoi l'extension met du temps à charger refaite cette étape !