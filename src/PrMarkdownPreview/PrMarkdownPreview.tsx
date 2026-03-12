import "azure-devops-ui/Core/override.css";
import "./PrMarkdownPreview.scss";

import { Header } from "azure-devops-ui/Header";
import { Page } from "azure-devops-ui/Page";
import { ZeroData } from "azure-devops-ui/ZeroData";
import * as React from "react";
import * as ReactDOM from "react-dom";

import * as SDK from "azure-devops-extension-sdk";
import MarkdownIt from "markdown-it";
import diff from "html-diff-ts";
import DOMPurify from "dompurify";

import { AzureAPIHelper } from "./Services/AzureAPIHelper/AzureAPIHelper";
import { AzurePrConfig } from "./Services/AzureAPIHelper/Models/AzurePrConfig";
import { MdFileItem } from "./Services/AzureAPIHelper/Models/MdFileItem";
import { Change } from "./Services/AzureAPIHelper/Models/Change";

interface IPrMarkdownPreviewState {
  panelShown: boolean;
  files: MdFileItem[];
  selectedPath?: string;
  diffHtml?: string;
  loading: boolean;
  error?: string;
  viewMode: "inline" | "split";
}

class PrMarkdownPreview extends React.Component<{}, IPrMarkdownPreviewState> {
  azureAPIHelper: AzureAPIHelper;
  azurePrConfig: AzurePrConfig;
  private md: MarkdownIt;

  private leftPaneRef = React.createRef<HTMLDivElement>();
  private rightPaneRef = React.createRef<HTMLDivElement>();
  private isSyncing = false;

  constructor(props: {}) {
    super(props);
    this.state = {
      panelShown: true,
      files: [],
      loading: true,
      viewMode: "split"
    };
    this.azureAPIHelper = new AzureAPIHelper();
    this.azurePrConfig = new AzurePrConfig();
    this.md = new MarkdownIt({ html: true, linkify: true, breaks: true });
  }

