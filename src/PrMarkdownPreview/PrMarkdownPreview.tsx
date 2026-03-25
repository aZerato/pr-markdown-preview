import "azure-devops-ui/Core/override.css";
import "./PrMarkdownPreview.scss";

import { Header } from "azure-devops-ui/Header";
import { Page } from "azure-devops-ui/Page";
import { ZeroData } from "azure-devops-ui/ZeroData";
import * as React from "react";
import * as ReactDOM from "react-dom";

import * as SDK from "azure-devops-extension-sdk";
import { marked } from "marked";
import * as Diff from "diff";
import * as Diff2Html from "diff2html";
import DOMPurify from "dompurify";
import "diff2html/bundles/css/diff2html.min.css";

import { AzureAPIHelper } from "./Services/AzureAPIHelper/AzureAPIHelper";
import { AzurePrConfig } from "./Services/AzureAPIHelper/Models/AzurePrConfig";
import { MdFileItem } from "./Services/AzureAPIHelper/Models/MdFileItem";
import { Change } from "./Services/AzureAPIHelper/Models/Change";

import "../i18n/i18n";
import { withTranslation, WithTranslation } from "react-i18next";

interface IPrMarkdownPreviewState {
  panelShown: boolean;
  files: MdFileItem[];
  selectedPath?: string;
  previewLeftHtml?: string;
  previewRightHtml?: string;
  diffHtml?: string;
  loading: boolean;
  error?: string;
  viewMode: "inline" | "split";
}

class PrMarkdownPreview extends React.Component<WithTranslation, IPrMarkdownPreviewState> {
  azureAPIHelper: AzureAPIHelper;
  azurePrConfig: AzurePrConfig;

  private SHORT_ADD_CHAR = 3;
  private SAME_TAG_THRESHOLD = 0.50;
  private DIFF_TAG_THRESHOLD = 0.72; 

  private leftPaneRef = React.createRef<HTMLDivElement>();
  private rightPaneRef = React.createRef<HTMLDivElement>();
  private previewLeftRef = React.createRef<HTMLDivElement>();
  private previewRightRef = React.createRef<HTMLDivElement>();

  constructor(props: WithTranslation) {
    super(props);
    this.state = {
      panelShown: true,
      files: [],
      loading: true,
      viewMode: "split"
    };
    this.azureAPIHelper = new AzureAPIHelper();
    this.azurePrConfig = new AzurePrConfig();

    marked.use({
      gfm: true,
      breaks: false
    });
  }
  
  public componentDidUpdate(prevProps: any, prevState: IPrMarkdownPreviewState) {
    const htmlChanged =
      prevState.previewLeftHtml !== this.state.previewLeftHtml ||
      prevState.previewRightHtml !== this.state.previewRightHtml;

    const modeChanged = prevState.viewMode !== this.state.viewMode;

    if ((htmlChanged || modeChanged) && this.state.viewMode === "split") {
      this.applyDiffSafely();
    }

    if (modeChanged && this.state.selectedPath) {
      this.computeAndSetDiff(this.state.selectedPath);
    }
  }

