export type ActivityId = "files" | "search" | "git" | "agent" | "settings";

export interface OpenFile {
  id: string;
  name: string;
  path: string;
  language: string;
  content: string;
  dirty: boolean;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: TreeNode[];
  language?: string;
}
