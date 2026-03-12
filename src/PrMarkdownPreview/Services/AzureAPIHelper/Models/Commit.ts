import { AuthorInfo } from "./AuthorInfo";

export class Commit {
  author!: AuthorInfo;
  comment!:string; 
  commitId!:string;
  committer!: AuthorInfo;
}