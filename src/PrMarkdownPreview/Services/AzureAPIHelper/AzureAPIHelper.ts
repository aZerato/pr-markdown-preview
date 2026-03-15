import * as SDK from "azure-devops-extension-sdk";

import { Change } from "./Models/Change";

export class AzureAPIHelper {
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

  public async GetFilesChanges(
    commitId: string
  ) : Promise<Change[]>
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
  ) : Promise<string>
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
}