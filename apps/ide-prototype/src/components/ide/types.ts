import type { WsNode } from "./workspace/types";

export type ActivityId = "files" | "search" | "git" | "agent" | "settings";

export type TreeNode = WsNode;

export interface OpenFile {
  id: string;
  name: string;
  path: string;
  language: string;
  content: string;
  savedContent: string;
  dirty: boolean;
  pinned?: boolean;
  loading?: boolean;
  error?: string;
}

export interface EditorGroup {
  id: string;
  files: OpenFile[];
  activeId: string | null;
}
