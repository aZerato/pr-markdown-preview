import "azure-devops-ui/Core/override.css";
import "./PrMarkdownPreview.scss";

import { Dialog } from "azure-devops-ui/Dialog";
import { Header } from "azure-devops-ui/Header";
import { Page } from "azure-devops-ui/Page";
import { Panel } from "azure-devops-ui/Panel";
import { ZeroData, ZeroDataActionType } from "azure-devops-ui/ZeroData";
import * as React from "react";
import * as ReactDOM from "react-dom";

import * as SDK from "azure-devops-extension-sdk";

import { AzureAPIHelper } from "./Services/AzureAPIHelper/AzureAPIHelper"
import { AzurePrConfig } from "./Services/AzureAPIHelper/Models/AzurePrConfig"
import { Change } from "./Services/AzureAPIHelper/Models/Change"

interface IPrMarkdownPreviewState {
  dialogShown: boolean;
  panelShown: boolean;
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