  public async componentDidMount() {
    await SDK.init();

    try {
      const pageCtx = SDK.getPageContext();
      this.azurePrConfig.project = pageCtx.webContext.project.name;

      const cfg: any = SDK.getConfiguration();
      this.azurePrConfig.repositoryId = cfg.repositoryId;

      const pr = cfg.pullRequest;
      this.azurePrConfig.prId = pr.pullRequestId;
      this.azurePrConfig.mrgCommit = pr.lastMergeCommitId;
      this.azurePrConfig.srcCommit = pr.lastMergeSourceCommitId;   // HEAD (après)
      this.azurePrConfig.tgtCommit = pr.lastMergeTargetCommitId;   // BASE (avant)

      const host = SDK.getHost();
      this.azurePrConfig.organization = host.name;

      this.azureAPIHelper.init(
        this.azurePrConfig.organization,
        this.azurePrConfig.project,
        this.azurePrConfig.repositoryId
      );

      const baseCommitId = this.azurePrConfig.tgtCommit!;
      const headCommitId = this.azurePrConfig.srcCommit!;

      // --- 1) Construire la liste complète des fichiers MD & agréger les changeType sur TOUS les commits de la PR ---
      const prCommitIds: string[] = (pr?.commits ?? []).map((c: any) => c.commitId);
      // ordre probable: du plus récent au plus ancien → on inverse pour avoir ancien → récent
      const orderedCommitIds = [...prCommitIds].reverse();

      const isMd = (path: string) => /\.(md|markdown)$/i.test(path);

      // Union finale des fichiers affichés (clé = chemin final)
      const byPath = new Map<string, MdFileItem>();

      // Agrégation des flags "changeType" EXACTS par chemin final (on garde la 1re casse rencontrée)
      const flagsByPath = new Map<string, Map<string, string>>(); // path -> (flagLower -> flagTokenTelQuel)

      // --- Gestion des renames ---
      // oldToNew : map des anciens chemins vers les nouveaux (chaînés si plusieurs renames)
      const oldToNew = new Map<string, string>();
      const newToOld = new Map<string, string>();

      const splitFlags = (ct?: string) =>
        (ct ?? "").toLowerCase().split(/[,\s]+/).map(t => t.trim()).filter(Boolean);

      const addFlags = (path: string, changeType?: string) => {
        if (!changeType) return;
        const rawTokens = changeType.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
        if (!rawTokens.length) return;
        const m = flagsByPath.get(path) ?? new Map<string, string>();
        for (const tok of rawTokens) {
          const k = tok.toLowerCase();
          if (!m.has(k)) m.set(k, tok);
        }
        flagsByPath.set(path, m);
      };

      const resolveFinalPath = (p: string) => {
        let cur = p;
        const guard = new Set<string>();
        while (oldToNew.has(cur) && !guard.has(cur)) {
          guard.add(cur);
          cur = oldToNew.get(cur)!;
        }
        return cur;
      };

      const resolveBasePathForNew = (newPath: string) => {
        let cur = newPath;
        const guard = new Set<string>();
        while (newToOld.has(cur) && !guard.has(cur)) {
          guard.add(cur);
          cur = newToOld.get(cur)!;
        }
        return cur;
      };

      // Pour lookup du contenu BASE sur l'ancien chemin quand il y a rename
      const baseLookupPathByNewPath = new Map<string, string>();

      if (orderedCommitIds.length > 0) {
        // Charger les changements de chaque commit en parallèle
        const perCommitChanges: Change[][] = await Promise.all(
          orderedCommitIds.map((cid) => this.azureAPIHelper.GetFilesChanges(cid))
        );

        // 1ère passe : détecter les paires de rename (old -> new)
        for (const commitChanges of perCommitChanges) {
          for (const chg of commitChanges) {
            const tokens = splitFlags(chg.changeType);
            // Sur le NOUVEAU chemin (rename), on devrait avoir sourceServerItem = ancien chemin
            const anyChg = chg as any; // pour accéder à chg.sourceServerItem si non typé
            if (tokens.indexOf("rename") >= 0 && anyChg?.sourceServerItem && chg.item?.path) {
              const oldPath = anyChg.sourceServerItem as string;
              const newPath = chg.item.path as string;
              oldToNew.set(oldPath, newPath);
              newToOld.set(newPath, oldPath);
            }
          }
        }

        // 2e passe : agréger les fichiers & flags sur le CHEMIN FINAL, ignorer la voie "sourceRename"
        for (const commitChanges of perCommitChanges) {
          for (const chg of commitChanges) {
            const p = chg?.item?.path;
            if (!p || !isMd(p)) continue;

            const tokensLower = splitFlags(chg.changeType);

            // Ignorer l’entrée de l'ancien chemin portant "sourceRename" (ex: "delete, sourceRename")
            if (tokensLower.indexOf("sourcerename") >= 0) {
              continue;
            }

            // Résoudre le chemin final après éventuelles chaînes de rename
            const finalPath = resolveFinalPath(p);

            // Créer/mettre à jour l'entry (toujours comparer base <-> head)
            const entry = byPath.get(finalPath) ?? ({
              path: finalPath,
              srcCommitId: headCommitId,
              tgtCommitId: baseCommitId
            } as MdFileItem);
            entry.srcCommitId = headCommitId;
            entry.tgtCommitId = baseCommitId;
            byPath.set(finalPath, entry);

            // Agréger les flags du changeType EXACTS tels que renvoyés par l'API
            addFlags(finalPath, chg.changeType);
          }
        }

        // Construire la table de lookup pour BASE (ancien chemin le plus ancien)
        for (const newPath of newToOld.keys()) {
          baseLookupPathByNewPath.set(newPath, resolveBasePathForNew(newPath));
        }
      } else {
        // 🔁 Fallback : pas de commits listés → on retombe sur l'union base/head comme avant
        const [filesSrcChgs, filesTgtChgs]: [Change[], Change[]] = await Promise.all([
          this.azureAPIHelper.GetFilesChanges(headCommitId),
          this.azureAPIHelper.GetFilesChanges(baseCommitId)
        ]);

        const union = [...filesSrcChgs, ...filesTgtChgs];

        // 1ère passe : détecter renames à partir de l'union
        for (const chg of union) {
          const tokens = splitFlags(chg.changeType);
          const anyChg = chg as any;
          if (tokens.indexOf("rename") >= 0 && anyChg?.sourceServerItem && chg.item?.path) {
            const oldPath = anyChg.sourceServerItem as string;
            const newPath = chg.item.path as string;
            oldToNew.set(oldPath, newPath);
            newToOld.set(newPath, oldPath);
          }
        }

        // 2e passe : agréger sur le chemin final, ignorer "sourceRename"
        for (const chg of union) {
          const p = chg?.item?.path;
          if (!p || !isMd(p)) continue;
          const tokensLower = splitFlags(chg.changeType);
          if (tokensLower.indexOf("sourcerename") >= 0) continue;

          const finalPath = resolveFinalPath(p);
          const entry = byPath.get(finalPath) ?? ({
            path: finalPath,
            srcCommitId: headCommitId,
            tgtCommitId: baseCommitId
          } as MdFileItem);
          byPath.set(finalPath, entry);

          addFlags(finalPath, chg.changeType);
        }

        for (const newPath of newToOld.keys()) {
          baseLookupPathByNewPath.set(newPath, resolveBasePathForNew(newPath));
        }
      }

      // --- 2) Charger les contenus aux DEUX commits pour le diff ---
      const items = Array.from(byPath.values());

      await Promise.all(
        items.map(async (it) => {
          // BASE (target) : si rename, lire sur l'ANCIEN chemin initial
          const baseLookupPath = baseLookupPathByNewPath.get(it.path) ?? it.path;
          try {
            it.tgtContent = await this.azureAPIHelper.GetFileContent(baseLookupPath, baseCommitId);
          } catch {
            it.tgtContent = ""; // n'existe pas à base
          }

          // HEAD (source) : lire sur le NOUVEAU chemin (final)
          try {
            it.srcContent = await this.azureAPIHelper.GetFileContent(it.path, headCommitId);
          } catch {
            it.srcContent = ""; // n'existe pas à head
          }
        })
      );

      // --- 3) Poser le status = concat EXACTE des changeType agrégés sur l'ensemble des commits ---
      for (const it of items) {
        const flags = flagsByPath.get(it.path);
        it.status = flags && flags.size > 0 ? Array.from(flags.values()).join(", ") : "";
      }

      // --- 4) État & 1ère sélection ---
      this.setState(
        {
          files: items.sort((a, b) => a.path.localeCompare(b.path)),
          loading: false,
          selectedPath: items.length ? items[0].path : undefined
        },
        () => {
          if (this.state.selectedPath) {
            this.computeAndSetDiff(this.state.selectedPath!);
          }
        }
      );
    } catch (e: any) {
      console.error(e);
      this.setState({ loading: false, error: e?.message ?? String(e) });
    }
  }

