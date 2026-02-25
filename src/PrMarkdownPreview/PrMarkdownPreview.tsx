import "azure-devops-ui/Core/override.css";
import "./PrMarkdownPreview.scss";

import * as SDK from "azure-devops-extension-sdk";
import { Dialog } from "azure-devops-ui/Dialog";
import { Header } from "azure-devops-ui/Header";
import { Page } from "azure-devops-ui/Page";
import { Panel } from "azure-devops-ui/Panel";
import { ZeroData, ZeroDataActionType } from "azure-devops-ui/ZeroData";
import * as React from "react";
import * as ReactDOM from "react-dom";

interface IPrMarkdownPreviewState {
  dialogShown: boolean;
  panelShown: boolean;
}

class AzureAPIHelper {
  organization!: string;
  project!: string;
  repositoryId!: string;

  public init(
    organization: string,
    project: string,
    repositoryId: string) 
  {
    this.organization = organization;
    this.project = project;
    this.repositoryId = repositoryId;
  }

  private async PrepareHeaders()
  {
    const token = await SDK.getAccessToken();
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    };

    return headers;
  }

  public async GetCommits(
    prId: string
  )
  {
    const u = new URL(`https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${this.repositoryId}/pullRequests/${prId}/commits`);
    u.searchParams.set("api-version", "7.1");

    const headers = await this.PrepareHeaders();

    const response = await fetch(u, { headers });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    const commits = 
      data.value.map(
        (commit: Commit) => commit);
    
    return commits;
  }

  public async GetFilesChanges(
    commitId: string
  )
  {
    const u = new URL(`https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${this.repositoryId}/commits/${commitId}/changes`);
    u.searchParams.set("api-version", "7.1");

    const headers = await this.PrepareHeaders();

    const response = await fetch(u, { headers });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    const changes = 
      data.changes.map(
        (change: Change) => change);
    
    return changes;
  }

  public async GetFileContent(
    filePath: string,
    commitId: string
  )
  {
    const u = new URL(`https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${this.repositoryId}/items`);
    u.searchParams.set("api-version", "7.1");
    u.searchParams.set("path", filePath);
    u.searchParams.set("versionDescriptor.version", commitId);
    u.searchParams.set("versionDescriptor.versionType", "commit");
    u.searchParams.set("includeContent", "true");

    const headers = await this.PrepareHeaders();

    const response = await fetch(u, { headers });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.text();
  }

  public async GetDiffs(
    baseCommit: string, 
    targetCommit: string)
  {
    const u = new URL(`https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${this.repositoryId}/diffs/commits`);
    u.searchParams.set("api-version", "7.1");
    u.searchParams.set("baseVersion", baseCommit);
    u.searchParams.set("baseVersionType", "commit");
    u.searchParams.set("targetVersion", targetCommit);
    u.searchParams.set("targetVersionType", "commit");

    const headers = await this.PrepareHeaders();

    const response = await fetch(u, { headers });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    
    const changedFiles = 
      data.changes.map(
        (change: { item: { path: any; }; }) => change.item.path);
    
    return changedFiles;
  }
}

class AzurePrConfig {
  project!: string;
  repositoryId!: string;
  prId!: string;
  mrgCommit!: string;
  srcCommit!: string;
  tgtCommit!: string;
  organization!: string;
}

class Commit {
  author!: AuthorInfo;
  comment!:string; 
  commitId!:string;
  committer!: AuthorInfo;
}

class Entry {

}

class Change {
  changeType!: string;
  item!: Item;
}

class Item {
  commitId!: string;
  gitObjectType!: string;
  objectId!: string;
  originalObjectId!: string;
  path!: string;
  url!: string;
  content!: string;
}

class AuthorInfo { 
  name!:string; 
  email!:string; 
  date!:string 
}

class PrMarkdownPreview extends React.Component<{}, IPrMarkdownPreviewState> {
  azureAPIHelper: AzureAPIHelper;
  azurePrConfig: AzurePrConfig;

  constructor(props: {}) {
    super(props);
    this.state = {
      dialogShown: false,
      panelShown: false
    };
    this.azureAPIHelper = new AzureAPIHelper();
    this.azurePrConfig = new AzurePrConfig();
  }

  public async componentDidMount() {
    await SDK.init();

    debugger;

    const pageCtx = SDK.getPageContext();
    this.azurePrConfig.project = pageCtx.webContext.project.name;

    const cfg = SDK.getConfiguration(); 

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
      this.azurePrConfig.repositoryId);

    let filesSrcChgs = await this.azureAPIHelper.GetFilesChanges(
      this.azurePrConfig.srcCommit);

    filesSrcChgs.forEach(async (change: Change) => {
      change.item.content = await this.azureAPIHelper.GetFileContent(
        change.item.path,
        change.item.commitId);
    });
      
    let filesTgtChgs = await this.azureAPIHelper.GetFilesChanges(
      this.azurePrConfig.tgtCommit);

    filesTgtChgs.forEach(async (change: Change) => {
      change.item.content = await this.azureAPIHelper.GetFileContent(
        change.item.path,
        change.item.commitId);
    });

    console.log(filesSrcChgs);
  }

  public render(): JSX.Element {
    return (
      <Page className="flex-grow">
        <Header
          title="Hello Hub!"
          commandBarItems={[
            {
              id: "panel-button",
              text: "Open Panel",
              iconProps: {
                iconName: "World"
              },
              onActivate: () => this.togglePanel()
            }
          ]}
        />
        <ZeroData
          iconProps={{ iconName: "World" }}
          imageAltText="World image"
          primaryText="Hot Reload and Debug!"
          secondaryText={
            <span>
              Check out the{" "}
              <a
                rel="nofollow noopener"
                target="_blank"
                href="https://github.com/microsoft/azure-devops-extension-pr-markdown-preview"
              >
                repo
              </a>{" "}
              to see how hot reload and debugging works.
            </span>
          }
          actionText="Open Dialog"
          actionType={ZeroDataActionType.ctaButton}
          onActionClick={() => this.toggleDialog()}
        />
        {this.state.dialogShown && (
          <Dialog
            className="flex-wrap"
            titleProps={{ text: "Hello Dialog!" }}
            onDismiss={() => this.toggleDialog()}
            footerButtonProps={[
              {
                text: "Close",
                primary: true,
                onClick: () => this.toggleDialog()
              }
            ]}
          >
            <ZeroData
              iconProps={{ iconName: "World" }}
              imageAltText="World image"
            />
          </Dialog>
        )}
        {this.state.panelShown && (
          <Panel
            titleProps={{ text: "Hello Panel!" }}
            onDismiss={() => this.togglePanel()}
            footerButtonProps={[
              {
                text: "Close",
                primary: true,
                onClick: () => this.togglePanel()
              }
            ]}
          >
            <ZeroData
              iconProps={{ iconName: "World" }}
              imageAltText="World image"
              className="flex-grow"
            />
          </Panel>
        )}
      </Page>
    );
  }

  private toggleDialog(): void {
    this.setState({ dialogShown: !this.state.dialogShown });
  }

  private togglePanel(): void {
    this.setState({ panelShown: !this.state.panelShown });
  }
}

ReactDOM.render(<PrMarkdownPreview />, document.getElementById("root"));
