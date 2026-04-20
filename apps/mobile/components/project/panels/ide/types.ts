import type { WsNode } from "./workspace/types";

export type ActivityId = "files" | "search" | "git" | "settings";

/** A tree node annotated with the root it belongs to. */
export interface TreeNode extends WsNode {
  rootId: string;
  isRoot?: boolean;
  children?: TreeNode[];
}

/** Raw service node helper — we decorate this with rootId when ingesting. */
export type RawNode = WsNode;

export interface OpenFile {
  id: string;           // `${rootId}::${path}` — globally unique
  rootId: string;
  name: string;
  path: string;         // relative to root
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

export interface EditorSettings {
  fontSize: number;       // 11..20
  tabSize: number;        // 2 | 4
  wordWrap: "on" | "off";
  minimap: boolean;
  lineNumbers: "on" | "off" | "relative";
  renderWhitespace: "none" | "boundary" | "all";
  bracketPairs: boolean;
  formatOnSave: boolean;
}

export const DEFAULT_SETTINGS: EditorSettings = {
  fontSize: 13,
  tabSize: 2,
  wordWrap: "off",
  minimap: true,
  lineNumbers: "on",
  renderWhitespace: "none",
  bracketPairs: true,
  formatOnSave: false,
};

export interface Root {
  id: string;                             // "agent" | `local:${uuid}`
  label: string;
  kind: "agent" | "local";
  tree: TreeNode[];
  loading: boolean;
  error: string | null;
}
