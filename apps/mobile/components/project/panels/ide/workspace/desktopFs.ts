/**
 * WorkspaceService backed by the Electron preload `shogoDesktop.fs.*` IPC
 * bridge for reads, and a wrapped `SdkFs` for everything else.
 *
 * Why two backends in one service:
 *   The desktop runs the agent-runtime as a sibling process on the same
 *   machine, so reading the workspace via loopback HTTP is pure overhead
 *   for the listing + read paths the IDE hits constantly (tree open, Cmd-P
 *   navigation, opening a file in Monaco). At the same time, we DO want
 *   mutations to flow through agent-runtime so its file watcher + RAG
 *   indexer pick them up — see `canvas-file-watcher.ts`. Subscribing to
 *   live `file.changed` events also has to stay on the SSE path because
 *   the events themselves originate inside agent-runtime.
 *
 *   So:
 *     - `listTree`, `readFile`, `readFileUrl` → IPC fast-path (no HTTP)
 *     - `writeFile`, `mkdir`, `remove`, `rename`, `subscribe`, `search`
 *       → delegate to a wrapped `SdkFs`
 *
 *   `search` could be done over IPC too, but its current `SdkFs`
 *   implementation already reuses `getWorkspaceTree` (which is now fast)
 *   plus per-file `readFile` calls. To keep the diff small for the
 *   phase-2 MVP we keep `search` on the HTTP path. A follow-up can swap
 *   it to IPC for an additional latency win.
 *
 * Path validation lives in main (`apps/desktop/src/fs-ipc.ts`). This file
 * does NOT re-validate — it trusts the bridge and surfaces whatever error
 * main returns. The bridge itself rejects any root that isn't a direct
 * child of the local workspaces dir.
 */

import type { FileNode } from '@shogo-ai/sdk/agent'
import { SdkFs } from './sdkFs'
import type {
  SearchOptions,
  SearchResponse,
  WorkspaceFsEvent,
  WorkspaceService,
  WsFile,
  WsNode,
} from './types'

// The `shogoDesktop.fs.*` surface exposed by `apps/desktop/src/preload.ts`.
// Replicated here as a structural type so this file has no runtime dep on
// the desktop bundle (and so the web build doesn't try to import Electron).
export interface DesktopFsBridge {
  resolveWorkspace(projectId: string): Promise<{
    ok: boolean
    root?: string
    reason?: 'not-managed' | 'not-found' | 'invalid-input'
  }>
  listTree(root: string, path?: string): Promise<{
    ok: boolean
    tree?: Array<{
      name: string
      path: string
      type: 'file' | 'directory'
      modified?: number
      size?: number
      children?: unknown
      lazy?: boolean
    }>
    error?: string
  }>
  readFile(root: string, relPath: string): Promise<{
    ok: boolean
    content?: string
    size?: number
    mtime?: number
    error?: string
  }>
}

/**
 * Returns the IPC bridge if running inside an Electron renderer with a new
 * enough preload, otherwise null. Callers must fall back to `SdkFs` when
 * this returns null.
 */
export function getDesktopFsBridge(): DesktopFsBridge | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { shogoDesktop?: { fs?: DesktopFsBridge } }
  const fs = w.shogoDesktop?.fs
  if (!fs) return null
  if (
    typeof fs.resolveWorkspace !== 'function' ||
    typeof fs.listTree !== 'function' ||
    typeof fs.readFile !== 'function'
  ) {
    return null
  }
  return fs
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.md': 'markdown', '.mdx': 'markdown',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'html', '.htm': 'html',
  '.xml': 'xml', '.svg': 'xml',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.ini': 'ini',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.php': 'php', '.sql': 'sql',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.prisma': 'prisma', '.env': 'plaintext',
  '.dockerfile': 'dockerfile',
  '.lock': 'yaml',
}

function extOf(p: string): string {
  const base = p.split('/').pop() ?? p
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}
function languageFor(path: string): string {
  const ext = extOf(path)
  if (ext) return LANG_BY_EXT[ext] ?? 'plaintext'
  const name = path.split('/').pop() ?? ''
  if (/^dockerfile/i.test(name)) return 'dockerfile'
  if (/^makefile/i.test(name)) return 'makefile'
  return 'plaintext'
}

