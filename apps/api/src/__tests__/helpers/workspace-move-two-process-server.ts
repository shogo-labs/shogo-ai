// A real API process for the two-process move test: its own SQLite file and
// its own WORKSPACES_DIR, so source and target cannot share state by accident.
// Spawned by `workspace-move-two-process.acceptance.test.ts`; not a test itself.
//
// `QA_CLOUD_STORAGE=1` makes this process behave like the API pod in Kubernetes
// (SHO-252): no project files on its own disk, `KUBERNETES_SERVICE_HOST` set, a
// runtime pod that serves a bundle from `QA_POD_DIR`, and an S3 endpoint this
// process stores project archives in. That is the shape that was missing when a
// real cloud → desktop move carried 1,956 rows and zero files.
import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import * as tar from 'tar'

const dataDir = process.env.QA_DATA_DIR
const filesDir = process.env.QA_FILES_DIR
const userId = process.env.QA_USER_ID ?? 'u-owner-246'
const cloudStorage = process.env.QA_CLOUD_STORAGE === '1'
const podDir = process.env.QA_POD_DIR ?? join(filesDir ?? '.', '.fake-pods')
if (!dataDir || !filesDir) throw new Error('QA_DATA_DIR and QA_FILES_DIR are required')

mkdirSync(dataDir, { recursive: true })
mkdirSync(filesDir, { recursive: true })
mkdirSync(podDir, { recursive: true })

const MIGRATIONS_DIR = resolve(import.meta.dir, '../../../../desktop/prisma/migrations')
const dbPath = join(dataDir, 'app.db')
if (!existsSync(dbPath)) {
  const sqlite = new Database(dbPath)
  for (const name of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf-8'))
  }
  sqlite.close()
}

process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_APP_DATABASE_URL = `file:${dbPath}`
process.env.WORKSPACES_DIR = filesDir

const sha = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex')

// ─── Fake runtime pods + fake S3 (cloud-storage mode only) ─────────────
//
// Both are real HTTP servers this process talks to over TCP: the S3 path runs
// the product's own `S3Sync` (the same client import and the runtime pods use),
// and the pod path runs the SDK's own `AgentClient` against `/agent/workspace/*`.

/** What the runtime pod's disk holds: `projects/<id>/…` and `workspaces/<id>/…`. */
const podProjectDir = (projectId: string) => join(podDir, 'projects', projectId)
const podWorkspaceDir = (workspaceId: string) => join(podDir, 'workspaces', workspaceId)

function walkFiles(dir: string, base = dir): { path: string; sha: string; bytes: number }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walkFiles(full, base)
    if (!entry.isFile()) return []
    const buf = readFileSync(full)
    return [{ path: relative(base, full).replace(/\\/g, '/'), sha: sha(buf), bytes: buf.length }]
  })
}

/** The runtime pod's own bundle exclusions, so the fake pod behaves like the real one. */
const POD_EXCLUDED_DIRS = new Set(['node_modules', '.git', '.cache', '.next', '.turbo', '.expo'])

function collectPodBundle(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (POD_EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.install-ok') || entry.name.startsWith('._')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(out, collectPodBundle(full, base))
    else if (entry.isFile()) out[relative(base, full).replace(/\\/g, '/')] = readFileSync(full).toString('base64')
  }
  return out
}

const s3Store = new Map<string, { body: Uint8Array; etag: string }>()
let s3Port = 0
let podPort = 0

