import "azure-devops-ui/Core/override.css";
import "./PrMarkdownPreview.scss";

import { Header } from "azure-devops-ui/Header";
import { Page } from "azure-devops-ui/Page";
import { ZeroData } from "azure-devops-ui/ZeroData";
import * as React from "react";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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

import "../i18n/i18n";
import { useTranslation } from "react-i18next";
import { Change } from "./Services/AzureAPIHelper/Models/Change";

// --- Configuration ---
const SANITIZE_CONFIG = {
    ALLOWED_TAGS: [
        'b', 'i', 'em', 'strong', 'a', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 
        'span', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 
        'ul', 'ol', 'li', 'blockquote', 'div', 'img'
    ],
    ALLOWED_ATTR: ['href', 'target', 'class', 'title', 'src', 'alt']
};

const BLOCKS_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,th,td";
const SAME_TAG_THRESHOLD = 0.50;
const DIFF_TAG_THRESHOLD = 0.72;

const PrMarkdownPreview: React.FC = () => {
    const { t } = useTranslation('translation');

    // --- State ---
    const [panelShown, setPanelShown] = useState(true);
    const [files, setFiles] = useState<MdFileItem[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | undefined>();
    const [previewLeftHtml, setPreviewLeftHtml] = useState("");
    const [previewRightHtml, setPreviewRightHtml] = useState("");
    const [diffHtml, setDiffHtml] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | undefined>();
    const [viewMode, setViewMode] = useState<"inline" | "split">("split");

    // --- Refs ---
    const leftPaneRef = useRef<HTMLDivElement>(null);
    const rightPaneRef = useRef<HTMLDivElement>(null);
    const previewLeftRef = useRef<HTMLDivElement>(null);
    const previewRightRef = useRef<HTMLDivElement>(null);

    const azureAPIHelper = useMemo(() => new AzureAPIHelper(), []);
    const azurePrConfig = useMemo(() => new AzurePrConfig(), []);

    // --- Utilities ---
    const similarityTokens = (aTokens: string[], bTokens: string[]) => {
        if (!aTokens.length && !bTokens.length) return 1;
        const aSet = new Set(aTokens);
        const bSet = new Set(bTokens);
        let inter = 0;
        for (const t of aSet) if (bSet.has(t)) inter++;
        return (2 * inter) / (aSet.size + bSet.size || 1);
    };

    const isSimpleTextBlock = (el: HTMLElement) => {
        const tag = el.tagName.toLowerCase();
        const complexTags = ["ul", "ol", "table", "thead", "tbody", "tr", "pre", "code"];
        if (complexTags.indexOf(tag) !== -1) return false;
        return !Array.from(el.children).some(c => complexTags.indexOf(c.tagName.toLowerCase()) !== -1 || c.tagName.toLowerCase() === "img");
    };

    const applyWordDiffToSimplePair = useCallback((L: HTMLElement, R: HTMLElement) => {
        const isInline = viewMode === "inline";
        const oldText = R.textContent || "";
        const newText = L.textContent || "";
        const parts = Diff.diffWordsWithSpace(oldText, newText);

        let htmlLeft = "";
        let htmlRight = "";

        for (const part of parts) {
            const v = part.value;
            const escapedV = escapeHtml(v);
            if (part.added) {
                htmlLeft += `<span class="${isInline ? 'gh-add' : 'mkdiff-w-add'}" title="Added">${escapedV}</span>`;
            } else if (part.removed) {
                if (isInline) htmlLeft += `<span class="gh-del" title="Removed: ${escapedV}">${escapedV}</span>`;
                else htmlRight += `<span class="mkdiff-w-del">${escapedV}</span>`;
            } else {
                htmlLeft += escapedV;
                htmlRight += escapedV;
            }
        }

        L.innerHTML = htmlLeft;
        L.classList.add(isInline ? "gh-line-modified" : "mkdiff-line-modified");
        if (!isInline) {
            R.innerHTML = htmlRight;
            R.classList.add("mkdiff-line-modified");
        }
    }, [viewMode]);

    const applyDiffToPreviews = useCallback(() => {
        const leftRoot = previewLeftRef.current;
        const rightRoot = previewRightRef.current;
        if (!leftRoot || !rightRoot) return;

        const isInline = viewMode === "inline";
        const getBlocks = (root: HTMLElement) => Array.from(root.querySelectorAll(BLOCKS_SELECTOR)) as HTMLElement[];
        const leftNodes = getBlocks(leftRoot);
        const rightNodes = getBlocks(rightRoot);

        const tokenize = (s: string) => (s.toLowerCase().match(/\w+/g) || []).filter(w => w.length >= 2);

        // Clean
        [leftRoot, rightRoot].forEach(root => {
            root.querySelectorAll("[class*='mkdiff'], [class*='gh-']").forEach(el => {
                el.classList.remove("mkdiff-line-added", "mkdiff-line-removed", "mkdiff-line-modified", "gh-line-modified", "gh-block-modified");
            });
        });

        const leftMeta = leftNodes.map(n => ({ node: n, tag: n.tagName.toLowerCase(), tokens: tokenize(n.textContent || ""), sig: `${n.tagName.toLowerCase()}|${(n.textContent || "").replace(/\s+/g, " ").trim()}` }));
        const rightMeta = rightNodes.map(n => ({ node: n, tag: n.tagName.toLowerCase(), tokens: tokenize(n.textContent || ""), sig: `${n.tagName.toLowerCase()}|${(n.textContent || "").replace(/\s+/g, " ").trim()}` }));

        const chunks = Diff.diffArrays(rightMeta.map(m => m.sig), leftMeta.map(m => m.sig));

        let iR = 0, iL = 0;
        chunks.forEach((c, idx) => {
            if (!c.added && !c.removed) { iR += c.value.length; iL += c.value.length; return; }
            if (c.removed && chunks[idx + 1]?.added) {
                const remIdxs = Array.from({ length: c.value.length }, (_, k) => iR + k);
                const addIdxs = Array.from({ length: chunks[idx + 1].value.length }, (_, k) => iL + k);
                const takenR = new Set();
                const takenL = new Set();

                for (const li of addIdxs) {
                    let best = { score: -1, ri: -1 };
                    for (const ri of remIdxs) {
                        if (takenR.has(ri)) continue;
                        const score = similarityTokens(leftMeta[li].tokens, rightMeta[ri].tokens);
                        const pass = leftMeta[li].tag === rightMeta[ri].tag ? score >= SAME_TAG_THRESHOLD : score >= DIFF_TAG_THRESHOLD;
                        if (pass && score > best.score) best = { score, ri };
                    }
                    if (best.ri !== -1) {
                        takenL.add(li); takenR.add(best.ri);
                        if (isSimpleTextBlock(leftMeta[li].node) && isSimpleTextBlock(rightMeta[best.ri].node)) applyWordDiffToSimplePair(leftMeta[li].node, rightMeta[best.ri].node);
                        else leftMeta[li].node.classList.add("gh-block-modified");
                    }
                }
                addIdxs.forEach(li => !takenL.has(li) && leftMeta[li].node.classList.add("mkdiff-line-added"));
                if (!isInline) remIdxs.forEach(ri => !takenR.has(ri) && rightMeta[ri].node.classList.add("mkdiff-line-removed"));
            } else if (c.added) {
                for (let t = 0; t < c.value.length; t++) leftMeta[iL + t]?.node.classList.add("mkdiff-line-added");
            } else if (c.removed && !isInline) {
                for (let t = 0; t < c.value.length; t++) rightMeta[iR + t]?.node.classList.add("mkdiff-line-removed");
            }
            if (c.added) iL += c.value.length; else if (c.removed) iR += c.value.length;
        });
    }, [viewMode, applyWordDiffToSimplePair]);
    const escapeHtml = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // --- Core Logic: Diff Computation ---
    const computeAndSetDiff = useCallback(async (path: string, currentFiles?: MdFileItem[]) => {
        const list = currentFiles || files;
        const item = list.find(f => f.path === path);
        if (!item) return;

        setLoading(true);
        try {
            const leftRaw = await marked.parse(item.srcContent ?? "");
            const rightRaw = await marked.parse(item.tgtContent ?? "");
            
            const patch = Diff.createTwoFilesPatch("old.md", "new.md", item.tgtContent ?? "", item.srcContent ?? "", "", "", { context: 3 });
            const dHtmlRaw = Diff2Html.html(patch, { drawFileList: false, matching: "lines", outputFormat: viewMode === "split" ? "side-by-side" : "line-by-line" });

            setPreviewLeftHtml(DOMPurify.sanitize(leftRaw, SANITIZE_CONFIG));
            setPreviewRightHtml(DOMPurify.sanitize(rightRaw, SANITIZE_CONFIG));
            setDiffHtml(DOMPurify.sanitize(dHtmlRaw, SANITIZE_CONFIG));
            setSelectedPath(path);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    }, [files, viewMode])

    // --- Lifecycle: Data Loading ---
    useEffect(() => {
        const initData = async () => 
        {
            if (!loading) return;

            try 
            {
                await SDK.init();
                const pageCtx = SDK.getPageContext();
                
                azurePrConfig.project = pageCtx.webContext.project.name;
                const cfg: any = SDK.getConfiguration();
                azurePrConfig.repositoryId = cfg.repositoryId;
                const pr = cfg.pullRequest;
                azurePrConfig.prId = pr.pullRequestId;
                azurePrConfig.srcCommit = pr.lastMergeSourceCommitId;
                azurePrConfig.tgtCommit = pr.lastMergeTargetCommitId;
                azurePrConfig.organization = SDK.getHost().name;

                azureAPIHelper.init(
                    azurePrConfig.organization,
                    azurePrConfig.project,
                    azurePrConfig.repositoryId
                );

                const baseCommitId = azurePrConfig.tgtCommit!;
                const headCommitId = azurePrConfig.srcCommit!;

                // 1. Get changes for all commits in the PR
                const prCommitIds: string[] = (pr?.commits ?? []).map((c: any) => c.commitId);
                const orderedCommitIds = [...prCommitIds].reverse();
                const perCommitChanges: Change[][] = await Promise.all(
                    orderedCommitIds.map((cid) => azureAPIHelper.GetFilesChanges(cid))
                );

                // 2. Rename detection
                const oldToNew = new Map<string, string>();
                const newToOld = new Map<string, string>();
                const flagsByPath = new Map<string, Map<string, string>>();
                const byPath = new Map<string, MdFileItem>();

                const splitFlags = (ct?: string) => (ct ?? "").toLowerCase().split(/[,\s]+/).filter(Boolean);
                
                // Pass 1 : Rename detection
                for (const commitChanges of perCommitChanges) {
                    for (const chg of commitChanges) {
                        const tokens = splitFlags(chg.changeType);
                        const anyChg = chg as any;
                        if (tokens.indexOf("rename") !== -1 && anyChg?.sourceServerItem && chg.item?.path) {
                            oldToNew.set(anyChg.sourceServerItem, chg.item.path);
                            newToOld.set(chg.item.path, anyChg.sourceServerItem);
                        }
                    }
                }

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

                // Pass 2 : Build final list of changed files with flags
                for (const commitChanges of perCommitChanges) {
                    for (const chg of commitChanges) {
                        const p = chg?.item?.path;
                        if (!p || !/\.(md|markdown)$/i.test(p)) continue;
                        if (splitFlags(chg.changeType).indexOf("sourcerename") !== -1) continue;

                        const finalPath = resolveFinalPath(p);
                        if (!byPath.has(finalPath)) {
                            byPath.set(finalPath, {
                                path: finalPath,
                                srcCommitId: headCommitId,
                                tgtCommitId: baseCommitId
                            } as MdFileItem);
                        }

                        // Gestion des flags
                        const m = flagsByPath.get(finalPath) ?? new Map<string, string>();
                        splitFlags(chg.changeType).forEach(t => m.set(t, t));
                        flagsByPath.set(finalPath, m);
                    }
                }

                const items = Array.from(byPath.values());

                // 3. Load content for all files (with parallel calls)
                await Promise.all(items.map(async (it) => {
                    const baseLookupPath = resolveBasePathForNew(it.path);
                    try {
                        it.tgtContent = await azureAPIHelper.GetFileContent(baseLookupPath, baseCommitId);
                    } catch { it.tgtContent = ""; }
                    try {
                        it.srcContent = await azureAPIHelper.GetFileContent(it.path, headCommitId);
                    } catch { it.srcContent = ""; }
                    
                    const flags = flagsByPath.get(it.path);
                    it.status = flags ? Array.from(flags.values()).join(", ") : "";
                }));

                const sortedItems = items.sort((a, b) => a.path.localeCompare(b.path));
                
                // --- Update final state ---
                setFiles(sortedItems);
                if (sortedItems.length > 0) {
                    await computeAndSetDiff(sortedItems[0].path, sortedItems);
                } else {
                    setLoading(false);
                }
            } catch (e: any) {
                setError(e.message);
                setLoading(false);
            }
        };
        initData();
    }, []); // Run once

    useEffect(() => {
    if (selectedPath && (previewLeftHtml || previewRightHtml)) {
        // We use requestAnimationFrame to ensure the DOM is actually rendered 
        // by dangerouslySetInnerHTML before we try to modify its classes
        requestAnimationFrame(() => {
            applyDiffToPreviews();
        });
        }
    }, [previewLeftHtml, previewRightHtml, viewMode, selectedPath, applyDiffToPreviews]);

    // --- Scroll Sync Effect ---
    useEffect(() => {
        const left = leftPaneRef.current;
        const right = rightPaneRef.current;
        if (!left || !right || viewMode !== "split") return;

        const handleScroll = (from: HTMLElement, to: HTMLElement) => {
            const ratio = from.scrollTop / (from.scrollHeight - from.clientHeight || 1);
            to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
        };

        const onLeft = () => handleScroll(left, right);
        const onRight = () => handleScroll(right, left);

        left.addEventListener("scroll", onLeft);
        right.addEventListener("scroll", onRight);
        return () => {
            left.removeEventListener("scroll", onLeft);
            right.removeEventListener("scroll", onRight);
        };
    }, [viewMode, selectedPath]);

    // --- Render ---
    return (
        <Page className="flex-grow">
            <Header
                title={t("app.title")}
                commandBarItems={[
                    { id: "panel", text: panelShown ? t("view.closepanel") : t("view.openpanel"), iconProps: { iconName: "ClosePane" }, onActivate: () => setPanelShown(!panelShown) },
                    { id: "inline", text: t("view.inline"), iconProps: { iconName: viewMode === "inline" ? "CheckMark" : "Compare" }, onActivate: () => setViewMode("inline") },
                    { id: "split", text: t("view.split"), iconProps: { iconName: viewMode === "split" ? "CheckMark" : "SideBySide" }, onActivate: () => setViewMode("split") }
                ]}
            />
            {loading && <ZeroData primaryText={t("loading")} imageAltText="Loading" iconProps={{ iconName: "Spinner" }} />}
            {error && <ZeroData primaryText={t("error.title")} secondaryText={<span>{error}</span>} imageAltText="Error" iconProps={{ iconName: "Error" }} />}
            {!loading && !error && files.length > 0 && (
                <div className={`pr-md-preview__layout ${panelShown ? "panel-open" : ""}`}>
                    {panelShown && (
                        <aside className="pr-md-preview__left">
                            <ul className="pr-md-preview__filelist">
                                {files.map(f => (
                                    <li key={f.path} className={`pr-md-preview__fileitem ${f.path === selectedPath ? "is-selected" : ""}`} onClick={() => computeAndSetDiff(f.path)}>
                                        {f.status && (
                                          <span className={`status-badge status-${f.status.toLowerCase().split(',')[0].trim()}`}>
                                              {f.status.split(',')[0].trim()}
                                          </span>
                                        )}
                                        <span className="path">{f.path}</span>
                                    </li>
                                ))}
                            </ul>
                        </aside>
                    )}
                    <main className="pr-md-preview__right">
                        <div className="preview-zone">
                            {viewMode === "split" && (
                                <div className="preview-pane" ref={rightPaneRef}>
                                    <div className="preview-header">{t("right.before")}</div>
                                    <div ref={previewRightRef} className="preview-content md-typeset" dangerouslySetInnerHTML={{ __html: previewRightHtml }} />
                                </div>
                            )}
                            <div className="preview-pane" ref={leftPaneRef}>
                                <div className="preview-header">{t("right.after")}</div>
                                <div ref={previewLeftRef} className="preview-content md-typeset" dangerouslySetInnerHTML={{ __html: previewLeftHtml }} />
                            </div>
                        </div>
                        <div className="diff-zone" dangerouslySetInnerHTML={{ __html: diffHtml }} />
                    </main>
                </div>
            )}
        </Page>
    );
};

ReactDOM.render(<PrMarkdownPreview />, document.getElementById("root"));