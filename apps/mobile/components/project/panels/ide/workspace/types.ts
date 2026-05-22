export interface WsNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: WsNode[];
  language?: string;
  /**
   * True on directories whose children were not walked by the backing
   * service (e.g. `node_modules` from the agent runtime). The IDE's
   * FileTree renders these as a regular directory row but defers fetching
   * children until the user expands it — see `Workbench.loadSubtree`.
   * Backends that walk the whole tree up-front (LocalFs) leave this unset.
   */
  lazy?: boolean;
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
   * Resolve a path to a URL that can be used by <img>, <video>, etc. Used for
   * previewing binary assets (images, pdfs) that can't round-trip through the
   * text-only readFile path. The returned URL may be a blob: URL (local) or
   * an http(s): URL pointing at the backing server (agent).
   *
   * Callers are responsible for revoking blob: URLs when done — each call
   * may allocate a fresh one. Optional: not all backends support it.
   */
  readFileUrl?(path: string): Promise<string>;
  /**
   * Subscribe to live file-level edits performed by the backing agent.
   * Returns a disposer. Optional — not all backends support it.
   */
  subscribe?(onEvent: (event: WorkspaceFsEvent) => void): () => void;
}
