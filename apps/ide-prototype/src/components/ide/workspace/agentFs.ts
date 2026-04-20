import type {
  SearchOptions,
  SearchResponse,
  WorkspaceService,
  WsFile,
  WsNode,
} from "./types";

const BASE = "";

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error ?? `${res.status} ${res.statusText}`);
  }
  return data;
}

export class AgentFs implements WorkspaceService {
  readonly id = "agent";
  readonly label = "agent-workspace";

  async listTree(path = "", depth = 4): Promise<WsNode[]> {
    const data = await jfetch<{ tree: WsNode[] }>(
      `${BASE}/api/fs/tree?path=${encodeURIComponent(path)}&depth=${depth}`,
    );
    return data.tree;
  }
  async readFile(path: string): Promise<WsFile> {
    return jfetch<WsFile>(`${BASE}/api/fs/file?path=${encodeURIComponent(path)}`);
  }
  async writeFile(path: string, content: string) {
    const data = await jfetch<{ mtime: number; size: number }>(`${BASE}/api/fs/file`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    });
    return { mtime: data.mtime, size: data.size };
  }
  async mkdir(path: string) {
    await jfetch(`${BASE}/api/fs/mkdir`, { method: "POST", body: JSON.stringify({ path }) });
  }
  async remove(path: string) {
    await jfetch(`${BASE}/api/fs/entry?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  }
  async rename(from: string, to: string) {
    await jfetch(`${BASE}/api/fs/rename`, {
      method: "POST",
      body: JSON.stringify({ from, to }),
    });
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const params = new URLSearchParams({
      q: query,
      case: opts.caseSensitive ? "1" : "0",
      regex: opts.regex ? "1" : "0",
      limit: String(opts.limit ?? 200),
    });
    return jfetch<SearchResponse>(`${BASE}/api/fs/search?${params}`);
  }
}

export const agentFs = new AgentFs();
