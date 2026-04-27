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
}