const s3NotFound = (code: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>not found</Message></Error>`, {
    status: 404,
    headers: { 'content-type': 'application/xml' },
  })

function startFakeS3() {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      // forcePathStyle: `/<bucket>/<key…>`
      const [, , ...keyParts] = decodeURIComponent(url.pathname).split('/')
      const key = keyParts.join('/')
      if (req.method === 'HEAD') {
        const object = s3Store.get(key)
        if (!object) return s3NotFound('NotFound')
        return new Response(null, {
          status: 200,
          headers: { etag: object.etag, 'content-length': String(object.body.length) },
        })
      }
      if (req.method === 'GET') {
        const object = s3Store.get(key)
        if (!object) return s3NotFound('NoSuchKey')
        return new Response(object.body, { status: 200, headers: { etag: object.etag } })
      }
      if (req.method === 'PUT') {
        const body = new Uint8Array(await req.arrayBuffer())
        const etag = `"${sha(body).slice(0, 32)}"`
        s3Store.set(key, { body, etag })
        return new Response('', { status: 200, headers: { etag } })
      }
      if (req.method === 'DELETE') {
        s3Store.delete(key)
        return new Response(null, { status: 204 })
      }
      return new Response('', { status: 405 })
    },
  })
  s3Port = server.port
  return server
}

function startFakeRuntimePods() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean)
      // `/pod/<projectId>/agent/…` and `/ws/<workspaceId>/agent/…`
      const [kind, id, ...rest] = parts
      const path = `/${rest.join('/')}`
      const root = kind === 'ws' ? podWorkspaceDir(id ?? '') : podProjectDir(id ?? '')
      if (path === '/agent/workspace/bundle') {
        return Response.json({ files: collectPodBundle(root) })
      }
      if (path.startsWith('/agent/workspace/download/')) {
        const relPath = path.slice('/agent/workspace/download/'.length)
        const full = join(root, relPath)
        if (!existsSync(full) || !statSync(full).isFile()) {
          return new Response('not found', { status: 404 })
        }
        return new Response(readFileSync(full), {
          headers: { 'content-type': 'application/octet-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  podPort = server.port
  return server
}

if (cloudStorage) {
  process.env.KUBERNETES_SERVICE_HOST = '127.0.0.1'
  startFakeS3()
  startFakeRuntimePods()
  // `QA_NO_BUCKET=1` is the unconfigured-instance shape: a Kubernetes cloud with
  // no workspace bucket. A move into it must fail, never report `done`.
  if (process.env.QA_NO_BUCKET !== '1') process.env.S3_WORKSPACES_BUCKET = 'qa-workspaces'
  process.env.S3_ENDPOINT = `http://127.0.0.1:${s3Port}`
  process.env.S3_FORCE_PATH_STYLE = 'true'
  process.env.S3_REGION = 'us-east-1'
  process.env.AWS_ACCESS_KEY_ID = 'qa'
  process.env.AWS_SECRET_ACCESS_KEY = 'qa'

  // The API pod resolves a runtime by asking the cluster. There is no cluster
  // here, so the two resolvers point at the fake pods above — everything else
  // (`AgentClient`, tokens, bundles, S3Sync) is the product's own code.
  const { mock } = await import('bun:test')
  const projectManagerPath = resolve(import.meta.dir, '../../lib/knative-project-manager.ts')
  const workspaceManagerPath = resolve(import.meta.dir, '../../lib/knative-workspace-manager.ts')
  mock.module(projectManagerPath, () => ({
    getProjectPodUrl: async (projectId: string) => `http://127.0.0.1:${podPort}/pod/${projectId}`,
  }))
  mock.module(workspaceManagerPath, () => ({
    getWorkspacePodUrl: async (workspaceId: string) => `http://127.0.0.1:${podPort}/ws/${workspaceId}`,
  }))
}

const { Hono } = await import('hono')
const { prisma } = await import('../../lib/prisma')
const { workspaceMoveRoutes } = await import('../../routes/workspace-moves')

// A desktop is the default. `QA_SURFACE=cloud` makes this process answer like
// the cloud API, which is the one difference that matters to `/receive/init`:
// the workspace it creates is gated by the create rule there and not here
// (SHO-256). The Prisma client above is already built against SQLite, so the
// flag only changes what the per-call mode readers see.
if (process.env.QA_SURFACE === 'cloud') delete process.env.SHOGO_LOCAL_MODE

/** Deterministic bytes so both ends can compare checksums across processes. */
function deterministicBytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size)
  let written = 0
  let round = 0
  while (written < size) {
    const block = createHash('sha256').update(`${seed}:${round++}`).digest()
    block.copy(out, written)
    written += block.length
  }
  return out
}

const app = new Hono()
app.use('*', async (c, next) => {
  const header = c.req.header('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401)
  c.set('auth', { userId, isAuthenticated: true, via: 'session' } as any)
  await next()
})
app.route('/api/workspace-moves', workspaceMoveRoutes())

app.get('/__qa/health', (c) => c.json({ ok: true }))

// Accounts the target already knows. SEC-18 refuses a `User` row for an id the
// receiving instance has no account for, so a fixture whose source workspace has
// members must seed them here first — otherwise the stranger check answers 400
// before the behaviour under test is reached.
app.post('/__qa/ensure-users', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] }
  for (const id of body.ids ?? []) {
    if (await prisma.user.findUnique({ where: { id } as any })) continue
    await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id } as any })
  }
  return c.json({ ok: true })
})

