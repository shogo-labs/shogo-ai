import type {
  SearchOptions,
  SearchResponse,
  WorkspaceService,
  WsFile,
  WsNode,
} from "./types";

import { API_BASE as BASE } from "./apiBase";
import { proposalStore } from "./proposalStore";

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(
      (data as { error?: string })?.error ?? `${res.status} ${res.statusText}`,
    );
  }
  return data;
}

export class AgentFs implements WorkspaceService {
  readonly id = "agent";
  readonly label = "agent-workspace";

  async listTree(path = "", depth = 4): Promise<WsNode[]> {
    const url = `${BASE}/api/fs/tree?path=${encodeURIComponent(path)}&depth=${depth}`;
    const data = await jfetch<{ tree: WsNode[] }>(url);
    return data.tree;
  }

  async readFile(path: string): Promise<WsFile> {
    const url = `${BASE}/api/fs/file?path=${encodeURIComponent(path)}`;
    return jfetch<WsFile>(url);
  }

  async writeFile(
    path: string,
    content: string,
    opts?: { review?: boolean },
  ) {
    // Default: route through the proposal store so agent edits get reviewed
    // before they hit disk. Pass `{ review: false }` to bypass (e.g. user
    // saves from the editor, or the proposal store committing an accepted
    // hunk).
    if (opts?.review !== false) {
      await proposalStore.propose({
        rootId: this.id,
        path,
        after: content,
        source: "agent",
      });
      // No mtime/size yet — nothing has been written.
      return { mtime: Date.now(), size: content.length };
    }

    const data = await jfetch<{ mtime: number; size: number }>(
      `${BASE}/api/fs/file`,
      {
        method: "PUT",
        body: JSON.stringify({ path, content }),
      },
    );
    return { mtime: data.mtime, size: data.size };
  }

  async mkdir(path: string) {
    await jfetch(`${BASE}/api/fs/mkdir`, {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  async remove(path: string) {
    await jfetch(`${BASE}/api/fs/entry?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
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
