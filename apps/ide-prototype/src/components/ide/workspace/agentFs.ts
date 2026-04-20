import type { WorkspaceService, WsFile, WsNode } from "./types";

const BASE = "";

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

  async writeFile(path: string, content: string) {
    const data = await jfetch<{ mtime: number; size: number }>(
      `${BASE}/api/fs/file`,
      { method: "PUT", body: JSON.stringify({ path, content }) },
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
}

export const agentFs = new AgentFs();
