import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

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

// ---------------------------------------------------------------------------
// Git API — Phase 7
// ---------------------------------------------------------------------------
// Thin wrapper around the system `git` binary, scoped to WORKSPACE_ROOT.
// All routes run `git -C WORKSPACE_ROOT ...` and return stdout/stderr.
// ---------------------------------------------------------------------------

function runGit(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = nodeSpawn('git', args, { cwd: WORKSPACE_ROOT })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }))
    if (input !== undefined) {
      proc.stdin.write(input)
      proc.stdin.end()
    }
  })
}

app.get('/git/status', async (c) => {
  const { code, stdout, stderr } = await runGit(['status', '--porcelain=v1', '-b', '--untracked-files=all'])
  if (code !== 0) return c.json({ error: stderr || 'git failed' }, 400)

  const lines = stdout.split('\n').filter(Boolean)
  let branch = 'HEAD'
  let ahead = 0
  let behind = 0
  const staged: Array<{ path: string; status: string }> = []
  const unstaged: Array<{ path: string; status: string }> = []
  const untracked: string[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const m = line.slice(3).match(/^([^.\s]+)(?:\.\.\.([^\s]+))?(?:\s+\[ahead (\d+)(?:, behind (\d+))?|\s+\[behind (\d+))?/)
      if (m) {
        branch = m[1]
        ahead = parseInt(m[3] ?? '0', 10) || 0
        behind = parseInt(m[4] ?? m[5] ?? '0', 10) || 0
      } else {
        branch = line.slice(3).split(/\s/)[0]
      }
      continue
    }
    const xy = line.slice(0, 2)
    const filePath = line.slice(3)
    const [x, y] = [xy[0], xy[1]]
    if (xy === '??') { untracked.push(filePath); continue }
    if (x !== ' ' && x !== '?') staged.push({ path: filePath, status: x })
    if (y !== ' ' && y !== '?') unstaged.push({ path: filePath, status: y })
  }

  return c.json({ branch, ahead, behind, staged, unstaged, untracked })
})

app.post('/git/stage', async (c) => {
  const body = await c.req.json().catch(() => null) as { paths?: string[] } | null
  if (!body?.paths?.length) return c.json({ error: 'paths required' }, 400)
  const { code, stderr } = await runGit(['add', '--', ...body.paths])
  if (code !== 0) return c.json({ error: stderr }, 400)
  return c.json({ ok: true })
})

app.post('/git/unstage', async (c) => {
  const body = await c.req.json().catch(() => null) as { paths?: string[] } | null
  if (!body?.paths?.length) return c.json({ error: 'paths required' }, 400)
  const { code, stderr } = await runGit(['reset', 'HEAD', '--', ...body.paths])
  if (code !== 0) return c.json({ error: stderr }, 400)
  return c.json({ ok: true })
})

app.post('/git/discard', async (c) => {
  const body = await c.req.json().catch(() => null) as { paths?: string[] } | null
  if (!body?.paths?.length) return c.json({ error: 'paths required' }, 400)
  const { code, stderr } = await runGit(['checkout', '--', ...body.paths])
  if (code !== 0) return c.json({ error: stderr }, 400)
  return c.json({ ok: true })
})

app.post('/git/commit', async (c) => {
  const body = await c.req.json().catch(() => null) as { message?: string } | null
  if (!body?.message?.trim()) return c.json({ error: 'message required' }, 400)
  const { code, stdout, stderr } = await runGit(['commit', '-m', body.message])
  if (code !== 0) return c.json({ error: stderr || stdout }, 400)
  return c.json({ ok: true, output: stdout })
})

app.get('/git/diff', async (c) => {
  const p = c.req.query('path')
  if (!p) return c.json({ error: 'path required' }, 400)
  const staged = c.req.query('staged') === '1'
  const args = ['diff']
  if (staged) args.push('--cached')
  args.push('--no-color', '--', p)
  const { code, stdout, stderr } = await runGit(args)
  if (code !== 0) return c.json({ error: stderr }, 400)
  return c.json({ diff: stdout, path: p, staged })
})

// ---------------------------------------------------------------------------
// Terminal API — Phase 7
// ---------------------------------------------------------------------------
// Spawns real shell sessions (via node child_process, not a PTY). Input/output
// is streamed over SSE. Good enough for git/ls/bun/npm/cat; full-screen apps
// like vim will not render correctly without a PTY.
// ---------------------------------------------------------------------------

// Simpler model (no PTY): each session tracks a cwd. The frontend sends
// whole command lines via POST /term/:id/exec; we run them with `bash -c` and
// stream stdout/stderr back as SSE chunks. `cd` mutates the session cwd.
// Trade-offs: no interactive apps (vim, top), but reliable everywhere and
// behaves like a normal REPL — perfect for git/ls/bun/curl/echo.

interface TermSession {
  cwd: string
  current: ReturnType<typeof nodeSpawn> | null
  subscribers: Set<(chunk: string) => void>
  buffer: string[]
}

const termSessions = new Map<string, TermSession>()
const MAX_BUFFER_CHUNKS = 500

function makeSessionId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function broadcast(session: TermSession, chunk: string) {
  session.buffer.push(chunk)
  if (session.buffer.length > MAX_BUFFER_CHUNKS) session.buffer.shift()
  for (const sub of session.subscribers) sub(chunk)
}

function shortCwd(abs: string) {
  if (abs === WORKSPACE_ROOT) return 'workspace'
  if (abs.startsWith(WORKSPACE_ROOT + '/')) return abs.slice(WORKSPACE_ROOT.length + 1)
  const home = process.env.HOME
  if (home && abs === home) return '~'
  if (home && abs.startsWith(home + '/')) return '~/' + abs.slice(home.length + 1)
  return abs
}

function prompt(session: TermSession): string {
  return `\x1b[36mshogo\x1b[0m:\x1b[33m${shortCwd(session.cwd)}\x1b[0m$ `
}

app.post('/term/spawn', async (c) => {
  const id = makeSessionId()
  const session: TermSession = {
    cwd: WORKSPACE_ROOT,
    current: null,
    subscribers: new Set(),
    buffer: [],
  }
  termSessions.set(id, session)

  const welcome =
    '\x1b[36m⚡ Shogo Terminal\x1b[0m  ' +
    `\x1b[90m(no-pty mode — git/ls/bun/etc work; vim/top do not)\x1b[0m\r\n` +
    prompt(session)
  broadcast(session, welcome)

  return c.json({ id })
})

app.get('/term/:id/stream', (c) => {
  const id = c.req.param('id')
  const session = termSessions.get(id)
  if (!session) return c.json({ error: 'session not found' }, 404)

  return streamSSE(c, async (stream) => {
    for (const chunk of session.buffer) {
      await stream.writeSSE({ event: 'data', data: Buffer.from(chunk, 'utf8').toString('base64') })
    }
    const onChunk = (chunk: string) => {
      void stream.writeSSE({ event: 'data', data: Buffer.from(chunk, 'utf8').toString('base64') })
    }
    session.subscribers.add(onChunk)
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: '' })
    }, 15_000)
    try {
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve())
      })
    } finally {
      clearInterval(heartbeat)
      session.subscribers.delete(onChunk)
    }
  })
})

