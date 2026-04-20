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

export interface WorkspaceService {
  readonly id: string;
  readonly label: string;
  listTree(path?: string, depth?: number): Promise<WsNode[]>;
  readFile(path: string): Promise<WsFile>;
  writeFile(path: string, content: string): Promise<{ mtime: number; size: number }>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