  /** Diff HTML sur le rendu Markdown : BASE -> HEAD (ajouts en <ins>, suppressions en <del>) */
  private buildDiffHtml(baseContent: string, headContent: string): string {
    const htmlBase = this.md.render(baseContent ?? "");
    const htmlHead = this.md.render(headContent ?? "");
    const res = diff(htmlBase, htmlHead);
    const safe = DOMPurify.sanitize(res, {
      ADD_TAGS: ["ins", "del"],
      ADD_ATTR: ["class", "style"]
    });
    return safe;
  }

  private computeAndSetDiff(path: string) {
    const item = this.state.files.find((f) => f.path === path);
    if (!item) return;

    const diffHtml = this.buildDiffHtml(item.tgtContent ?? "", item.srcContent ?? "");
    this.setState({ diffHtml, selectedPath: path });
  }

  private setViewMode(mode: "inline" | "split") {
    this.setState({ viewMode: mode });
  }

  private syncScroll(source: "left" | "right") {
    if (this.isSyncing) return;
    const left = this.leftPaneRef.current;
    const right = this.rightPaneRef.current;
    if (!left || !right) return;

    const from = source === "left" ? left : right;
    const to = source === "left" ? right : left;

    const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    this.isSyncing = true;
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    this.isSyncing = false;
  }

  private toKebab(s: string): string {
    return s
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2") // camelCase -> camel-Case
      .replace(/[^a-z0-9]+/gi, "-")           // autres séparateurs -> -
      .replace(/^-+|-+$/g, "")                // trim des -
      .toLowerCase();
  }

