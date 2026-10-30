// A real API process for the two-process move test: its own SQLite file and
// its own WORKSPACES_DIR, so source and target cannot share state by accident.
// Spawned by `workspace-move-two-process.acceptance.test.ts`; not a test itself.
import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dataDir = process.env.QA_DATA_DIR
const filesDir = process.env.QA_FILES_DIR
const userId = process.env.QA_USER_ID ?? 'u-owner-246'
if (!dataDir || !filesDir) throw new Error('QA_DATA_DIR and QA_FILES_DIR are required')

mkdirSync(dataDir, { recursive: true })
mkdirSync(filesDir, { recursive: true })

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

const { Hono } = await import('hono')
const { prisma } = await import('../../lib/prisma')
const { workspaceMoveRoutes } = await import('../../routes/workspace-moves')

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

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

const app = new Hono()
app.use('*', async (c, next) => {
  const header = c.req.header('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401)
  c.set('auth', { userId, isAuthenticated: true, via: 'session' } as any)
  await next()
})
app.route('/api/workspace-moves', workspaceMoveRoutes())

app.get('/__qa/health', (c) => c.json({ ok: true }))

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
    return await seedWorkspace(c)
  } catch (error) {
    console.error('SEED FAILED', error)
    return c.json({ error: String((error as Error)?.message ?? error) }, 500)
  }
})

async function seedWorkspace(c: any) {
  const w = 'ws-246'
  await prisma.user.create({ data: { id: userId, email: 'owner246@example.com', name: 'Owner' } as any })
  for (const id of ['u-admin-246', 'u-viewer-246']) {
    await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id } as any })
  }
  await prisma.workspace.create({ data: { id: w, name: 'Content Studio', slug: 'content-246', kind: 'team' } as any })
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
    const root = join(filesDir, project.id)
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
  const workspaces = await prisma.workspace.findMany({ select: { id: true, movedToWorkspaceId: true } as any })
  const moves = await prisma.workspaceMove.findMany({ orderBy: { createdAt: 'desc' } as any })
  return c.json({
    workspaces,
    userIds,
    projects,
    counts,
    moves: moves.map((m: any) => ({ id: m.id, status: m.status, error: m.error, direction: m.direction, targetWorkspaceId: m.targetWorkspaceId })),
    dirs: readdirSync(filesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ dir: d.name, files: walk(join(filesDir, d.name)) })),
  })
})

// A real desktop knows its own port before the API child starts (it is
// `SHOGO_API_URL` in the child's env), so the port has to be fixed up front.
const server = Bun.serve({ port: Number(process.env.QA_PORT ?? 0), fetch: (req) => app.fetch(req) })
console.log(`QA_SERVER_READY ${server.port}`)