  private applyDiffSafely() {
    if (this.state.viewMode !== "split") return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.applyDiffToPreviews();
      });
    });
  }

  private escapeHtml(s: string) {
    return (s ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  private similarityTokens(aTokens: string[], bTokens: string[]) {
    if (!aTokens.length && !bTokens.length) return 1;
    const aSet = new Set(aTokens);
    const bSet = new Set(bTokens);
    let inter = 0;
    for (const t of aSet) if (bSet.has(t)) inter++;
    return (2 * inter) / (aSet.size + bSet.size || 1);
  }

  private isSimpleTextBlock(el: HTMLElement) {
    const tag = el.tagName.toLowerCase();

    // blocs complexes à exclure
    const complexTags = ["ul", "ol", "table", "thead", "tbody", "tr", "pre", "code"];
    if (complexTags.findIndex(t => t === tag) !== -1) return false;

    // enfants complexes
    const hasComplexChildren = Array.from(el.children).some(
      c => ["code", "pre", "img", "table", "ul", "ol"].findIndex(t => t === c.tagName.toLowerCase()) !== -1
    );

    if (hasComplexChildren) return false;

    return true;
  }

  private applyWordDiffToSimplePair(L: HTMLElement, R: HTMLElement, options: any) {
    const isInline = this.state.viewMode === "inline";

    const oldText = R.textContent || ""; // BEFORE
    const newText = L.textContent || ""; // AFTER

    const parts = Diff.diffWordsWithSpace(oldText, newText);

    let htmlLeft = "";
    let htmlRight = "";

    for (const part of parts) {
      const v = part.value;

      if (options.ignoreWs && /^\s+$/.test(v)) {
        htmlLeft += this.escapeHtml(v);
        htmlRight += this.escapeHtml(v);
        continue;
      }

      // ===== INLINE MODE (GitHub-like) =====
      if (isInline) {
        if (part.added) {
          htmlLeft += `<span class="gh-add" title="Added">${this.escapeHtml(v)}</span>`;
        } 
        else if (part.removed) {
          htmlLeft += `<span class="gh-del" title="Removed: ${this.escapeHtml(v)}">${this.escapeHtml(v)}</span>`;
        } 
        else {
          htmlLeft += this.escapeHtml(v);
        }
      } 
      // ===== SPLIT MODE =====
      else {
        if (part.added) {
          htmlLeft += `<span class="mkdiff-w-add">${this.escapeHtml(v)}</span>`;
        } 
        else if (part.removed) {
          htmlRight += `<span class="mkdiff-w-del">${this.escapeHtml(v)}</span>`;
        } 
        else {
          htmlLeft += this.escapeHtml(v);
          htmlRight += this.escapeHtml(v);
        }
      }
    }

    if (isInline) {
      L.innerHTML = htmlLeft;
      L.classList.add("gh-line-modified");
    } else {
      L.innerHTML = htmlLeft;
      R.innerHTML = htmlRight;
      L.classList.add("mkdiff-line-modified");
      R.classList.add("mkdiff-line-modified");
    }
  }

  private applyDiffToPreviews() {
    const leftRoot = this.previewLeftRef.current;   // AFTER
    const rightRoot = this.previewRightRef.current; // BEFORE

    if (!leftRoot || !rightRoot) return;

    const isInline = this.state.viewMode === "inline";

    const options = {
      ignoreWs: true,
      ignoreCase: false
    };

    const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,blockquote,th,td";

    const getBlocks = (root: HTMLElement) =>
      Array.from(root.querySelectorAll(BLOCKS)) as HTMLElement[];

    const leftNodes = getBlocks(leftRoot);
    const rightNodes = getBlocks(rightRoot);

    const normalize = (text: string) => {
      let t = text || "";
      if (options.ignoreWs) t = t.replace(/\s+/g, " ").trim();
      if (options.ignoreCase) t = t.toLowerCase();
      return t;
    };

    const tokenize = (s: string) =>
      (s.toLowerCase().match(/\w+/g) || []).filter(w => w.length >= 2);

    const clean = (root: HTMLElement) => {
      root.querySelectorAll("[class*='mkdiff'], [class*='gh-']").forEach(el => {
        el.classList.remove(
          "mkdiff-line-added",
          "mkdiff-line-removed",
          "mkdiff-line-modified",
          "gh-line-modified",
          "gh-block-modified"
        );
      });
    };

    clean(leftRoot);
    clean(rightRoot);

    const leftMeta = leftNodes.map(n => ({
      node: n,
      tag: n.tagName.toLowerCase(),
      text: n.textContent || "",
      key: normalize(n.textContent || ""),
      tokens: tokenize(n.textContent || "")
    }));

    const rightMeta = rightNodes.map(n => ({
      node: n,
      tag: n.tagName.toLowerCase(),
      text: n.textContent || "",
      key: normalize(n.textContent || ""),
      tokens: tokenize(n.textContent || "")
    }));

    const leftSigs = leftMeta.map(m => `${m.tag}|${m.key}`);
    const rightSigs = rightMeta.map(m => `${m.tag}|${m.key}`);

    const chunks = Diff.diffArrays(rightSigs, leftSigs, { comparator: (a, b) => a === b });

    let iR = 0, iL = 0;

    for (let idx = 0; idx < chunks.length; idx++) {
      const c = chunks[idx];

      if (!c.added && !c.removed) {
        iR += c.value.length;
        iL += c.value.length;
        continue;
      }

      if (c.removed) {
        const next = chunks[idx + 1];

        if (next && next.added) {
          const remLen = c.value.length;
          const addLen = next.value.length;

          const remIdx = Array.from({ length: remLen }, (_, k) => iR + k);
          const addIdx = Array.from({ length: addLen }, (_, k) => iL + k);

          const takenR = new Set();
          const takenL = new Set();

          for (const li of addIdx) {
            const Lm = leftMeta[li];

            let best = { score: -1, ri: -1 };

            for (const ri of remIdx) {
              if (takenR.has(ri)) continue;

              const Rm = rightMeta[ri];

              const score = this.similarityTokens(Lm.tokens, Rm.tokens);
              const sameTag = (Lm.tag === Rm.tag);
              const pass = sameTag
                ? (score >= this.SAME_TAG_THRESHOLD)
                : (score >= this.DIFF_TAG_THRESHOLD);

              if (pass && score > best.score) {
                best = { score, ri };
              }
            }

            if (best.ri !== -1) {
              takenL.add(li);
              takenR.add(best.ri);

              const Lnode = leftMeta[li].node;
              const Rnode = rightMeta[best.ri].node;

              if (this.isSimpleTextBlock(Lnode) && this.isSimpleTextBlock(Rnode)) {
                this.applyWordDiffToSimplePair(Lnode, Rnode, options);
              } else {
                Lnode.classList.add("gh-block-modified");
              }
            }
          }

          for (const li of addIdx) {
            if (!takenL.has(li)) {
              const node = leftMeta[li].node;
              node.classList.add("mkdiff-line-added");
            }
          }

          if (!isInline) {
            for (const ri of remIdx) {
              if (!takenR.has(ri)) {
                const node = rightMeta[ri].node;
                node.classList.add("mkdiff-line-removed");
              }
            }
          }

          iR += remLen;
          iL += addLen;
          idx++;
        } else {
          if (!isInline) {
            for (let t = 0; t < c.value.length; t++) {
              rightMeta[iR + t]?.node.classList.add("mkdiff-line-removed");
            }
          }
          iR += c.value.length;
        }

        continue;
      }

      if (c.added) {
        for (let t = 0; t < c.value.length; t++) {
          leftMeta[iL + t]?.node.classList.add("mkdiff-line-added");
        }
        iL += c.value.length;
      }
    }
  }

  private setupScrollSync() {
    const left = this.leftPaneRef.current;
    const right = this.rightPaneRef.current;

    if (!left || !right) return;

    let isSyncing = false;

    const sync = (from: HTMLElement, to: HTMLElement) => {
      if (isSyncing) return;
      isSyncing = true;

      const ratio = from.scrollTop / (from.scrollHeight - from.clientHeight);
      to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);

      requestAnimationFrame(() => {
        isSyncing = false;
      });
    };

    left.addEventListener("scroll", () => sync(left, right));
    right.addEventListener("scroll", () => sync(right, left));
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
      this.azurePrConfig.srcCommit = pr.lastMergeSourceCommitId;   // HEAD (after)
      this.azurePrConfig.tgtCommit = pr.lastMergeTargetCommitId;   // BASE (before)

      const host = SDK.getHost();
      this.azurePrConfig.organization = host.name;

      this.azureAPIHelper.init(
        this.azurePrConfig.organization,
        this.azurePrConfig.project,
        this.azurePrConfig.repositoryId
      );

      const baseCommitId = this.azurePrConfig.tgtCommit!;
      const headCommitId = this.azurePrConfig.srcCommit!;

      // --- 1) Build list of md files  ---
      const prCommitIds: string[] = (pr?.commits ?? []).map((c: any) => c.commitId);
      // we have to reverse order, to have older commits in first.
      const orderedCommitIds = [...prCommitIds].reverse();

      const isMd = (path: string) => /\.(md|markdown)$/i.test(path);

      // Files to show
      const byPath = new Map<string, MdFileItem>();

      // Flags "changeType"
      const flagsByPath = new Map<string, Map<string, string>>();

      // Rename histories
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

      // lookup BASE
      const baseLookupPathByNewPath = new Map<string, string>();

      // load all commits ||
      const perCommitChanges: Change[][] = await Promise.all(
        orderedCommitIds.map((cid) => this.azureAPIHelper.GetFilesChanges(cid))
      );

      // 1st : rename pairs (old -> new)
      for (const commitChanges of perCommitChanges) {
        for (const chg of commitChanges) {
          const tokens = splitFlags(chg.changeType);
          // new path : sourceServerItem = old path
          const anyChg = chg as any;
          if (tokens.indexOf("rename") >= 0 && anyChg?.sourceServerItem && chg.item?.path) {
            const oldPath = anyChg.sourceServerItem as string;
            const newPath = chg.item.path as string;
            oldToNew.set(oldPath, newPath);
            newToOld.set(newPath, oldPath);
          }
        }
      }

      // 2nd : check files/flags of the final path (ignore "source rename")
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

      // Build lookup table of new pathes
      for (const newPath of newToOld.keys()) {
        baseLookupPathByNewPath.set(newPath, resolveBasePathForNew(newPath));
      }

      // --- 2) Charger les contenus des DEUX commits pour le diff ---
      const items = Array.from(byPath.values());

      await Promise.all(
        items.map(async (it) => {
          // BASE (target) : if rename, check old path / original path
          const baseLookupPath = baseLookupPathByNewPath.get(it.path) ?? it.path;
          try {
            it.tgtContent = await this.azureAPIHelper.GetFileContent(baseLookupPath, baseCommitId);
          } catch {
            it.tgtContent = ""; // not found in the base
          }

          // HEAD (source) : read the new path (final)
          try {
            it.srcContent = await this.azureAPIHelper.GetFileContent(it.path, headCommitId);
          } catch {
            it.srcContent = ""; // not found in the head
          }
        })
      );

      // --- 3) Status
      for (const it of items) {
        const flags = flagsByPath.get(it.path);
        it.status = flags && flags.size > 0 ? Array.from(flags.values()).join(", ") : "";
      }

      // --- Set State ---
      this.setState(
        {
          files: items.sort((a, b) => a.path.localeCompare(b.path)),
          loading: false,
          selectedPath: items.length ? items[0].path : undefined
        },
        () => {
          this.setupScrollSync();
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

  private async buildDiffHtml(baseContent: string, headContent: string) {
    const options = {
      ignoreWs: true,
      ignoreCase: false
    };

    // ===== PREVIEW (TOUJOURS HTML PROPRE) =====
    const rawHtmlLeft = DOMPurify.sanitize(await marked.parse(headContent ?? ""));
    const rawHtmlRight = DOMPurify.sanitize(await marked.parse(baseContent ?? ""));

    // ===== DIFF SUR MARKDOWN (🔥 CORRECT) =====
    const patch = Diff.createTwoFilesPatch(
      "before.md",
      "after.md",
      baseContent ?? "",
      headContent ?? "",
      "",
      "",
      { context: 3 }
    );

    const diffHtml = Diff2Html.html(patch, {
      drawFileList: false,
      matching: "lines",
      outputFormat: this.state.viewMode === "split"
        ? "side-by-side"
        : "line-by-line"
    });

    return {
      diffHtml,
      previewLeftHtml: rawHtmlLeft,
      previewRightHtml: rawHtmlRight
    };
  }

  private async computeAndSetDiff(path: string) {
    const item = this.state.files.find((f) => f.path === path);
    if (!item) return;

    const result = await this.buildDiffHtml(
      item.tgtContent ?? "",
      item.srcContent ?? ""
    );

    this.setState(
    {
      diffHtml: result.diffHtml,
      previewLeftHtml: result.previewLeftHtml,
      previewRightHtml: result.previewRightHtml,
      selectedPath: path
    },
    () => {
      this.applyDiffSafely(); // 🔥 au lieu de applyDiffToPreviews
    }
  );
  }

  private setViewMode(mode: "inline" | "split") {
    this.setState({ viewMode: mode }, () => {
      this.leftPaneRef.current?.scrollTo(0, 0);
      this.rightPaneRef.current?.scrollTo(0, 0);
    });
  }

  private toKebab(s: string): string {
    return s
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
  }

  private buildStatusClass(status?: string): string {
    if (!status) return "status-badge";
    const tokens = status
      .split(/[,\s]+/)
      .map(t => t.trim())
      .filter(Boolean);

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
    const { t } = this.props;

    return (
      <Page className="flex-grow">
        <Header
          title={t("app.title")}
          commandBarItems={[
            {
              id: "panel-button",
              text: panelShown ? t("view.closepanel") : t("view.openpanel"),
              iconProps: { iconName: "ClosePane" },
              onActivate: () => this.togglePanel()
            },
            {
              id: "inline-mode",
              text: t("view.inline"),
              iconProps: { iconName: this.state.viewMode === "inline" ? "CheckMark" : "Compare" },
              onActivate: () => this.setViewMode("inline")
            },
            {
              id: "split-mode",
              text: t("view.split"),
              iconProps: { iconName: this.state.viewMode === "split" ? "CheckMark" : "SideBySide" },
              onActivate: () => this.setViewMode("split")
            }
          ]}
        />

        {/* ===== LOADING / ERROR ===== */}
        {loading && (
          <ZeroData
            primaryText={t("loading")}
            imageAltText="Loading"
            iconProps={{ iconName: "Spinner" }}
          />
        )}

        {error && (
          <ZeroData
            primaryText={t("error.title")}
            secondaryText={<span>{error}</span>}
            imageAltText="Error"
            iconProps={{ iconName: "Error" }}
          />
        )}

        {!loading && !error && files.length === 0 && (
          <ZeroData
            primaryText={t("empty")}
            imageAltText="No data"
            iconProps={{ iconName: "Info" }}
          />
        )}

        {/* ===== MAIN LAYOUT ===== */}
        {files.length > 0 && (
          <div className={`pr-md-preview__layout ${panelShown}`}>
            
            {/* ===== LEFT PANEL ===== */}
            {panelShown && (
              <aside className="pr-md-preview__left">
                <div className="pr-md-preview__left__header">
                  <ZeroData
                    primaryText={t("left.title")}
                    imageAltText="Title"
                    iconProps={{ iconName: "Documentation" }}
                  />
                </div>

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

            {/* ===== RIGHT PANEL ===== */}
            <main className="pr-md-preview__right">
              {selectedPath ? (
                <>
                  {/* HEADER */}
                  <div className="pr-md-preview__right__header">
                    {selectedPath} — {this.state.viewMode === "inline" ? t("view.inline") : t("view.split")}
                  </div>

                  {/* PREVIEW ZONE */}
                  <div className="preview-zone">
                    
                    <div className="preview-pane"
                        style={{ display: this.state.viewMode === "inline" ? "none" : "block" }}>
                      <div className="preview-header">{t("right.before")}</div>
                      <div
                        ref={this.previewRightRef}
                        className="preview-content md-typeset"
                        dangerouslySetInnerHTML={{ __html: this.state.previewRightHtml ?? "" }}
                      />
                    </div>
                    
                    <div className="preview-pane">
                      <div className="preview-header">{t("right.after")}</div>
                      <div
                        ref={this.previewLeftRef}
                        className="preview-content md-typeset"
                        dangerouslySetInnerHTML={{ __html: this.state.previewLeftHtml ?? "" }}
                      />
                    </div>

                  </div>

                  {/* DIFF ZONE */}
                  <div className="diff-zone">
                    <div
                      dangerouslySetInnerHTML={{ __html: diffHtml ?? "" }}
                    />
                  </div>

                </>
              ) : (
                <ZeroData
                  primaryText={t("select.prompt")}
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

const TranslatedPrMarkdownPreview = withTranslation('translation')(PrMarkdownPreview);
ReactDOM.render(<TranslatedPrMarkdownPreview />, document.getElementById("root"));