// The desktop knows the cloud workspace before it offers the move: a user row
// and a membership grant, with none of the content.
app.post('/__qa/seed-remote', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string }
  const w = body.workspaceId ?? 'ws-246'
  if (!(await prisma.user.findUnique({ where: { id: userId } as any }))) {
    await prisma.user.create({ data: { id: userId, email: 'owner246@example.com', name: 'Owner' } as any })
  }
  if (!(await prisma.workspace.findUnique({ where: { id: w } as any }))) {
    await prisma.workspace.create({ data: { id: w, name: 'Content Studio', slug: 'content-246', kind: 'team' } as any })
    await prisma.member.create({ data: { userId, workspaceId: w, role: 'owner' } as any })
  }
  return c.json({ ok: true, workspaceId: w })
})

const PROJECTS = [
  { id: 'p-246-reel', name: 'Reel', files: 30, big: 2 * 1024 * 1024 },
  { id: 'p-246-site', name: 'Site', files: 40, big: 512 * 1024 },
  { id: 'p-246-api', name: 'Api', files: 50, big: 128 * 1024 },
  { id: 'p-246-empty', name: 'Empty', files: 0, big: 0 },
]

const IGNORED = [
  { dir: 'out', file: 'render.mp4', size: 4096 },
  { dir: '.tmp', file: 'scratch.bin', size: 1024 },
  { dir: 'node_modules/pkg', file: 'index.js', size: 2048 },
]

app.post('/__qa/seed', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { instanceSize?: string }
    return await seedWorkspace(c, body)
  } catch (error) {
    console.error('SEED FAILED', error)
    return c.json({ error: String((error as Error)?.message ?? error) }, 500)
  }
})

// Give the account an owned workspace of one kind, i.e. spend (or leave unspent)
// that kind's free allowance. What `/receive/init` refuses or allows turns on
// this count, so the test needs to set it without seeding a whole workspace.
app.post('/__qa/own-workspace', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { kind?: string; instanceSize?: string }
  const kind = body.kind === 'personal' ? 'personal' : 'team'
  await ensureUser()
  const id = `ws-own-${kind}`
  await prisma.workspace.create({
    data: { id, name: `${kind} owned`, slug: `own-${kind}`, kind, instanceSize: body.instanceSize } as any,
  })
  await prisma.member.create({ data: { userId, workspaceId: id, role: 'owner' } as any })
  return c.json({ ok: true, workspaceId: id })
})

async function ensureUser() {
  if (!(await prisma.user.findUnique({ where: { id: userId } as any }))) {
    await prisma.user.create({ data: { id: userId, email: 'owner246@example.com', name: 'Owner' } as any })
  }
}

// Accounts the target already knows, so a pushed workspace's other members are
// not refused as strangers (`workspace_move_unknown_user`).
app.post('/__qa/ensure-users', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] }
  await ensureUser()
  for (const id of body.ids ?? []) {
    if (await prisma.user.findUnique({ where: { id } as any })) continue
    await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id } as any })
  }
  return c.json({ ok: true })
})

