import "azure-devops-ui/Core/override.css";
import "./PrMarkdownPreview.scss";

import { Header } from "azure-devops-ui/Header";
import { Page } from "azure-devops-ui/Page";
import { ZeroData } from "azure-devops-ui/ZeroData";
import * as React from "react";
import * as ReactDOM from "react-dom";

import * as SDK from "azure-devops-extension-sdk";
import MarkdownIt from "markdown-it";
import diff from 'html-diff-ts';
import DOMPurify from "dompurify";

import { AzureAPIHelper } from "./Services/AzureAPIHelper/AzureAPIHelper"
import { AzurePrConfig } from "./Services/AzureAPIHelper/Models/AzurePrConfig"
import { MdFileItem } from "./Services/AzureAPIHelper/Models/MdFileItem"
import { Change } from "./Services/AzureAPIHelper/Models/Change"

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

  constructor(props: {}) {
    super(props);
    this.state = {
      panelShown: true,
      files: [],
      loading: true,
      viewMode: "inline"
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
      this.azurePrConfig.srcCommit = pr.lastMergeSourceCommitId;
      this.azurePrConfig.tgtCommit = pr.lastMergeTargetCommitId;

      const host = SDK.getHost();
      this.azurePrConfig.organization = host.name;

      this.azureAPIHelper.init(
        this.azurePrConfig.organization,
        this.azurePrConfig.project,
        this.azurePrConfig.repositoryId
      );
debugger;
      // 1) Récupérer la liste des changements côté source et target
      const [filesSrcChgs, filesTgtChgs]: [Change[], Change[]] = await Promise.all([
        this.azureAPIHelper.GetFilesChanges(this.azurePrConfig.srcCommit),
        this.azureAPIHelper.GetFilesChanges(this.azurePrConfig.tgtCommit)
      ]);

      const isMd = (path: string) => /\.(md|markdown)$/i.test(path);

      // 2) Construire une map path -> MdFileItem (fusion src/tgt)
      const byPath = new Map<string, MdFileItem>();

      for (const chg of filesSrcChgs) 
      {
        if (!isMd(chg.item.path)) continue;
        const entry = byPath.get(chg.item.path) ?? {
          path: chg.item.path,
        };      
        entry.srcCommitId = chg.item.commitId;
        entry.status = entry.status ?? "modified";
        byPath.set(chg.item.path, entry);
      }

      for (const chg of filesTgtChgs) {
        if (!isMd(chg.item.path)) continue;
        const entry = byPath.get(chg.item.path) ?? {
          path: chg.item.path
        };
        entry.tgtCommitId = chg.item.commitId;
        entry.status = entry.status ?? "modified";
        byPath.set(chg.item.path, entry);
      }

      // Affiner status : added / deleted / modified
      for (const [, entry] of byPath) {
        if (entry.srcCommitId && !entry.tgtCommitId) entry.status = "added";
        else if (!entry.srcCommitId && entry.tgtCommitId) entry.status = "deleted";
        else entry.status = "modified";
      }

      // 3) Charger les contenus (en parallèle)
      const items = Array.from(byPath.values());

      await Promise.all(
        items.map(async (it) => {
          if (it.srcCommitId) {
            it.srcContent = await this.azureAPIHelper.GetFileContent(it.path, it.srcCommitId);
          } else {
            it.srcContent = ""; // vide si absent
          }
          if (it.tgtCommitId) {
            it.tgtContent = await this.azureAPIHelper.GetFileContent(it.path, it.tgtCommitId);
          } else {
            it.tgtContent = "";
          }
        })
      );

      // 4) Mettre à jour l’état
      this.setState({
        files: items.sort((a, b) => a.path.localeCompare(b.path)),
        loading: false,
        selectedPath: items.length ? items[0].path : undefined
      }, () => {
        if (this.state.selectedPath) {
          this.computeAndSetDiff(this.state.selectedPath!);
        }
      });

    } catch (e: any) {
      console.error(e);
      this.setState({ loading: false, error: e?.message ?? String(e) });
    }
  }

  private buildDiffHtml(src: string, tgt: string): string {
    const htmlA = this.md.render(src ?? "");
    const htmlB = this.md.render(tgt ?? "");
    const res = diff(htmlA, htmlB);
    const safe = DOMPurify.sanitize(res, {
      ADD_TAGS: ["ins", "del"],
      ADD_ATTR: ["class", "style"]
    });
    return safe;
  }

  private computeAndSetDiff(path: string) {
    const item = this.state.files.find(f => f.path === path);
    if (!item) return;

    const diffHtml = this.buildDiffHtml(item.tgtContent ?? "", item.srcContent ?? "");
    this.setState({ diffHtml, selectedPath: path });
  }

  private setViewMode(mode: "inline" | "split") {
    this.setState({ viewMode: mode });
  }

  private leftPaneRef = React.createRef<HTMLDivElement>();
  private rightPaneRef = React.createRef<HTMLDivElement>();
  private isSyncing = false;

  private syncScroll(source: "left" | "right") {
    if (this.isSyncing) return;
    const left = this.leftPaneRef.current;
    const right = this.rightPaneRef.current;
    if (!left || !right) return;

    const from = source === "left" ? left : right;
    const to = source === "left" ? right : left;

    const ratio = from.scrollTop / Math.max(1, (from.scrollHeight - from.clientHeight));
    this.isSyncing = true;
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    this.isSyncing = false;
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

        {panelShown && files.length > 0 && (
          <div className="pr-md-preview__layout">
            {/* Panneau gauche : liste de fichiers */}
            <aside className="pr-md-preview__left">
              <div className="pr-md-preview__left__header">Fichiers Markdown</div>
              <ul className="pr-md-preview__filelist">
                {files.map(f => {
                  const isSelected = f.path === selectedPath;
                  return (
                    <li
                      key={f.path}
                      className={`pr-md-preview__fileitem ${isSelected ? "is-selected" : ""}`}
                      onClick={() => this.computeAndSetDiff(f.path)}
                      title={f.path}
                    >
                      <span className={`status-badge status-${f.status}`}>{f.status}</span>
                      <span className="path">{f.path}</span>
                    </li>
                  );
                })}
              </ul>
            </aside>

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
                      <section className="pr-md-preview__pane pane-left">
                        <div className="pr-md-preview__subheader">Avant (cible)</div>
                        <div
                          ref={this.leftPaneRef}
                          className="md-diff pr-md-preview__paneContent"
                          onScroll={() => this.syncScroll("left")}
                          dangerouslySetInnerHTML={{ __html: diffHtml ?? "" }}
                        />
                      </section>

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