function toWsNode(fn: NonNullable<Awaited<ReturnType<DesktopFsBridge['listTree']>>['tree']>[number]): WsNode {
  if (fn.type !== 'directory') {
    return { name: fn.name, path: fn.path, kind: 'file', language: languageFor(fn.path) }
  }
  const dir: WsNode = { name: fn.name, path: fn.path, kind: 'dir' }
  if (fn.lazy) {
    dir.lazy = true
  } else if (Array.isArray(fn.children)) {
    dir.children = (fn.children as typeof fn[]).map(toWsNode)
  } else {
    dir.children = []
  }
  return dir
}

export class DesktopFs implements WorkspaceService {
  readonly id = 'desktop-agent'
  readonly label: string
  private readonly bridge: DesktopFsBridge
  private readonly root: string
  private readonly sdkFs: SdkFs
  private readInFlight = new Map<string, Promise<WsFile>>()

  constructor(bridge: DesktopFsBridge, root: string, sdkFs: SdkFs, label: string) {
    this.bridge = bridge
    this.root = root
    this.sdkFs = sdkFs
    this.label = label
  }

  // ───── Read-path: IPC ────────────────────────────────────────────────────

  async listTree(path?: string): Promise<WsNode[]> {
    const res = await this.bridge.listTree(this.root, path)
    if (!res.ok) {
      // Fall back to HTTP on any bridge error rather than wedging the
      // tree. The most likely cause is a transient race against the
      // workspace directory being created — SdkFs will hit the same
      // backing store via agent-runtime and either succeed or surface a
      // proper error to the FileTree's error UI.
      return this.sdkFs.listTree(path)
    }
    return (res.tree ?? []).map(toWsNode)
  }

  async readFile(path: string): Promise<WsFile> {
    const existing = this.readInFlight.get(path)
    if (existing) return existing
    const p = (async () => {
      try {
        const res = await this.bridge.readFile(this.root, path)
        if (!res.ok || res.content == null) {
          // Oversized files, binary files, or a missing-after-listing race —
          // delegate to SdkFs which streams + handles the error UX.
          return this.sdkFs.readFile(path)
        }
        return {
          path,
          name: path.split('/').pop() ?? path,
          language: languageFor(path),
          size: res.size ?? new Blob([res.content]).size,
          mtime: res.mtime ?? Date.now(),
          content: res.content,
        }
      } finally {
        this.readInFlight.delete(path)
      }
    })()
    this.readInFlight.set(path, p)
    return p
  }

  /**
   * Binary asset previews (`<img src=…>` etc.) still go through SdkFs —
   * `fs.readFile` returns UTF-8 strings, not blobs, and we'd need a
   * separate IPC channel that ships an ArrayBuffer to make this fast.
   * Punting until someone actually feels the latency on previews.
   */
  readFileUrl(path: string): Promise<string> {
    return this.sdkFs.readFileUrl(path)
  }

  // ───── Write-path / live updates: delegate to SdkFs ──────────────────────
  // These all go through agent-runtime so its file watcher + RAG indexer
  // see the mutation and re-index. Bypassing them would leave the indexer
  // stale and break agent-side file search.

  writeFile(path: string, content: string): Promise<{ mtime: number; size: number }> {
    return this.sdkFs.writeFile(path, content)
  }

  mkdir(path: string): Promise<void> {
    return this.sdkFs.mkdir(path)
  }

  remove(path: string): Promise<void> {
    return this.sdkFs.remove(path)
  }

  rename(from: string, to: string): Promise<void> {
    return this.sdkFs.rename(from, to)
  }

  subscribe(onEvent: (event: WorkspaceFsEvent) => void): () => void {
    return this.sdkFs.subscribe(onEvent)
  }

  /**
   * Search currently delegates to SdkFs (which itself uses
   * `getWorkspaceTree` + per-file reads). Once the agent-runtime exposes a
   * proper line-level search endpoint this can move to IPC for the same
   * latency win as the tree.
   */
  search(query: string, opts?: SearchOptions): Promise<SearchResponse> {
    return this.sdkFs.search(query, opts)
  }
}

/** Avoid materialising `FileNode` from the SDK — DesktopFs already returns
 *  the wire shape via the bridge. Exported only so other modules can pin to
 *  the same shape if they want to peek inside the IPC response. */
export type { FileNode }
