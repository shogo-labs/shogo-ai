export interface WsNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: WsNode[];
  language?: string;
}

export interface WsFile {
  path: string;
  name: string;
  language: string;
  size: number;
  mtime: number;
  content: string;
}

export interface SearchMatch {
  line: number;
  col: number;
  preview: string;
}

export interface SearchFileResult {
  path: string;
  language: string;
  matches: SearchMatch[];
}

export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  limit?: number;
}

export interface SearchResponse {
  results: SearchFileResult[];
  truncated: boolean;
}

/**
 * File-level events broadcast by the backing workspace. Only the remote agent
 * workspace emits these (LocalFs does not — the user is the sole editor).
 * Emitted ONLY for writes/deletes performed by the agent runtime, so there is
 * no echo when the IDE itself saves. Paths are forward-slashed, relative to
 * the workspace root.
 */
export type WorkspaceFsEvent =
  | { type: "file.changed"; path: string; mtime: number }
  | { type: "file.deleted"; path: string };

export interface WorkspaceService {
  readonly id: string;
  readonly label: string;
  listTree(path?: string, depth?: number): Promise<WsNode[]>;
  readFile(path: string): Promise<WsFile>;
  writeFile(path: string, content: string): Promise<{ mtime: number; size: number }>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  search(query: string, opts?: SearchOptions): Promise<SearchResponse>;
  /**
   * Subscribe to live file-level edits performed by the backing agent.
   * Returns a disposer. Optional — not all backends support it.
   */
  subscribe?(onEvent: (event: WorkspaceFsEvent) => void): () => void;
}