async function seedWorkspace(c: any, body: { instanceSize?: string } = {}) {
  const w = cloudStorage ? 'ws-252' : 'ws-246'
  await ensureUser()
  for (const id of ['u-admin-246', 'u-viewer-246']) {
    await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id } as any })
  }
  await prisma.workspace.create({
    data: { id: w, name: 'Content Studio', slug: 'content-246', kind: 'team', instanceSize: body.instanceSize } as any,
  })
  await prisma.member.create({ data: { userId, workspaceId: w, role: 'owner' } as any })
  await prisma.member.create({ data: { userId: 'u-admin-246', workspaceId: w, role: 'admin' } as any })
  await prisma.member.create({ data: { userId: 'u-viewer-246', workspaceId: w, role: 'member' } as any })
  // Someone who is in a channel but NOT in the workspace: an account that has
  // since left, a guest invited to one conversation. Every real workspace has
  // them, and their rows point at a `User` no `Member` row mentions.
  await prisma.user.create({
    data: { id: 'u-guest-246', email: 'guest246@example.com', name: 'Guest' } as any,
  })

  const expected: { projectDir: string; path: string; sha: string; bytes: number }[] = []

  for (const project of PROJECTS) {
    await prisma.project.create({ data: { id: project.id, workspaceId: w, name: project.name } as any })
    // Cloud mode: the project's files live in its runtime pod, never on the API
    // pod's disk — the exact shape whose absence made a move carry 0 files.
    const root = cloudStorage ? podProjectDir(project.id) : join(filesDir, project.id)
    for (let i = 0; i < project.files; i += 1) {
      const rel = `src/mod${i % 5}/file-${i}.${i % 3 === 0 ? 'bin' : 'txt'}`
      const size = 512 + ((i * 977) % 32_768)
      const bytes = deterministicBytes(`${project.id}:${rel}`, size)
      mkdirSync(join(root, 'src', `mod${i % 5}`), { recursive: true })
      writeFileSync(join(root, rel), bytes)
      expected.push({ projectDir: project.id, path: rel, sha: sha(bytes), bytes: size })
    }
    // a unicode name and a large binary, the things that break on a wire
    const uniRel = 'assets/réel-übung-日本.txt'
    const uniBytes = deterministicBytes(`${project.id}:unicode`, 1024)
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, uniRel), uniBytes)
    expected.push({ projectDir: project.id, path: uniRel, sha: sha(uniBytes), bytes: uniBytes.length })

    if (project.big > 0) {
      const bigRel = 'assets/big.bin'
      const bigBytes = randomBytes(project.big)
      writeFileSync(join(root, bigRel), bigBytes)
      expected.push({ projectDir: project.id, path: bigRel, sha: sha(bigBytes), bytes: project.big })
    }
    for (const ignored of IGNORED) {
      mkdirSync(join(root, ignored.dir), { recursive: true })
      writeFileSync(join(root, ignored.dir, ignored.file), randomBytes(ignored.size))
    }
  }

  // A cloud workspace's own root files (AGENTS.md, MEMORY.md, `.shogo/`) live in
  // the merged workspace runtime's WORKSPACE_DIR, so that is where the seed puts
  // them. They travel as the `__workspace_root__` pseudo-project.
  if (cloudStorage) {
    const rootDir = podWorkspaceDir(w)
    const rootFiles: Array<[string, Buffer]> = [
      ['AGENTS.md', Buffer.from('# AGENTS\n\nSeeded workspace root.\n')],
      ['memory/2026-10-30.md', deterministicBytes('root:memory', 640)],
      ['.shogo/skills/review/SKILL.md', Buffer.from('---\nname: review\n---\nReview it.\n')],
    ]
    for (const [relPath, bytes] of rootFiles) {
      mkdirSync(join(rootDir, relPath, '..'), { recursive: true })
      writeFileSync(join(rootDir, relPath), bytes)
      expected.push({ projectDir: '__workspace_root__', path: relPath, sha: sha(bytes), bytes: bytes.length })
    }
  }

  const conversations: string[] = []
  for (let i = 0; i < 3; i += 1) {
    const id = `c-246-${i}`
    conversations.push(id)
    await prisma.conversation.create({
      data: { id, workspaceId: w, kind: 'public', name: `chan${i}`, slug: `chan${i}` } as any,
    })
    for (let m = 0; m < 20; m += 1) {
      await prisma.conversationMessage.create({
        data: {
          id: `msg-246-${i}-${m}`,
          conversationId: id,
          workspaceId: w,
          seq: m,
          authorUserId: userId,
          text: `message ${m}`,
        } as any,
      })
    }
  }
  // The guest is in one channel only and wrote in it: a `ConversationMember`
  // and a message that both point at a user no `Member` row mentions.
  await prisma.conversationMember.create({
    data: { id: 'cm-246-guest', conversationId: conversations[0], userId: 'u-guest-246', role: 'member' } as any,
  })
  await prisma.conversationMessage.create({
    data: {
      id: 'msg-246-guest',
      conversationId: conversations[0],
      workspaceId: w,
      seq: 99,
      authorUserId: 'u-guest-246',
      text: 'a guest said this',
    } as any,
  })
  for (let b = 0; b < 2; b += 1) {
    const boardId = `b-246-${b}`
    const colId = `col-246-${b}`
    await prisma.board.create({
      data: { id: boardId, workspaceId: w, conversationId: conversations[b], name: `Board ${b}`, slug: `board-${b}`, keyPrefix: `B${b}` } as any,
    })
    await prisma.boardColumn.create({ data: { id: colId, boardId, name: 'Active', category: 'active' } as any })
    for (let n = 0; n < 12; n += 1) {
      await prisma.workItem.create({
        data: {
          id: `wi-246-${b}-${n}`,
          workspaceId: w,
          boardId,
          columnId: colId,
          key: `B${b}-${n + 1}`,
          number: n + 1,
          title: `Item ${n}`,
        } as any,
      })
    }
  }
  await prisma.agentSchedule.create({
    data: {
      id: 'sched-246',
      workspaceId: w,
      userId,
      name: 'daily',
      prompt: 'summarise',
      cronExpression: '0 9 * * *',
      nextRunAt: new Date(Date.now() + 86_400_000),
    } as any,
  })
  await prisma.eventSubscription.create({
    data: { id: 'trig-246', workspaceId: w, name: 'on join', eventType: 'member.joined' } as any,
  })

  return c.json({ workspaceId: w, projects: PROJECTS.map((p) => p.id), expected })
}