  private buildStatusClass(status?: string): string {
    if (!status) return "status-badge";
    const tokens = status
      .split(/[,\s]+/)       // split sur virgule(s) et/ou espaces
      .map(t => t.trim())
      .filter(Boolean);

    // déduplication en conservant l'ordre
    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      const k = t.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        uniq.push(t);
      }
    }

    const classes = ["status-badge", ...uniq.map(t => `status-${this.toKebab(t)}`)];
    return classes.join(" ");
  }

  public render(): JSX.Element {
    const { panelShown, loading, error, files, selectedPath, diffHtml } = this.state;

    return (
      <Page className="flex-grow">
        <Header
          title="PR Markdown Preview"
          commandBarItems={[
            {
              id: "panel-button",
              text: panelShown ? "Fermer le panneau" : "Ouvrir le panneau",
              iconProps: { iconName: "Preview" },
              onActivate: () => this.togglePanel()
            },
            {
              id: "inline-mode",
              text: "Inline",
              iconProps: { iconName: this.state.viewMode === "inline" ? "CheckMark" : "Compare" },
              onActivate: () => this.setViewMode("inline")
            },
            {
              id: "split-mode",
              text: "Côte à côte",
              iconProps: { iconName: this.state.viewMode === "split" ? "CheckMark" : "SideBySide" },
              onActivate: () => this.setViewMode("split")
            }
          ]}
        />

        {loading && (
          <ZeroData
            primaryText="Chargement des fichiers Markdown de la PR…"
            imageAltText="Loading"
            iconProps={{ iconName: "Spinner" }}
          />
        )}

        {error && (
          <ZeroData
            primaryText="Erreur lors du chargement"
            secondaryText={<span>{error}</span>}
            imageAltText="Error"
            iconProps={{ iconName: "Error" }}
          />
        )}

        {!loading && !error && files.length === 0 && (
          <ZeroData
            primaryText="Aucun fichier Markdown dans cette PR."
            imageAltText="No data"
            iconProps={{ iconName: "Info" }}
          />
        )}

        {files.length > 0 && (
          <div className={`pr-md-preview__layout ${panelShown}`}>
            {/* Panneau gauche : liste de fichiers */}
            {panelShown && (
              <aside className="pr-md-preview__left">
                <div className="pr-md-preview__left__header">Fichiers Markdown</div>
                <ul className="pr-md-preview__filelist">
                  {files.map((f) => {
                    const isSelected = f.path === selectedPath;
                    return (
                      <li
                        key={f.path}
                        className={`pr-md-preview__fileitem ${isSelected ? "is-selected" : ""}`}
                        onClick={() => this.computeAndSetDiff(f.path)}
                        title={f.path}
                      >
                        {/* status = concat des changeType agrégés (ex: "rename, edit") */}
                        <span className={this.buildStatusClass(f.status)}>
                          {f.status}
                        </span>
                        <span className="path">{f.path}</span>
                      </li>
                    );
                  })}
                </ul>
              </aside>
            )}

            {/* Zone droite : preview avec diff */}
            <main className="pr-md-preview__right">
              {selectedPath ? (
                <>
                  <div className="pr-md-preview__right__header">
                    {selectedPath} — {this.state.viewMode === "inline" ? "Inline" : "Côte à côte"}
                  </div>

                  {this.state.viewMode === "inline" ? (
                    <div
                      className="md-diff pr-md-preview__preview"
                      dangerouslySetInnerHTML={{ __html: diffHtml ?? "" }}
                    />
                  ) : (
                    <div className="pr-md-preview__split">
                      {/* Avant (cache <ins>) */}
                      <section className="pr-md-preview__pane pane-left">
                        <div className="pr-md-preview__subheader">Avant (cible)</div>
                        <div
                          ref={this.leftPaneRef}
                          className="md-diff pr-md-preview__paneContent"
                          onScroll={() => this.syncScroll("left")}
                          dangerouslySetInnerHTML={{ __html: diffHtml ?? "" }}
                        />
                      </section>

                      {/* Après (cache <del>) */}
                      <section className="pr-md-preview__pane pane-right">
                        <div className="pr-md-preview__subheader">Après (source)</div>
                        <div
                          ref={this.rightPaneRef}
                          className="md-diff pr-md-preview__paneContent"
                          onScroll={() => this.syncScroll("right")}
                          dangerouslySetInnerHTML={{ __html: diffHtml ?? "" }}
                        />
                      </section>
                    </div>
                  )}
                </>
              ) : (
                <ZeroData
                  primaryText="Sélectionnez un fichier pour voir la prévisualisation."
                  imageAltText="Select"
                  iconProps={{ iconName: "Edit" }}
                />
              )}
            </main>
          </div>
        )}
      </Page>
    );
  }

  private togglePanel(): void {
    this.setState({ panelShown: !this.state.panelShown });
  }
}

ReactDOM.render(<PrMarkdownPreview />, document.getElementById("root"));
