export class MdFileItem {
  path!: string;
  srcCommitId?: string;
  tgtCommitId?: string;
  srcContent?: string;
  tgtContent?: string;
  status?: string;
}