app.get('/__qa/state', async (c) => {
  try {
    return await statePayload(c)
  } catch (error) {
    console.error('STATE FAILED', error)
    return c.json({ error: String((error as Error)?.message ?? error) }, 500)
  }
})

async function statePayload(c: any) {
  const walk = (dir: string, base = ''): { path: string; sha: string; bytes: number }[] => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const rel = base ? join(base, d.name) : d.name
      if (d.isDirectory()) return walk(join(dir, d.name), rel)
      const buf = readFileSync(join(dir, d.name))
      return [{ path: rel, sha: sha(buf), bytes: buf.length }]
    })
  }
  const projects = await prisma.project.findMany({ select: { id: true, workspaceId: true, name: true } as any })
  const counts = {
    messages: await prisma.conversationMessage.count(),
    workItems: await prisma.workItem.count(),
    boards: await prisma.board.count(),
    conversations: await prisma.conversation.count(),
    members: await prisma.member.count(),
    conversationMembers: await prisma.conversationMember.count(),
    users: await prisma.user.count(),
    projects: await prisma.project.count(),
    schedules: await prisma.agentSchedule.count(),
    triggers: await prisma.eventSubscription.count(),
  }
  const userIds = (await prisma.user.findMany({ select: { id: true } as any })).map((u: any) => u.id)
  const members = (
    await prisma.member.findMany({ select: { userId: true, workspaceId: true, role: true } as any })
  ).map((m: any) => ({ userId: m.userId, workspaceId: m.workspaceId, role: m.role }))
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, name: true, kind: true, instanceSize: true, movedToWorkspaceId: true } as any,
  })
  const moves = await prisma.workspaceMove.findMany({ orderBy: { createdAt: 'desc' } as any })
  return c.json({
    workspaces,
    userIds,
    members,
    projects,
    counts,
    cloudStorage,
    moves: moves.map((m: any) => ({ id: m.id, status: m.status, error: m.error, direction: m.direction, targetWorkspaceId: m.targetWorkspaceId, progress: m.progress })),
    dirs: readdirSync(filesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ dir: d.name, files: walk(join(filesDir, d.name)) })),
    // The workspace root of a target lives one level down, so report it too.
    workspaceRoots: existsSync(join(filesDir, '.workspace-roots'))
      ? readdirSync(join(filesDir, '.workspace-roots'), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => ({ dir: d.name, files: walk(join(filesDir, '.workspace-roots', d.name)) }))
      : [],
    // What the fake runtime pods hold, and what the fake S3 holds — the two
    // stores a Kubernetes-mode move is supposed to read and write.
    pods: {
      projects: existsSync(join(podDir, 'projects'))
        ? readdirSync(join(podDir, 'projects'), { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => ({ projectId: d.name, files: walkFiles(join(podDir, 'projects', d.name)) }))
        : [],
      workspaces: existsSync(join(podDir, 'workspaces'))
        ? readdirSync(join(podDir, 'workspaces'), { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => ({ workspaceId: d.name, files: walkFiles(join(podDir, 'workspaces', d.name)) }))
        : [],
    },
    s3: {
      keys: [...s3Store.keys()],
      archives: await Promise.all(
        [...s3Store.entries()]
          .filter(([key]) => key.endsWith('/project-src.tar.gz'))
          .map(async ([key, object]) => ({
            key,
            projectId: key.slice(0, key.indexOf('/')),
            files: await extractArchiveFiles(object.body),
          })),
      ),
    },
  })
}

/**
 * What a stored `project-src.tar.gz` actually contains, by hash — the assertion
 * that a desktop → cloud move landed the bytes where the runtime pod reads them.
 */
async function extractArchiveFiles(
  body: Uint8Array,
): Promise<{ path: string; sha: string; bytes: number }[]> {
  const dir = mkdtempSync(join(tmpdir(), 'qa-s3-archive-'))
  try {
    const archive = join(dir, 'project-src.tar.gz')
    const out = join(dir, 'out')
    writeFileSync(archive, body)
    mkdirSync(out, { recursive: true })
    // node-tar, not the system `tar`: the runtime extracts with node-tar, and
    // bsdtar rewrites non-ASCII names to NFD on the way out, which would make a
    // `réel-übung-日本.txt` look missing from a perfectly good archive.
    await tar.extract({ file: archive, cwd: out })
    return walkFiles(out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A real desktop knows its own port before the API child starts (it is
// `SHOGO_API_URL` in the child's env), so the port has to be fixed up front.
const server = Bun.serve({ port: Number(process.env.QA_PORT ?? 0), fetch: (req) => app.fetch(req) })
console.log(`QA_SERVER_READY ${server.port}`)
