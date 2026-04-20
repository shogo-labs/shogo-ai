import { Hono } from 'hono'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const app = new Hono()

// ---------------------------------------------------------------------------
// Filesystem API — Phase 2
// ---------------------------------------------------------------------------
// Exposes the agent workspace so the in-canvas IDE can read/write real files.
// Every path is jailed to WORKSPACE_ROOT and a deny-list of sensitive dirs.
// Mounted at /api/fs/*.
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = path.resolve(process.cwd(), '..', '..')

const DENY_DIRS = new Set([
  '.git',
  '.shogo',
  'node_modules',
  '.vite',
  'dist',
  '.next',
  '.turbo',
])

const DENY_FILES = new Set(['.env', '.env.local', '.env.production'])

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.mdx', '.txt', '.yml', '.yaml', '.toml',
  '.css', '.scss', '.html', '.svg', '.prisma',
  '.py', '.rs', '.go', '.java', '.rb', '.sh', '.env.example',
  '.gitignore', '.editorconfig', '.npmrc', '.prettierrc',
])

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown', '.mdx': 'markdown',
  '.css': 'css', '.scss': 'scss',
  '.html': 'html',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.toml': 'toml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.sh': 'shell',
  '.prisma': 'prisma',
  '.svg': 'xml',
}

function safeResolve(rel: string): string {
  const cleaned = (rel ?? '').replace(/^\/+/, '')
  const abs = path.resolve(WORKSPACE_ROOT, cleaned)
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error('Path escapes workspace root')
  }
  return abs
}

function isDenied(name: string, isDir: boolean): boolean {
  if (isDir) return DENY_DIRS.has(name)
  return DENY_FILES.has(name)
}

function langOf(name: string): string {
  const ext = path.extname(name).toLowerCase()
  return LANG_BY_EXT[ext] ?? 'plaintext'
}

function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase()
  if (!ext) return /^(Dockerfile|Makefile|README|LICENSE|CHANGELOG)/i.test(name)
  return TEXT_EXT.has(ext)
}

interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  children?: TreeNode[]
  language?: string
}

async function readTree(abs: string, rel: string, depth: number): Promise<TreeNode[]> {
  if (depth <= 0) return []
  let entries
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: TreeNode[] = []
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.env.example') continue
    const isDir = e.isDirectory()
    if (isDenied(e.name, isDir)) continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    const childAbs = path.join(abs, e.name)
    if (isDir) {
      nodes.push({
        name: e.name,
        path: childRel,
        kind: 'dir',
        children: await readTree(childAbs, childRel, depth - 1),
      })
    } else {
      nodes.push({
        name: e.name,
        path: childRel,
        kind: 'file',
        language: langOf(e.name),
      })
    }
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

app.get('/fs/tree', async (c) => {
  const relParam = c.req.query('path') ?? ''
  const depth = Math.min(parseInt(c.req.query('depth') ?? '4', 10) || 4, 8)
  try {
    const abs = safeResolve(relParam)
    const stat = await fs.stat(abs)
    if (!stat.isDirectory()) return c.json({ error: 'Not a directory' }, 400)
    const tree = await readTree(abs, relParam, depth)
    return c.json({ root: relParam || '/', tree })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 400)
  }
})

app.get('/fs/file', async (c) => {
  const rel = c.req.query('path') ?? ''
  if (!rel) return c.json({ error: 'path required' }, 400)
  try {
    const abs = safeResolve(rel)
    const name = path.basename(abs)
    if (isDenied(name, false)) return c.json({ error: 'Denied' }, 403)
    const stat = await fs.stat(abs)
    if (!stat.isFile()) return c.json({ error: 'Not a file' }, 400)
    if (stat.size > 2 * 1024 * 1024) {
      return c.json({ error: 'File too large (>2MB)' }, 413)
    }
    if (!isTextFile(name)) {
      return c.json({ error: 'Binary file not supported in this preview' }, 415)
    }
    const content = await fs.readFile(abs, 'utf8')
    return c.json({
      path: rel,
      name,
      language: langOf(name),
      size: stat.size,
      mtime: stat.mtimeMs,
      content,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 400)
  }
})

app.put('/fs/file', async (c) => {
  const body = await c.req.json().catch(() => null) as { path?: string; content?: string } | null
  if (!body?.path || typeof body.content !== 'string') {
    return c.json({ error: 'path and content required' }, 400)
  }
  try {
    const abs = safeResolve(body.path)
    const name = path.basename(abs)
    if (isDenied(name, false)) return c.json({ error: 'Denied' }, 403)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, body.content, 'utf8')
    const stat = await fs.stat(abs)
    return c.json({ ok: true, path: body.path, size: stat.size, mtime: stat.mtimeMs })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 400)
  }
})

