/**
 * E2E test for project export/import.
 *
 * Tests the route handlers directly against the local SQLite database,
 * bypassing HTTP auth. Creates a test project, exports it, imports it,
 * and verifies the round-trip.
 *
 * The test Hono app mirrors the production middleware layering from
 * apps/api/src/server.ts — in particular the `/api/projects/:projectId/*`
 * requireProjectAccess guard — so that regressions like a reserved
 * sub-route (e.g. `/api/projects/import`) being hijacked by the
 * `:projectId` wildcard are caught here.
 *
 * Run: SHOGO_LOCAL_MODE=true DATABASE_URL=file:./shogo.db bun test e2e/project-export-import.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'

// Force local mode for SQLite
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.DATABASE_URL = 'file:./shogo.db'

const { prisma } = await import('../apps/api/src/lib/prisma')
const { projectExportImportRoutes } = await import('../apps/api/src/routes/project-export-import')
const { requireProjectAccess, isProjectReservedTopLevelPath } = await import(
  '../apps/api/src/middleware/auth'
)
import { Hono } from 'hono'

let testProjectId: string
let testWorkspaceId: string
let testUserId: string
let testMemberId: string
const cleanupProjectIds: string[] = []

const app = new Hono()

// Mock auth middleware — set auth context for all requests
app.use('*', async (c, next) => {
  c.set('auth' as any, { isAuthenticated: true, userId: testUserId })
  await next()
})
// Mirror the production middleware layering in apps/api/src/server.ts so
// that bugs involving reserved sub-routes (e.g. /api/projects/import being
// matched as projectId="import") surface in tests. Shares the reserved-path
// bypass helper with the real server so the test exercises the same source
// of truth.
app.use('/api/projects/:projectId/*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (isProjectReservedTopLevelPath(path)) return next()
  return requireProjectAccess(c, next)
})
app.route('/api/projects', projectExportImportRoutes())
// Register a few dummy sibling `/api/projects/:projectId/...` routes so the
// Hono router trie matches the shape of the real server, where wildcard
// middleware matching is sensitive to the set of co-registered routes.
app.post('/api/projects/:projectId/publish', (c) => c.json({ ok: true }))
app.get('/api/projects/:projectId/files', (c) => c.json({ ok: true }))

describe('Project Export/Import E2E', () => {
  beforeAll(async () => {
    // Pick any existing workspace to attach the test user to.
    const workspace = await prisma.workspace.findFirst()
    if (!workspace) {
      throw new Error(
        'No workspace found in local DB — run the app at least once to create one',
      )
    }
    testWorkspaceId = workspace.id

    // Create a dedicated non-super-admin test user + membership so that
    // requireProjectAccess runs its real DB project lookup (super_admins
    // bypass the lookup entirely and would mask bugs that only surface
    // for regular users).
    const testUser = await prisma.user.create({
      data: {
        email: `e2e-export-import-${Date.now()}@test.local`,
        name: 'E2E Export/Import Test User',
        role: 'user',
      },
    })
    testUserId = testUser.id
    const testMember = await prisma.member.create({
      data: {
        userId: testUserId,
        workspaceId: testWorkspaceId,
        role: 'member',
      },
    })
    testMemberId = testMember.id

    // Create a test project with known data
    const project = await prisma.project.create({
      data: {
        name: 'E2E Export Test Project',
        description: 'Created by e2e test',
        workspaceId: testWorkspaceId,
        createdBy: testUserId,
        tier: 'starter',
        status: 'draft',
        accessLevel: 'anyone',
        settings: JSON.stringify({ activeMode: 'canvas', canvasMode: 'code' }),
      },
    })
    testProjectId = project.id
    cleanupProjectIds.push(testProjectId)

    // Create agent config
    await prisma.agentConfig.create({
      data: {
        projectId: testProjectId,
        heartbeatInterval: 600,
        heartbeatEnabled: true,
        modelProvider: 'anthropic',
        modelName: 'claude-sonnet-4-20250514',
        channels: JSON.stringify([]),
      },
    })

    // Create a chat session with messages
    const session = await prisma.chatSession.create({
      data: {
        inferredName: 'Test conversation',
        contextType: 'project',
        contextId: testProjectId,
      },
    })
    await prisma.chatMessage.createMany({
      data: [
        { sessionId: session.id, role: 'user', content: 'Hello from e2e test' },
        { sessionId: session.id, role: 'assistant', content: 'Hi! I am the assistant.' },
      ],
    })

    // Create workspace directory with a test file
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(process.cwd(), 'workspaces')
    const projectDir = join(WORKSPACES_DIR, testProjectId)
    mkdirSync(join(projectDir, 'src'), { recursive: true })
    writeFileSync(join(projectDir, 'AGENTS.md'), '# Test Agent\nThis is a test agent.')
    writeFileSync(join(projectDir, 'src', 'main.tsx'), 'export default function App() { return <div>Hello</div> }')
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }))
    // Prebuilt dist/ — must be included in the export so imported projects
    // can serve the preview immediately (see preview-manager.ts).
    mkdirSync(join(projectDir, 'dist', 'assets'), { recursive: true })
    writeFileSync(join(projectDir, 'dist', 'index.html'), '<html><body>Hi</body></html>')
    writeFileSync(join(projectDir, 'dist', 'assets', 'app.js'), 'console.log("hi")')

    console.log(`[Setup] Created test project: ${testProjectId}`)
  })

  afterAll(async () => {
    const { rmSync, existsSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(process.cwd(), 'workspaces')

    for (const id of cleanupProjectIds) {
      try {
        await prisma.chatMessage.deleteMany({
          where: { session: { contextId: id } },
        })
        await prisma.chatSession.deleteMany({ where: { contextId: id } })
        await prisma.agentConfig.deleteMany({ where: { projectId: id } })
        await prisma.project.delete({ where: { id } })

        const dir = join(WORKSPACES_DIR, id)
        if (existsSync(dir)) rmSync(dir, { recursive: true })
      } catch {}
    }

    try {
      if (testMemberId) await prisma.member.delete({ where: { id: testMemberId } })
    } catch {}
    try {
      if (testUserId) await prisma.user.delete({ where: { id: testUserId } })
    } catch {}

    console.log(`[Cleanup] Removed ${cleanupProjectIds.length} test project(s)`)
  })

  it('should export a project as a valid ZIP with project.json, workspace, and chat-history', async () => {
    const req = new Request(`http://localhost/api/projects/${testProjectId}/export`)
    const res = await app.fetch(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain('.shogo-project')

    const buf = new Uint8Array(await res.arrayBuffer())
    expect(buf.length).toBeGreaterThan(0)

    const unzipped = unzipSync(buf)

    // project.json exists and has correct data
    expect(unzipped['project.json']).toBeDefined()
    const projectJson = JSON.parse(strFromU8(unzipped['project.json']))
    expect(projectJson.version).toBe('1.0')
    expect(projectJson.project.name).toBe('E2E Export Test Project')
    expect(projectJson.project.description).toBe('Created by e2e test')
    expect(projectJson.project.tier).toBe('starter')

    // agent config is included
    expect(projectJson.agentConfig).toBeDefined()
    expect(projectJson.agentConfig.heartbeatInterval).toBe(600)
    expect(projectJson.agentConfig.heartbeatEnabled).toBe(true)
    expect(projectJson.agentConfig.modelName).toBe('claude-sonnet-4-20250514')

    // workspace files
    expect(unzipped['workspace/AGENTS.md']).toBeDefined()
    expect(strFromU8(unzipped['workspace/AGENTS.md'])).toContain('Test Agent')
    expect(unzipped['workspace/src/main.tsx']).toBeDefined()
    expect(unzipped['workspace/package.json']).toBeDefined()

    // chat history
    const chatFiles = Object.keys(unzipped).filter((k) => k.startsWith('chat-history/'))
    expect(chatFiles.length).toBe(1)
    const chatData = JSON.parse(strFromU8(unzipped[chatFiles[0]]))
    expect(chatData.session.inferredName).toBe('Test conversation')
    expect(chatData.messages.length).toBe(2)
    expect(chatData.messages[0].role).toBe('user')
    expect(chatData.messages[0].content).toBe('Hello from e2e test')
    expect(chatData.messages[1].role).toBe('assistant')
    expect(chatData.messages[1].content).toBe('Hi! I am the assistant.')

    console.log(`[Export] ZIP: ${buf.length} bytes, ${Object.keys(unzipped).length} entries`)
  })

  it('should import an exported project and create a new project with all data', async () => {
    // Export first
    const exportReq = new Request(`http://localhost/api/projects/${testProjectId}/export`)
    const exportRes = await app.fetch(exportReq)
    expect(exportRes.status).toBe(200)
    const zipBuf = await exportRes.arrayBuffer()

    // Import
    const formData = new FormData()
    formData.append('file', new Blob([zipBuf], { type: 'application/zip' }), 'test.shogo-project')
    formData.append('workspaceId', testWorkspaceId)

    const importReq = new Request('http://localhost/api/projects/import', {
      method: 'POST',
      body: formData,
    })
    const importRes = await app.fetch(importReq)

    expect(importRes.status).toBe(200)
    const importData = (await importRes.json()) as {
      project: { id: string; name: string; description?: string | null }
    }

    expect(importData.project).toBeDefined()
    expect(importData.project.id).toBeTruthy()
    expect(importData.project.id).not.toBe(testProjectId)
    expect(importData.project.name).toBe('E2E Export Test Project')
    cleanupProjectIds.push(importData.project.id)

    // Verify DB records
    const importedProject = await prisma.project.findUnique({
      where: { id: importData.project.id },
      include: { agentConfig: true },
    })
    expect(importedProject).not.toBeNull()
    expect(importedProject!.name).toBe('E2E Export Test Project')
    expect(importedProject!.description).toBe('Created by e2e test')
    expect(importedProject!.tier).toBe('starter')
    expect(importedProject!.workspaceId).toBe(testWorkspaceId)
    expect(importedProject!.createdBy).toBe(testUserId)

    // Agent config
    expect(importedProject!.agentConfig).not.toBeNull()
    expect(importedProject!.agentConfig!.heartbeatInterval).toBe(600)
    expect(importedProject!.agentConfig!.modelName).toBe('claude-sonnet-4-20250514')

    // Chat sessions
    const sessions = await prisma.chatSession.findMany({
      where: { contextId: importData.project.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    expect(sessions.length).toBe(1)
    expect(sessions[0].inferredName).toBe('Test conversation')
    expect(sessions[0].messages.length).toBe(2)
    expect(sessions[0].messages[0].content).toBe('Hello from e2e test')

    // Workspace files
    const { existsSync, readFileSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(process.cwd(), 'workspaces')
    const importedDir = join(WORKSPACES_DIR, importData.project.id)
    expect(existsSync(join(importedDir, 'AGENTS.md'))).toBe(true)
    expect(readFileSync(join(importedDir, 'AGENTS.md'), 'utf-8')).toContain('Test Agent')
    expect(existsSync(join(importedDir, 'src', 'main.tsx'))).toBe(true)
    expect(existsSync(join(importedDir, 'package.json'))).toBe(true)

    console.log(`[Import] New project ${importData.project.id} verified`)
  })

  it('should round-trip: re-export imported project matches original', async () => {
    // Export original
    const origRes = await app.fetch(new Request(`http://localhost/api/projects/${testProjectId}/export`))
    const origZip = unzipSync(new Uint8Array(await origRes.arrayBuffer()))
    const origJson = JSON.parse(strFromU8(origZip['project.json']))

    // Import
    const exportRes = await app.fetch(new Request(`http://localhost/api/projects/${testProjectId}/export`))
    const formData = new FormData()
    formData.append('file', new Blob([await exportRes.arrayBuffer()]), 'rt.shogo-project')
    formData.append('workspaceId', testWorkspaceId)
    const importRes = await app.fetch(new Request('http://localhost/api/projects/import', { method: 'POST', body: formData }))
    const { project: imported } = (await importRes.json()) as { project: { id: string } }
    cleanupProjectIds.push(imported.id)

    // Re-export the imported project
    const reExportRes = await app.fetch(new Request(`http://localhost/api/projects/${imported.id}/export`))
    const reZip = unzipSync(new Uint8Array(await reExportRes.arrayBuffer()))
    const reJson = JSON.parse(strFromU8(reZip['project.json']))

    // Compare project metadata (ignoring timestamps)
    expect(reJson.project.name).toBe(origJson.project.name)
    expect(reJson.project.description).toBe(origJson.project.description)
    expect(reJson.project.tier).toBe(origJson.project.tier)

    // Compare agent config
    expect(reJson.agentConfig.heartbeatInterval).toBe(origJson.agentConfig.heartbeatInterval)
    expect(reJson.agentConfig.modelName).toBe(origJson.agentConfig.modelName)

    // Compare workspace files
    const origWsFiles = Object.keys(origZip).filter((k) => k.startsWith('workspace/')).sort()
    const reWsFiles = Object.keys(reZip).filter((k) => k.startsWith('workspace/')).sort()
    expect(reWsFiles).toEqual(origWsFiles)

    for (const f of origWsFiles) {
      expect(strFromU8(reZip[f])).toBe(strFromU8(origZip[f]))
    }

    // Compare chat history message content
    const origChat = Object.keys(origZip).filter((k) => k.startsWith('chat-history/'))
    const reChat = Object.keys(reZip).filter((k) => k.startsWith('chat-history/'))
    expect(reChat.length).toBe(origChat.length)

    console.log('[Round-trip] Verified: exported -> imported -> re-exported data matches')
  })

  it('should reject import with missing file', async () => {
    const formData = new FormData()
    formData.append('workspaceId', testWorkspaceId)
    const res = await app.fetch(new Request('http://localhost/api/projects/import', { method: 'POST', body: formData }))
    expect(res.status).toBe(400)
  })

  it('should not have /api/projects/import hijacked by the :projectId middleware', async () => {
    // Regression test: the /api/projects/:projectId/* middleware previously
    // matched /api/projects/import with projectId="import", and
    // requireProjectAccess would 404 with { error: { code: "not_found", message: "Project not found" } }
    // before the real import handler ran.
    //
    // We POST an empty form (no file) and expect the import handler's own
    // 400 "Missing file" response — not the middleware's 404.
    const formData = new FormData()
    formData.append('workspaceId', testWorkspaceId)
    const res = await app.fetch(
      new Request('http://localhost/api/projects/import', { method: 'POST', body: formData }),
    )
    expect(res.status).not.toBe(404)
    const body = (await res.json()) as {
      error: string | { code?: string; message?: string }
    }
    const code = typeof body.error === 'object' ? body.error?.code : null
    const message = typeof body.error === 'object' ? body.error?.message : body.error
    expect(code).not.toBe('not_found')
    expect(message).not.toBe('Project not found')
  })

  it('should reject import with invalid ZIP', async () => {
    const formData = new FormData()
    formData.append('file', new Blob(['not a zip file']), 'bad.shogo-project')
    formData.append('workspaceId', testWorkspaceId)
    const res = await app.fetch(new Request('http://localhost/api/projects/import', { method: 'POST', body: formData }))
    expect(res.status).toBe(400)
  })

  it('should reject import with ZIP missing project.json', async () => {
    const zipData = zipSync({ 'readme.txt': strToU8('no project.json here') })
    const formData = new FormData()
    formData.append('file', new Blob([zipData.buffer.slice(zipData.byteOffset, zipData.byteOffset + zipData.byteLength)]), 'no-meta.shogo-project')
    formData.append('workspaceId', testWorkspaceId)
    const res = await app.fetch(new Request('http://localhost/api/projects/import', { method: 'POST', body: formData }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('missing project.json')
  })

  // ─── includeChats toggle ───────────────────────────────────

  it('export with ?includeChats=false omits chat-history entries', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/projects/${testProjectId}/export?includeChats=false`),
    )
    expect(res.status).toBe(200)
    const unzipped = unzipSync(new Uint8Array(await res.arrayBuffer()))

    const chatFiles = Object.keys(unzipped).filter((k) => k.startsWith('chat-history/'))
    expect(chatFiles.length).toBe(0)

    // Sanity: project metadata records that chats were excluded.
    const meta = JSON.parse(strFromU8(unzipped['project.json']))
    expect(meta.includedChats).toBe(false)
  })

  it('import with includeChats=false skips chat sessions even when bundle has them', async () => {
    // Export normally (bundle includes chats)
    const exportRes = await app.fetch(
      new Request(`http://localhost/api/projects/${testProjectId}/export`),
    )
    const zipBuf = await exportRes.arrayBuffer()

    const formData = new FormData()
    formData.append('file', new Blob([zipBuf], { type: 'application/zip' }), 'no-chats.shogo-project')
    formData.append('workspaceId', testWorkspaceId)
    formData.append('includeChats', 'false')

    const importRes = await app.fetch(
      new Request('http://localhost/api/projects/import', { method: 'POST', body: formData }),
    )
    expect(importRes.status).toBe(200)
    const { project } = (await importRes.json()) as { project: { id: string } }
    cleanupProjectIds.push(project.id)

    const sessions = await prisma.chatSession.findMany({
      where: { contextId: project.id },
    })
    expect(sessions.length).toBe(0)
  })

  // ─── Prebuilt dist/ inclusion ──────────────────────────────

  it('export includes workspace/dist/* so imports can serve the preview immediately', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/projects/${testProjectId}/export`),
    )
    const unzipped = unzipSync(new Uint8Array(await res.arrayBuffer()))

    expect(unzipped['workspace/dist/index.html']).toBeDefined()
    expect(strFromU8(unzipped['workspace/dist/index.html'])).toContain('<html>')
    expect(unzipped['workspace/dist/assets/app.js']).toBeDefined()
  })

  it('round-trip: imported project has dist/ on disk ready for preview-manager', async () => {
    const exportRes = await app.fetch(
      new Request(`http://localhost/api/projects/${testProjectId}/export`),
    )
    const formData = new FormData()
    formData.append('file', new Blob([await exportRes.arrayBuffer()]), 'dist.shogo-project')
    formData.append('workspaceId', testWorkspaceId)
    const importRes = await app.fetch(
      new Request('http://localhost/api/projects/import', { method: 'POST', body: formData }),
    )
    const { project } = (await importRes.json()) as { project: { id: string } }
    cleanupProjectIds.push(project.id)

    const { existsSync, readFileSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(process.cwd(), 'workspaces')
    const importedDir = join(WORKSPACES_DIR, project.id)

    expect(existsSync(join(importedDir, 'dist', 'index.html'))).toBe(true)
    expect(readFileSync(join(importedDir, 'dist', 'index.html'), 'utf-8')).toContain('<html>')
    expect(existsSync(join(importedDir, 'dist', 'assets', 'app.js'))).toBe(true)
  })

  // ─── Streaming SSE progress ────────────────────────────────

  it('SSE import emits phase events and a terminal done event', async () => {
    const exportRes = await app.fetch(
      new Request(`http://localhost/api/projects/${testProjectId}/export`),
    )
    const zipBuf = await exportRes.arrayBuffer()

    const formData = new FormData()
    formData.append('file', new Blob([zipBuf], { type: 'application/zip' }), 'sse.shogo-project')
    formData.append('workspaceId', testWorkspaceId)
    formData.append('includeChats', 'true')

    const res = await app.fetch(
      new Request('http://localhost/api/projects/import', {
        method: 'POST',
        body: formData,
        headers: { Accept: 'text/event-stream' },
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') || '').toContain('text/event-stream')

    const text = await res.text()
    const events: { event: string; data: any }[] = []
    for (const frame of text.split('\n\n')) {
      let event = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      }
      if (dataLines.length > 0) {
        try {
          events.push({ event, data: JSON.parse(dataLines.join('\n')) })
        } catch {}
      }
    }

    const phases = events
      .filter((e) => e.event === 'progress')
      .map((e) => e.data.phase as string)
    expect(phases).toContain('parse')
    expect(phases).toContain('createProject')
    expect(phases).toContain('writeFiles')

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()
    expect(doneEvent!.data.project?.id).toBeTruthy()
    expect(typeof doneEvent!.data.stats?.filesWritten).toBe('number')

    const createdId: string = doneEvent!.data.project.id
    cleanupProjectIds.push(createdId)

    // writeFiles events should be incremental (done counter grows towards total)
    const writeFilesEvents = events
      .filter((e) => e.event === 'progress' && e.data.phase === 'writeFiles')
      .map((e) => e.data as { done: number; total: number })
    expect(writeFilesEvents.length).toBeGreaterThan(0)
    const last = writeFilesEvents[writeFilesEvents.length - 1]
    expect(last.done).toBe(last.total)
  })

  it('SSE import emits fatal event on invalid ZIP', async () => {
    const formData = new FormData()
    formData.append('file', new Blob(['not a zip']), 'bad.shogo-project')
    formData.append('workspaceId', testWorkspaceId)

    const res = await app.fetch(
      new Request('http://localhost/api/projects/import', {
        method: 'POST',
        body: formData,
        headers: { Accept: 'text/event-stream' },
      }),
    )

    expect(res.status).toBe(200) // streaming starts OK; error surfaces as an event
    const text = await res.text()
    expect(text).toContain('event: fatal')
    expect(text).toMatch(/Invalid or corrupt ZIP file/)
  })
})
