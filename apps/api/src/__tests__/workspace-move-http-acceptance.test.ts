// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-246 acceptance: a real move, over real HTTP, against a real SQLite
 * database built from the desktop migration history.
 *
 * The service tests stub the transport, so they cannot see a route that
 * authorises the wrong workspace, an NDJSON chunk that does not survive the
 * wire, a file that never arrives because the ignore rules disagreed between
 * the plan and the runner, or a resumed job that re-collects its rows with
 * different privileges than the plan it showed the user.
 *
 * Both ends are the same app instance here (source and target are two
 * workspaces in one database) but every call between them goes through
 * `Bun.serve` + `fetch`, i.e. the same `HttpMoveSource` / `HttpMoveTarget` a
 * desktop uses to talk to Shogo Cloud.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupChannelsTestDb, waitFor } from './helpers/channels-test-db'

// Must run before anything imports lib/prisma.
const { dir: dbDir } = setupChannelsTestDb()

const filesDir = mkdtempSync(join(tmpdir(), 'sho246-e2e-'))
const restoreEnv = {
  WORKSPACES_DIR: process.env.WORKSPACES_DIR,
  SHOGO_API_KEY: process.env.SHOGO_API_KEY,
  SHOGO_API_URL: process.env.SHOGO_API_URL,
}
process.env.WORKSPACES_DIR = filesDir
process.env.SHOGO_API_KEY = 'shogo_sk_qa_test'

const { Hono } = await import('hono')
const { prisma } = await import('../lib/prisma')
const { workspaceMoveRoutes } = await import('../routes/workspace-moves')
const { deriveMoveId } = await import('../services/workspace-move/ids')

let principalUserId = ''
const app = new Hono()
app.use('*', async (c, next) => {
  c.set('auth', { userId: principalUserId, isAuthenticated: true, via: 'session' } as any)
  await next()
})
app.route('/api/workspace-moves', workspaceMoveRoutes())

const server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) })
process.env.SHOGO_API_URL = `http://127.0.0.1:${server.port}`

const ids = {
  owner: 'u-owner-246',
  admin: 'u-admin-246',
  stranger: 'u-stranger-246',
  workspace: 'ws-246',
  otherWorkspace: 'ws-246-other',
  project: 'p-246',
  otherProject: 'p-246-other',
  channel: 'c-246-main',
  otherChannel: 'c-246-other',
  dm: 'c-246-dm',
  board: 'b-246',
  otherBoard: 'b-246-other',
  column: 'col-246',
  schedule: 'sched-246',
  trigger: 'trig-246',
}

const derived = (sourceId: string, moveId: string) => deriveMoveId(moveId, sourceId)