app.post('/term/:id/exec', async (c) => {
  const id = c.req.param('id')
  const session = termSessions.get(id)
  if (!session) return c.json({ error: 'session not found' }, 404)

  const body = await c.req.json().catch(() => null) as { line?: string } | null
  const line = (body?.line ?? '').trim()
  // NB: client already echoed keystrokes locally via term.write, so we don't
  // re-broadcast the command line here — that would cause visible duplication.

  if (!line) {
    broadcast(session, prompt(session))
    return c.json({ ok: true })
  }

  // Built-in `cd` — mutate session state; don't shell out.
  // Only handle simple `cd [dir]` without shell operators — `cd x && y` falls
  // through to bash so compound commands work as users expect.
  const cdMatch = /[|&;<>`$()]/.test(line) ? null : line.match(/^cd(?:\s+(\S.*))?$/)
  if (cdMatch) {
    const target = (cdMatch[1] ?? process.env.HOME ?? WORKSPACE_ROOT).trim().replace(/^~(?=\/|$)/, process.env.HOME ?? '')
    const next = path.resolve(session.cwd, target)
    try {
      const stat = await fs.stat(next)
      if (!stat.isDirectory()) throw new Error(`not a directory: ${target}`)
      session.cwd = next
    } catch (err) {
      broadcast(session, `cd: ${err instanceof Error ? err.message : String(err)}\r\n`)
    }
    broadcast(session, prompt(session))
    return c.json({ ok: true })
  }

  // Built-in `clear` — ANSI clear screen
  if (line === 'clear') {
    broadcast(session, '\x1b[2J\x1b[H')
    broadcast(session, prompt(session))
    return c.json({ ok: true })
  }

  // Run via bash -c so pipes/redirects/globs work
  if (session.current) {
    broadcast(session, '\x1b[31mbusy — a command is already running\x1b[0m\r\n')
    return c.json({ ok: false })
  }
  const proc = nodeSpawn('/bin/bash', ['-c', line], {
    cwd: session.cwd,
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', CLICOLOR: '1', CLICOLOR_FORCE: '1' },
  })
  session.current = proc
  proc.stdout.on('data', (d) => broadcast(session, d.toString('utf8').replace(/\n/g, '\r\n')))
  proc.stderr.on('data', (d) => broadcast(session, d.toString('utf8').replace(/\n/g, '\r\n')))
  proc.on('close', (code) => {
    session.current = null
    if (code !== 0 && code !== null) {
      broadcast(session, `\x1b[90m[exit ${code}]\x1b[0m\r\n`)
    }
    broadcast(session, prompt(session))
  })
  proc.on('error', (err) => {
    session.current = null
    broadcast(session, `\x1b[31m${err.message}\x1b[0m\r\n`)
    broadcast(session, prompt(session))
  })

  return c.json({ ok: true })
})

app.post('/term/:id/signal', async (c) => {
  const id = c.req.param('id')
  const session = termSessions.get(id)
  if (!session) return c.json({ error: 'session not found' }, 404)
  const body = await c.req.json().catch(() => null) as { signal?: string } | null
  const sig = (body?.signal ?? 'SIGINT') as NodeJS.Signals
  if (session.current) {
    try { session.current.kill(sig) } catch { /* ignore */ }
    broadcast(session, `\x1b[90m^C\x1b[0m\r\n`)
  }
  return c.json({ ok: true })
})

app.post('/term/:id/kill', async (c) => {
  const id = c.req.param('id')
  const session = termSessions.get(id)
  if (!session) return c.json({ error: 'session not found' }, 404)
  try { session.current?.kill('SIGTERM') } catch { /* ignore */ }
  termSessions.delete(id)
  return c.json({ ok: true })
})

export default app
