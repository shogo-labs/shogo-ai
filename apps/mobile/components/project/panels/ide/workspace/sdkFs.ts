/**
 * WorkspaceService backed by the @shogo-ai/sdk AgentClient.
 *
 * The IDE was originally written against a direct HTTP client (agentFs.ts in
 * the canvas prototype). In the mobile/web app we reach the per-project agent
 * runtime via the SDK instead — this module is the thin adapter.
 *
 * Things the SDK doesn't natively do that we emulate here:
 *  - rename  → readFile + writeFile + deleteFile
 *  - search  → client-side tree walk + regex (SDK's searchFiles is RAG,
 *              which doesn't return line:col coordinates the IDE expects)
 */

import { AgentClient, type FileNode, type WorkspaceEvent } from '@shogo-ai/sdk/agent'
import type {
  SearchOptions,
  SearchResponse,
  WorkspaceFsEvent,
  WorkspaceService,
  WsFile,
  WsNode,
} from './types'

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

const TEXT_EXTS = new Set(
  Object.keys(LANG_BY_EXT).concat(['.txt', '.log', '.gitignore', '.editorconfig']),
)

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
function isTextLikely(path: string): boolean {
  const ext = extOf(path)
  if (TEXT_EXTS.has(ext)) return true
  const name = (path.split('/').pop() ?? '').toLowerCase()
  return /^(dockerfile|makefile|readme|license|changelog)/i.test(name)
}

function toWsNode(fn: FileNode): WsNode {
  return fn.type === 'directory'
    ? { name: fn.name, path: fn.path, kind: 'dir', children: fn.children?.map(toWsNode) }
    : { name: fn.name, path: fn.path, kind: 'file', language: languageFor(fn.path) }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>


function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)) }

function is429(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b429\b/.test(msg) || /rate[_\s-]?limit/i.test(msg)
}

/**
 * Retry on 429 with exponential backoff + jitter. Caps at ~2.6s total wait
 * so a genuinely slow endpoint still fails fast, but a transient rate-limit
 * (e.g. while bursting reads from the file tree) self-heals without the user
 * seeing an error.
 */
async function retry429<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (err) {
      lastErr = err
      if (!is429(err) || i === attempts - 1) throw err
      const base = 250 * Math.pow(2, i) // 250, 500, 1000
      await sleep(base + Math.random() * 200)
    }
  }
  throw lastErr ?? new Error('retry429: exhausted')
}

export class SdkFs implements WorkspaceService {
  readonly id = 'agent'
  readonly label: string
  private client: AgentClient
  private readInFlight = new Map<string, Promise<WsFile>>()

  constructor(agentUrl: string, label = 'agent-workspace', fetchImpl?: FetchLike) {
    this.label = label
    this.client = new AgentClient({
      baseUrl: agentUrl,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
  }

  async listTree(): Promise<WsNode[]> {
    const tree = await retry429(() => this.client.getWorkspaceTree())
    return tree.map(toWsNode)
  }

  async readFile(path: string): Promise<WsFile> {
    const existing = this.readInFlight.get(path)
    if (existing) return existing
    const p = (async () => {
      try {
        const content = await retry429(() => this.client.readFile(path))
        return {
          path,
          name: path.split('/').pop() ?? path,
          language: languageFor(path),
          size: new Blob([content]).size,
          mtime: Date.now(),
          content,
        }
      } finally {
        this.readInFlight.delete(path)
      }
    })()
    this.readInFlight.set(path, p)
    return p
  }

  subscribe(onEvent: (event: WorkspaceFsEvent) => void): () => void {
    return this.client.subscribeToWorkspace(
      (evt: WorkspaceEvent) => {
        if (evt.type === 'file.changed' || evt.type === 'file.deleted') {
          onEvent(evt)
        }
      },
      {},
    )
  }

  async writeFile(path: string, content: string) {
    await retry429(() => this.client.writeFile(path, content))
    return { mtime: Date.now(), size: new Blob([content]).size }
  }

  async mkdir(path: string): Promise<void> {
    await this.client.mkdirWorkspace(path)
  }

  async remove(path: string): Promise<void> {
    await this.client.deleteFile(path)
  }

  /** Rename by copy + delete — the agent runtime has no native rename yet. */
  async rename(from: string, to: string): Promise<void> {
    const content = await this.client.readFile(from)
    await this.client.writeFile(to, content)
    await this.client.deleteFile(from)
  }

  /**
   * Project-wide text search. Walks the tree, reads each candidate file, and
   * runs a regex. Hard caps for safety. Swap for a server-side endpoint when
   * /agent/workspace/search gains line-level matching.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    if (!query) return { results: [], truncated: false }
    const limit = opts.limit ?? 200
    const MAX_FILES = 600
    const MAX_PER_FILE = 20

    let re: RegExp
    try {
      re = opts.regex
        ? new RegExp(query, opts.caseSensitive ? 'g' : 'gi')
        : new RegExp(
            query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            opts.caseSensitive ? 'g' : 'gi',
          )
    } catch {
      throw new Error('Invalid regex')
    }

    const tree = await this.client.getWorkspaceTree()
    const candidates: string[] = []
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (candidates.length >= MAX_FILES) return
        if (n.type === 'directory') walk(n.children ?? [])
        else if (isTextLikely(n.path)) candidates.push(n.path)
      }
    }
    walk(tree)
    let truncated = candidates.length >= MAX_FILES

    const results: SearchResponse['results'] = []
    let total = 0
    let idx = 0
    const CONC = 3

    const workers = Array.from({ length: CONC }, async () => {
      while (true) {
        if (total >= limit) { truncated = true; return }
        const i = idx++
        if (i >= candidates.length) return
        const path = candidates[i]
        let content: string
        try { content = await retry429(() => this.client.readFile(path)) } catch { continue }
        const lines = content.split('\n')
        const matches: SearchResponse['results'][number]['matches'] = []
        for (let ln = 0; ln < lines.length && matches.length < MAX_PER_FILE; ln++) {
          re.lastIndex = 0
          const m = re.exec(lines[ln])
          if (m) {
            matches.push({
              line: ln + 1,
              col: m.index + 1,
              preview: lines[ln].length > 240 ? lines[ln].slice(0, 240) : lines[ln],
            })
            total++
            if (total >= limit) break
          }
        }
        if (matches.length) results.push({ path, language: languageFor(path), matches })
      }
    })
    await Promise.all(workers)
    return { results, truncated }
  }
}

let cached: { url: string; fetchImpl: FetchLike | undefined; svc: SdkFs } | null = null

export function sdkFsFor(agentUrl: string, label?: string, fetchImpl?: FetchLike): SdkFs {
  if (cached && cached.url === agentUrl && cached.fetchImpl === fetchImpl) return cached.svc
  cached = { url: agentUrl, fetchImpl, svc: new SdkFs(agentUrl, label, fetchImpl) }
  return cached.svc
}