async function seed() {
  await prisma.user.create({ data: { id: ids.owner, email: 'owner246@example.com', name: 'Owner' } as any })
  await prisma.user.create({ data: { id: ids.admin, email: 'admin246@example.com', name: 'Admin' } as any })
  await prisma.user.create({ data: { id: ids.stranger, email: 'stranger246@example.com', name: 'Stranger' } as any })

  await prisma.workspace.create({
    data: { id: ids.workspace, name: 'Content Studio', slug: 'content-246', kind: 'team' } as any,
  })
  await prisma.workspace.create({
    data: { id: ids.otherWorkspace, name: 'Someone else', slug: 'other-246', kind: 'team' } as any,
  })
  await prisma.member.create({ data: { userId: ids.owner, workspaceId: ids.workspace, role: 'owner' } as any })
  await prisma.member.create({ data: { userId: ids.admin, workspaceId: ids.workspace, role: 'admin' } as any })

  await prisma.project.create({ data: { id: ids.project, workspaceId: ids.workspace, name: 'Reel' } as any })
  await prisma.project.create({ data: { id: ids.otherProject, workspaceId: ids.workspace, name: 'Unrelated' } as any })

  await prisma.conversation.create({
    data: { id: ids.channel, workspaceId: ids.workspace, kind: 'public', name: 'content', slug: 'content' } as any,
  })
  await prisma.conversation.create({
    data: { id: ids.otherChannel, workspaceId: ids.workspace, kind: 'public', name: 'ops', slug: 'ops' } as any,
  })
  // A DM the admin is not a member of: the plan says it stays behind.
  await prisma.conversation.create({
    data: { id: ids.dm, workspaceId: ids.workspace, kind: 'dm', name: null, dmKey: 'owner|stranger' } as any,
  })
  await prisma.conversationMember.create({ data: { conversationId: ids.dm, userId: ids.owner } as any })
  await prisma.conversationMember.create({ data: { conversationId: ids.dm, userId: ids.stranger } as any })

  await prisma.board.create({
    data: { id: ids.board, workspaceId: ids.workspace, conversationId: ids.channel, name: 'Content', slug: 'content-board', keyPrefix: 'CON' } as any,
  })
  await prisma.board.create({
    data: { id: ids.otherBoard, workspaceId: ids.workspace, conversationId: ids.otherChannel, name: 'Ops', slug: 'ops-board', keyPrefix: 'OPS' } as any,
  })
  await prisma.boardColumn.create({ data: { id: ids.column, boardId: ids.board, name: 'Active', category: 'active' } as any })
  await prisma.workItem.create({
    data: {
      id: 'wi-246',
      workspaceId: ids.workspace,
      boardId: ids.board,
      columnId: ids.column,
      key: 'CON-1',
      number: 1,
      title: 'Ship the reel',
    } as any,
  })
  await prisma.workItem.create({
    data: {
      id: 'wi-246-other',
      workspaceId: ids.workspace,
      boardId: ids.otherBoard,
      columnId: ids.column,
      key: 'OPS-1',
      number: 1,
      title: 'Rotate the key',
    } as any,
  })

  await prisma.agentSchedule.create({
    data: {
      id: ids.schedule,
      workspaceId: ids.workspace,
      userId: ids.owner,
      name: 'Daily reel',
      prompt: 'make a reel',
      cronExpression: '0 9 * * *',
      nextRunAt: new Date(Date.now() + 86_400_000),
      enabled: true,
      notifyConversationId: ids.channel,
    } as any,
  })
  await prisma.eventSubscription.create({
    data: {
      id: ids.trigger,
      workspaceId: ids.workspace,
      name: 'On comment',
      eventType: 'comment.created',
      enabled: true,
      notifyConversationId: ids.channel,
    } as any,
  })

  // Project files, including the three trees a move must never carry.
  const projectDir = join(filesDir, ids.project)
  mkdirSync(join(projectDir, 'posts'), { recursive: true })
  mkdirSync(join(projectDir, 'out'), { recursive: true })
  mkdirSync(join(projectDir, '.tmp'), { recursive: true })
  writeFileSync(join(projectDir, 'posts', 'reel.md'), '# reel\n')
  writeFileSync(join(projectDir, 'out', 'render.mp4'), 'x'.repeat(4096))
  writeFileSync(join(projectDir, '.tmp', 'scratch.bin'), 'y'.repeat(4096))
  writeFileSync(join(projectDir, 'notes.txt'), 'keep me\n')
  writeFileSync(join(filesDir, ids.otherProject), 'not a dir\n')
}

async function call(path: string, body?: unknown, method = 'POST') {
  const suffix = path === '/' ? '' : path
  const res = await fetch(`${process.env.SHOGO_API_URL}/api/workspace-moves${suffix}`, {
    method: body === undefined && method === 'POST' ? 'POST' : method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 400) }
  }
  return { status: res.status, json }
}

beforeAll(async () => {
  await seed()
  principalUserId = ids.owner
})

afterAll(() => {
  server.stop(true)
})