app.post('/fs/mkdir', async (c) => {
  const body = await c.req.json().catch(() => null) as { path?: string } | null
  if (!body?.path) return c.json({ error: 'path required' }, 400)
  try {
    const abs = safeResolve(body.path)
    await fs.mkdir(abs, { recursive: true })
    return c.json({ ok: true, path: body.path })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 400)
  }
})

app.delete('/fs/entry', async (c) => {
  const rel = c.req.query('path') ?? ''
  if (!rel) return c.json({ error: 'path required' }, 400)
  try {
    const abs = safeResolve(rel)
    if (abs === WORKSPACE_ROOT) return c.json({ error: 'Cannot delete root' }, 400)
    const name = path.basename(abs)
    if (isDenied(name, true) || isDenied(name, false)) {
      return c.json({ error: 'Denied' }, 403)
    }
    await fs.rm(abs, { recursive: true, force: true })
    return c.json({ ok: true, path: rel })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 400)
  }
})

// ---------------------------------------------------------------------------
// /fs/search — project-wide text search across the agent workspace
// ---------------------------------------------------------------------------
// GET /fs/search?q=FOO&case=1&regex=0&limit=200
// Walks the workspace (respecting deny-list), scans text files, returns
// { results: [{ path, language, matches: [{ line, col, preview }] }], truncated }
async function walkWorkspace(rel: string, out: string[], maxFiles: number): Promise<void> {
  if (out.length >= maxFiles) return
  const abs = path.join(WORKSPACE_ROOT, rel)
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (out.length >= maxFiles) return
    if (ent.name.startsWith('.') && ent.name !== '.gitignore') continue
    const childRel = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      if (DENY_DIRS.has(ent.name)) continue
      await walkWorkspace(childRel, out, maxFiles)
    } else if (ent.isFile()) {
      if (DENY_FILES.has(ent.name)) continue
      const ext = path.extname(ent.name).toLowerCase()
      if (!TEXT_EXT.has(ext) && !/^(Dockerfile|Makefile|README|LICENSE|CHANGELOG)/i.test(ent.name)) continue
      out.push(childRel)
    }
  }
}

app.get('/fs/search', async (c) => {
  const q = c.req.query('q') ?? ''
  if (!q) return c.json({ results: [], truncated: false })
  const caseSensitive = c.req.query('case') === '1'
  const useRegex = c.req.query('regex') === '1'
  const limit = Math.min(500, parseInt(c.req.query('limit') ?? '200', 10) || 200)
  const MAX_FILES = 1500
  const MAX_MATCHES_PER_FILE = 20

  let re: RegExp
  try {
    re = useRegex
      ? new RegExp(q, caseSensitive ? 'g' : 'gi')
      : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi')
  } catch {
    return c.json({ error: 'Invalid regex' }, 400)
  }

  const files: string[] = []
  await walkWorkspace('', files, MAX_FILES)

  const results: Array<{
    path: string
    language: string
    matches: Array<{ line: number; col: number; preview: string }>
  }> = []
  let totalMatches = 0
  let truncated = files.length >= MAX_FILES

  for (const rel of files) {
    if (totalMatches >= limit) { truncated = true; break }
    const abs = path.join(WORKSPACE_ROOT, rel)
    let content: string
    try {
      const stat = await fs.stat(abs)
      if (stat.size > 2 * 1024 * 1024) continue
      content = await fs.readFile(abs, 'utf8')
    } catch { continue }
    const lines = content.split('\n')
    const matches: Array<{ line: number; col: number; preview: string }> = []
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_FILE; i++) {
      const line = lines[i]
      re.lastIndex = 0
      const m = re.exec(line)
      if (m) {
        matches.push({
          line: i + 1,
          col: m.index + 1,
          preview: line.length > 240 ? line.slice(0, 240) : line,
        })
        totalMatches++
        if (totalMatches >= limit) break
      }
    }
    if (matches.length > 0) {
      const ext = path.extname(rel).toLowerCase()
      results.push({ path: rel, language: LANG_BY_EXT[ext] ?? 'plaintext', matches })
    }
  }

  return c.json({ results, truncated })
})

app.post('/fs/rename', async (c) => {
  const body = await c.req.json().catch(() => null) as { from?: string; to?: string } | null
  if (!body?.from || !body?.to) return c.json({ error: 'from and to required' }, 400)
  try {
    const absFrom = safeResolve(body.from)
    const absTo = safeResolve(body.to)
    await fs.mkdir(path.dirname(absTo), { recursive: true })
    await fs.rename(absFrom, absTo)
    return c.json({ ok: true, from: body.from, to: body.to })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 400)
  }
})

export default app