describe('SHO-246 acceptance', () => {
  test('AC2: a partial selection carries the closure and nothing else', async () => {
    const { status, json } = await call('/plan', {
      workspaceId: ids.workspace,
      direction: 'desktop_to_cloud',
      targetKind: 'cloud',
      selection: { mode: 'selected', conversationIds: [ids.channel], projectIds: [ids.project] },
    })
    expect(status).toBe(200)
    const models = new Map<string, number>(json.plan.models.map((m: any) => [m.model, m.rows]))
    expect(models.get('Conversation')).toBe(1)
    expect(models.get('Board')).toBe(1)
    expect(models.get('WorkItem')).toBe(1)
    expect(models.get('AgentSchedule')).toBe(1)
    expect(models.get('EventSubscription')).toBe(1)
    expect(json.plan.selection.conversations.map((c: any) => c.id)).toEqual([ids.channel])
    // The unrelated project's bytes are not in the move.
    expect(json.plan.projects.map((p: any) => p.id)).toEqual([ids.project])
  })

  test('AC4: the plan reports what the ignore rules save', async () => {
    const { json } = await call('/plan', {
      workspaceId: ids.workspace,
      direction: 'desktop_to_cloud',
      selection: { mode: 'selected', projectIds: [ids.project] },
    })
    expect(json.plan.totals.files).toBe(2) // notes.txt + posts/reel.md
    expect(json.plan.totals.filesIgnored).toBeGreaterThanOrEqual(2) // out/, .tmp/
    expect(json.plan.totals.bytesIgnored).toBeGreaterThan(8000)
  })

  test('AC1/AC3/AC5/AC11: a full move over HTTP lands rows, files and a quiet handover', async () => {
    const started = await call('/', {
      workspaceId: ids.workspace,
      direction: 'cloud_to_desktop',
      targetKind: 'desktop',
      selection: { mode: 'all' },
    })
    if (started.status !== 201) console.error('START BODY', JSON.stringify(started.json))
    expect(started.status).toBe(201)
    const moveId = started.json.move.id

    const done = await waitFor(async () => {
      const { json } = await call(`/${moveId}`, undefined, 'GET')
      if (json.move?.status === 'failed') throw new Error(`move failed: ${json.move.error}`)
      return json.move?.status === 'done' ? json.move : null
    }, 30_000)

    const targetId = done.targetWorkspaceId as string
    expect(targetId).toBeTruthy()

    // AC11: the source is still there, unchanged apart from the handover state.
    expect(await prisma.workspace.findUnique({ where: { id: ids.workspace } })).toBeTruthy()

    // Rows landed under derived ids, in the new workspace.
    const board = await prisma.board.findUnique({ where: { id: derived(ids.board, moveId) } })
    expect(board?.workspaceId).toBe(targetId)
    const card = await prisma.workItem.findUnique({ where: { id: derived('wi-246', moveId) } })
    expect(card?.boardId).toBe(derived(ids.board, moveId))
    expect(card?.columnId).toBe(derived(ids.column, moveId))

    // AC5 step 1: nothing that runs on a timer arrives enabled.
    const targetSchedule = await prisma.agentSchedule.findUnique({ where: { id: derived(ids.schedule, moveId) } })
    expect(targetSchedule?.enabled).toBe(false)
    const targetTrigger = await prisma.eventSubscription.findUnique({ where: { id: derived(ids.trigger, moveId) } })
    expect(targetTrigger?.enabled).toBe(false)
    // ... and the source is still live, so nothing ran twice and nothing stopped early.
    expect((await prisma.agentSchedule.findUnique({ where: { id: ids.schedule } }))?.enabled).toBe(true)

    // AC4: the ignored trees did not cross, the rest did.
    const { existsSync, readFileSync } = await import('node:fs')
    // The target project gets a derived id, so its directory is a different
    // path from the source's — asserting on the source id would pass for free.
    const targetDir = join(filesDir, derived(ids.project, moveId))
    expect(targetDir).not.toBe(join(filesDir, ids.project))
    expect(existsSync(join(targetDir, 'notes.txt'))).toBe(true)
    expect(readFileSync(join(targetDir, 'posts', 'reel.md'), 'utf8')).toBe('# reel\n')
    expect(existsSync(join(targetDir, 'out', 'render.mp4'))).toBe(false)
    expect(existsSync(join(targetDir, '.tmp', 'scratch.bin'))).toBe(false)
    // AC11: the source kept its own copy, ignored trees and all.
    expect(existsSync(join(filesDir, ids.project, 'out', 'render.mp4'))).toBe(true)

    // AC5 step 2: switch over disables the source and enables the target.
    const switched = await call(`/${moveId}/switch-over`)
    expect(switched.status).toBe(200)
    expect((await prisma.agentSchedule.findUnique({ where: { id: ids.schedule } }))?.enabled).toBe(false)
    expect((await prisma.agentSchedule.findUnique({ where: { id: derived(ids.schedule, moveId) } }))?.enabled).toBe(true)
    expect((await prisma.eventSubscription.findUnique({ where: { id: ids.trigger } }))?.enabled).toBe(false)
    expect((await prisma.eventSubscription.findUnique({ where: { id: derived(ids.trigger, moveId) } }))?.enabled).toBe(true)
    // AC11: the source is marked, not deleted.
    const source = await prisma.workspace.findUnique({ where: { id: ids.workspace } })
    expect((source as any)?.movedToWorkspaceId).toBe(targetId)

    // AC5 step 3: switch back reverses it.
    const back = await call(`/${moveId}/switch-back`)
    expect(back.status).toBe(200)
    expect((await prisma.agentSchedule.findUnique({ where: { id: ids.schedule } }))?.enabled).toBe(true)
    expect((await prisma.agentSchedule.findUnique({ where: { id: derived(ids.schedule, moveId) } }))?.enabled).toBe(false)
    expect((await prisma.workspace.findUnique({ where: { id: ids.workspace } }) as any)?.movedToWorkspaceId).toBe(null)
  }, 60_000)

  test('AC5: a workspace with no automations still finishes the move and switches over', async () => {
    // The common case, and the one this suite's own fixture hid: a workspace
    // with no schedules and no triggers. The handover phase used to throw
    // `.map is not a function` here, because the SQLite Json column returns an
    // empty array as the string "[]" — so the move failed at its last phase
    // with the target already fully populated.
    const bare = { workspace: 'ws-246-bare', project: 'p-246-bare' }
    await prisma.workspace.create({
      data: { id: bare.workspace, name: 'No automations', slug: 'bare-246', kind: 'team' } as any,
    })
    await prisma.member.create({ data: { userId: ids.owner, workspaceId: bare.workspace, role: 'owner' } as any })
    await prisma.project.create({ data: { id: bare.project, workspaceId: bare.workspace, name: 'Bare' } as any })
    mkdirSync(join(filesDir, bare.project), { recursive: true })
    writeFileSync(join(filesDir, bare.project, 'readme.md'), '# bare\n')

    // The premise of the test: nothing runs on a timer in this workspace.
    expect(await prisma.agentSchedule.count({ where: { workspaceId: bare.workspace } })).toBe(0)
    expect(await prisma.eventSubscription.count({ where: { workspaceId: bare.workspace } })).toBe(0)

    const started = await call('/', {
      workspaceId: bare.workspace,
      direction: 'cloud_to_desktop',
      targetKind: 'desktop',
      selection: { mode: 'all' },
    })
    if (started.status !== 201) console.error('BARE START BODY', JSON.stringify(started.json))
    expect(started.status).toBe(201)
    const moveId = started.json.move.id as string

    const done = await waitFor(async () => {
      const { json } = await call(`/${moveId}`, undefined, 'GET')
      if (json.move?.status === 'failed') throw new Error(`move failed: ${json.move.error}`)
      return json.move?.status === 'done' ? json.move : null
    }, 30_000)
    expect(done.targetWorkspaceId).toBeTruthy()

    // The handover ran and recorded an empty row set instead of crashing.
    const row = (await prisma.workspaceMove.findUnique({ where: { id: moveId } })) as any
    expect(row?.handover).toBeTruthy()
    expect(row?.status).toBe('done')

    // AC5 on the empty set: switch over and back must work with nothing to flip.
    const switched = await call(`/${moveId}/switch-over`)
    if (switched.status !== 200) console.error('BARE SWITCH BODY', JSON.stringify(switched.json))
    expect(switched.status).toBe(200)
    expect((await prisma.workspace.findUnique({ where: { id: bare.workspace } }) as any)?.movedToWorkspaceId).toBe(
      done.targetWorkspaceId,
    )

    const back = await call(`/${moveId}/switch-back`)
    expect(back.status).toBe(200)
    expect((await prisma.workspace.findUnique({ where: { id: bare.workspace } }) as any)?.movedToWorkspaceId).toBe(null)

    // The move was a real one, not an empty run: the file crossed under the
    // target project's derived id.
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(filesDir, derived(bare.project, moveId), 'readme.md'))).toBe(true)
  }, 60_000)

  test('AC1: re-running the files phase sends nothing that already landed', async () => {
    const { sourceFileManifest } = await import('../services/workspace-move/serve')
    const { targetFileManifest } = await import('../services/workspace-move/receive')
    const { diffFileManifest } = await import('../services/workspace-move/files')
    const source = await sourceFileManifest(prisma, { workspaceId: ids.workspace, projectId: ids.project })
    const target = await targetFileManifest(ids.project, filesDir)
    const diff = diffFileManifest(source.entries, target.entries)
    expect(diff.toSend).toEqual([])
    expect(diff.skipped).toBe(source.entries.length)
  })

  test('AC2: a resumed move runs as the identity the plan was built for, not as the owner', async () => {
    const { collectMoveRows } = await import('../services/workspace-move/plan')
    // An admin (not the owner) starts the move: DMs they are not in stay behind.
    const previous = principalUserId
    principalUserId = ids.admin
    try {
      const started = await call('/', {
        workspaceId: ids.workspace,
        direction: 'cloud_to_desktop',
        targetKind: 'desktop',
        selection: { mode: 'all' },
      })
      expect(started.status).toBe(201)

      // The identity is persisted on the row, so the restart sweep and
      // `POST /:id/resume` (which have no request context) read it back.
      const move = await prisma.workspaceMove.findUnique({ where: { id: started.json.move.id } })
      expect(move?.requesterId).toBe(ids.admin)
      expect(move?.isOwner).toBe(false)
      expect(move?.ownerUserId).toBe(ids.admin)

      const idsOf = (result: any) => (result.rows.get('Conversation') ?? []).map((row: any) => row.id)
      const asPlan = await collectMoveRows({
        workspaceId: ids.workspace,
        requesterId: move!.requesterId!,
        isOwner: move!.isOwner!,
        selection: { mode: 'all' },
        db: prisma,
      })
      expect(idsOf(asPlan)).not.toContain(ids.dm)

      // ...and the old `requesterId: '' / isOwner: true` fallback is what would
      // have widened the closure on a resume. Kept as the regression marker.
      const asOldFallback = await collectMoveRows({
        workspaceId: ids.workspace,
        requesterId: '',
        isOwner: true,
        selection: { mode: 'all' },
        db: prisma,
      })
      expect(idsOf(asOldFallback)).toContain(ids.dm)
      expect(idsOf(asOldFallback)).not.toEqual(idsOf(asPlan))
    } finally {
      principalUserId = previous
    }
  })

  test('the workspace-root pseudo-project a move walks is not silently empty', async () => {
    const { WORKSPACE_ROOT_ID } = await import('../services/workspace-move/plan')
    const { sourceFileManifest } = await import('../services/workspace-move/serve')
    // Put a file where a workspace root would live, then ask the source for its
    // manifest the way `runMove` does.
    const rootDir = join(filesDir, '.workspace-roots', ids.workspace)
    mkdirSync(rootDir, { recursive: true })
    writeFileSync(join(rootDir, 'workspace-state.json'), '{"a":1}\n')
    const manifest = await sourceFileManifest(prisma, { workspaceId: ids.workspace, projectId: WORKSPACE_ROOT_ID })
    expect(manifest.entries.map((entry) => entry.path)).toContain('workspace-state.json')
  })
})

afterAll(async () => {
  server.stop(true)
  await prisma.$disconnect()
  rmSync(filesDir, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(restoreEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
