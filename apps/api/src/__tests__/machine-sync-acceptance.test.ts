// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for desktop → cloud sync (SHO-276 AC1-AC4, revised for the
 * SHO-285 hosted-workspace model: AC4 skips hosted workspaces, AC5 no longer prunes).
 *
 * The unit suites pin each rule against fakes. These run the real join: the
 * desktop's `MachineSyncPusher` posts through the real `/api/machines/:id/sync`
 * route into the real `applyBatch` and a real Postgres database (the cloud
 * schema, not the desktop's), and the real `chat-turn-reattach` sweep reads real
 * rows. A fix that is right on each side but still cannot finish a snapshot — or
 * still lets the cloud write into the copy — fails here.
 *
 * Both halves share one Prisma client in this process, which a real deployment
 * never does. `freezeDesktop()` makes the desktop's reads see only the rows that
 * existed when its run started, so ingest's own writes cannot leak back into the
 * next page as rows the machine "sent".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { setupChannelsTestDb } from './helpers/channels-test-db'
import type { SyncBatchRequest } from '../lib/machine-sync/pusher'

const { dir } = setupChannelsTestDb()

// The cloud half needs the cloud's schema, so this suite runs where a real
// Postgres does: the `RBAC (Postgres)` job in CI, or CHANNELS_TEST_PG_URL
// locally. On SQLite it would be testing a database shape the cloud never has.
const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REQUIRED = process.env.CI_REQUIRE_MACHINE_INFRA === '1'
if (REQUIRED && !PG_URL) throw new Error('SHO-276 acceptance needs CHANNELS_TEST_PG_URL')
const describeIfPg = PG_URL ? describe : describe.skip

const { prisma } = await import('../lib/prisma')
const { machineRoutes } = await import('../routes/machines')
const { MachineSyncPusher } = await import('../lib/machine-sync/pusher')
const { resolveInstanceIdentity } = await import('../lib/instance-identity')
const { reattachStaleTurns } = await import('../jobs/chat-turn-reattach')
const resume = await import('../services/chat-resume.service')
const dispatcher = await import('../services/chat-queue-dispatcher.service')
const hostedWorkspace = await import('../lib/hosted-workspace')

const db = prisma as any
const suffix = crypto.randomUUID().slice(0, 8)
const OWNER = `owner-${suffix}`
const HOME = `home-${suffix}`
const DEVICE = `device-${suffix}`
const INSTANCE = `inst-${suffix}`
const BIG = 'x'.repeat(500_000)
const CHAT_ROWS = 40 // ≈ 20 MB of chat messages

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Seen {
  sizes: number[]
  batches: SyncBatchRequest[]
  statuses: number[]
}

/**
 * The cloud as the desktop sees it: the real route on a Hono app, reached
 * through the pusher's own `fetchImpl`, with the device key already resolved.
 */
function cloud(seen: Seen, opts: { failFirstChatPage?: boolean } = {}) {
  const app = new Hono()
  app.use('/api/*', async (c, next) => {
    c.set('auth', { userId: OWNER, workspaceId: HOME, isAuthenticated: true, via: 'apiKey' })
    await next()
  })
  app.route('/api', machineRoutes())
  let failed = false

  return (async (url: string, init: any) => {
    const body = String(init?.body ?? '')
    const batch = JSON.parse(body) as SyncBatchRequest
    seen.sizes.push(body.length)
    seen.batches.push(batch)

    if (opts.failFirstChatPage && !failed && batch.mode === 'snapshot' && batch.models.some((m) => m.model === 'ChatMessage')) {
      failed = true
      seen.statuses.push(504)
      return new Response('gateway timeout', { status: 504 })
    }

    const res = await app.request(url, { method: init?.method ?? 'POST', headers: init?.headers, body })
    const text = await res.text()
    seen.statuses.push(res.status)
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

/**
 * Mark every row as the machine's own.
 *
 * A real machine has already sent most of its database before a run is
 * interrupted; the cloud holds those rows and `applyBatch` refuses a row that
 * exists and belongs to someone else. Ownership is per machine, so declaring the
 * fixture's rows the machine's is what makes a second snapshot (or a re-sent
 * page) legal — the ownership rule itself is SHO-241's suite. Since SHO-285 a
 * desktop may only write workspaces it hosts, so the fixture's workspaces are
 * claimed as hosted on this machine too.
 */
async function ownEverything() {
  await db.workspace.updateMany({ where: { hostInstanceId: null }, data: { hostInstanceId: INSTANCE } })
  hostedWorkspace.invalidateHostedWorkspaceIds()
  const { delegateName, MIRROR_MODELS } = await import('../lib/machine-sync/models')
  for (const model of MIRROR_MODELS) {
    const delegate = db[delegateName(model)]
    if (!delegate?.findMany) continue
    const rows: Array<{ id: string }> = await delegate.findMany({ select: { id: true } })
    if (!rows.length) continue
    const owned = new Set(
      (await db.machineMirrorRow.findMany({ where: { model }, select: { recordId: true } })).map(
        (row: any) => row.recordId,
      ),
    )
    const mine = rows.filter((row) => !owned.has(row.id))
    if (mine.length) {
      await db.machineMirrorRow.createMany({
        data: mine.map((row) => ({ model, recordId: row.id, instanceId: INSTANCE })),
      })
    }
  }
}

/** The desktop's database, frozen at the moment the run starts. */
async function freezeDesktop(): Promise<any> {
  const { delegateName, MIRROR_MODELS } = await import('../lib/machine-sync/models')
  const ids = new Map<string, Set<string>>()
  for (const model of MIRROR_MODELS) {
    const delegate = db[delegateName(model)]
    if (!delegate?.findMany) continue
    const rows: Array<{ id: string }> = await delegate.findMany({ select: { id: true } })
    ids.set(model, new Set(rows.map((row) => row.id)))
  }
  const known = new Map<string, Set<string>>()
  for (const [model, set] of ids) known.set(delegateName(model), set)

  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        const real = db[prop]
        if (!real) return real
        const mine = known.get(prop)
        if (!mine) return real
        return new Proxy(real, {
          get(delegate, key: string) {
            if (key !== 'findMany') {
              const value = (delegate as any)[key]
              return typeof value === 'function' ? value.bind(delegate) : value
            }
            return async (args: any = {}) => {
              const take = args.take ?? 100
              const rows: Array<{ id: string }> = await (delegate as any).findMany({ ...args, take: take * 50 })
              return rows.filter((row) => mine.has(row.id)).slice(0, take)
            }
          },
        })
      },
    },
  )
}

function pusherFor(fetchImpl: typeof fetch, prisma: any = db) {
  return new MachineSyncPusher({
    prisma,
    getCloudUrl: () => 'http://cloud.test',
    getApiKey: () => 'shogo_sk_test',
    getInstanceId: () => INSTANCE,
    fetchImpl,
  })
}

async function drain(pusher: any, maxTicks = 80) {
  for (let tick = 0; tick < maxTicks; tick++) {
    await pusher.tick()
    const state = await db.machineSyncState.findFirst({ where: { instanceId: INSTANCE } })
    if (state?.lastIngestAt) return true
  }
  return false
}

/** A desktop workspace with a channel, a chat turn and a lot of messages. */
async function seedDesktop(tag: string) {
  const user = await db.user.create({ data: { name: tag, email: `${tag}-${suffix}@example.com` } })
  const ws = await db.workspace.create({ data: { name: `${tag} team`, slug: `${tag}-${suffix}`, kind: 'team' } })
  const project = await db.project.create({ data: { name: `${tag} project`, workspaceId: ws.id } })
  const conversation = await db.conversation.create({
    data: { workspaceId: ws.id, name: `#general-${tag}`, slug: `general-${tag}` },
  })
  const message = await db.conversationMessage.create({
    data: { conversationId: conversation.id, workspaceId: ws.id, seq: 1, text: 'hello from the desktop' },
  })
  const session = await db.chatSession.create({
    data: {
      name: `${tag} chat`,
      inferredName: `${tag} chat`,
      contextType: 'workspace',
      workspaceId: ws.id,
      createdByUserId: user.id,
      // A turn that looks abandoned in the cloud's view: the desktop owns it.
      activeTurnId: `turn-${tag}`,
      activeTurnStartedAt: new Date(Date.now() - 10 * 60_000),
      activeTurnHeartbeatAt: new Date(Date.now() - 9 * 60_000),
    },
  })
  for (let index = 0; index < CHAT_ROWS; index++) {
    await db.chatMessage.create({
      data: { sessionId: session.id, role: index % 2 ? 'assistant' : 'user', content: `${tag}:${index}:${BIG}` },
    })
  }
  return { user, ws, project, conversation, session, message }
}

beforeAll(async () => {
  await db.user.create({ data: { id: OWNER, name: 'Russell', email: `owner-${suffix}@example.com` } })
  await db.workspace.create({ data: { id: HOME, name: 'Cloud home', slug: `home-${suffix}`, kind: 'personal' } })
  await db.instance.create({
    data: { id: INSTANCE, workspaceId: HOME, userId: OWNER, hostname: 'macbook.local', name: 'macbook.local', deviceId: DEVICE },
  })
})

describeIfPg('AC1 — the first snapshot finishes', () => {
  test('a 20 MB chat history arrives in pages no proxy would cut, and completes', async () => {
    const { ws, session, conversation } = await seedDesktop(`ac1-${suffix}`)
    await ownEverything()

    // A row the cloud wrote that the desktop never sent. A hosted workspace is
    // writable from the cloud (SHO-285), so the completed snapshot keeps it, and
    // keeps the owner's own membership row (RBAC lane, round 3).
    const frozen = await freezeDesktop()
    const stray = await db.chatMessage.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: 'I was interrupted while working before the turn finished.',
      },
    })

    const seen: Seen = { sizes: [], batches: [], statuses: [] }
    expect(await drain(pusherFor(cloud(seen), frozen))).toBe(true)

    // Every request the cloud saw is under the byte cap, including the
    // completion one — the 21 MB page that Envoy cut cannot be built.
    expect(Math.max(...seen.sizes)).toBeLessThan(4_200_000)

    const snapshot = seen.batches.filter((batch) => batch.mode === 'snapshot' && batch.models.length)
    expect(snapshot.length).toBeGreaterThan(CHAT_ROWS / 10)

    // Parents-first: the channel and its messages reach the cloud, not just the
    // chat history that used to fill the write order ahead of them.
    const models = seen.batches.flatMap((batch) => batch.models.map((m) => m.model))
    expect(models).toContain('Conversation')
    expect(models).toContain('ConversationMessage')
    expect(models).toContain('ChatMessage')

    const state = await db.machineSyncState.findFirst({ where: { instanceId: INSTANCE } })
    expect(state?.lastIngestAt).toBeTruthy()

    const mirrored = await db.conversation.findUnique({ where: { id: conversation.id } })
    expect(mirrored?.name).toBe(`#general-ac1-${suffix}`)
    expect(await db.chatMessage.count({ where: { content: { startsWith: `ac1-${suffix}:0:` } } })).toBe(1)
    expect(seen.statuses.every((status) => status === 200)).toBe(true)

    expect(await db.chatMessage.count({ where: { id: stray.id } })).toBe(1)
    expect(
      await db.member.count({ where: { workspaceId: ws.id, userId: OWNER, projectId: null } }),
    ).toBe(1)
  })
})

describeIfPg('AC2 — a failed page does not restart the database', () => {
  test('a 504 mid-snapshot keeps one epoch and the run still completes', async () => {
    await db.machineSyncState.updateMany({ where: { instanceId: INSTANCE }, data: { lastIngestAt: null } })
    await seedDesktop(`ac2-${suffix}`)
    await ownEverything()

    const seen: Seen = { sizes: [], batches: [], statuses: [] }
    const pusher = pusherFor(cloud(seen, { failFirstChatPage: true }), await freezeDesktop())
    expect(await drain(pusher)).toBe(true)

    expect(seen.statuses).toContain(504)
    const epochs = new Set(
      seen.batches.filter((batch) => batch.mode === 'snapshot').map((batch) => batch.epoch),
    )
    expect(epochs.size).toBe(1)
    const state = await db.machineSyncState.findFirst({ where: { instanceId: INSTANCE } })
    expect(state?.lastIngestAt).toBeTruthy()
    // Nothing is lost by the retry: the model pages were re-sent, not skipped.
    const models = seen.batches.flatMap((batch) => batch.models.map((m) => m.model))
    expect(models).toContain('ChatMessage')
    expect(models).toContain('ConversationMessage')
  })
})

describeIfPg('AC3 — a renamed Mac is the same machine', () => {
  test('a new hostname keeps the instance id, and the next delta is accepted', async () => {
    const identity = (hostname: string) => ({
      workspaceId: HOME,
      userId: OWNER,
      hostname,
      name: hostname,
      os: 'darwin',
      arch: 'arm64',
      kind: 'desktop',
      deviceId: DEVICE,
      touch: true,
    })

    const first = await resolveInstanceIdentity(db, identity('macbook.local'))
    // macOS renamed itself: different hostname, same device.
    const second = await resolveInstanceIdentity(db, identity('unknown2e36ea.attlocal.net'))

    expect(second.id).toBe(first.id)
    expect(second.id).toBe(INSTANCE)
    expect(second.hostname).toBe('unknown2e36ea.attlocal.net')
    expect(await db.instance.count({ where: { workspaceId: HOME, userId: OWNER, deviceId: DEVICE } })).toBe(1)

    // The push that was refused `mirror_ownership` for two days.
    const state = await db.machineSyncState.findFirst({ where: { instanceId: INSTANCE } })
    const seen: Seen = { sizes: [], batches: [], statuses: [] }
    const res = await cloud(seen)(`http://cloud.test/api/machines/${second.id}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ epoch: state?.epoch, mode: 'changes', cursor: state?.cursor ?? 0, models: [] }),
    })
    const body = (await res.json()) as any
    expect(body.error).toBeUndefined()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
  })
})

describeIfPg('AC4 — the cloud does not run a turn for a desktop-hosted workspace', () => {
  test('a stale turn in a hosted workspace is never claimed or announced', async () => {
    const { ws, session } = await seedDesktop(`ac4-${suffix}`)
    await db.workspace.update({ where: { id: ws.id }, data: { hostInstanceId: INSTANCE } })
    hostedWorkspace.invalidateHostedWorkspaceIds()

    const messagesBefore = await db.chatMessage.count({ where: { sessionId: session.id } })
    const queuedBefore = await db.chatQueuedMessage.count({ where: { sessionId: session.id } })
    const claimed: string[] = []
    const announced: string[] = []
    const dispatched: string[] = []

    const deps: any = {
      db,
      acquireLease: async () => true,
      track: async () => {
        claimed.push(session.id)
        return { text: '', usage: null, seq: 0 }
      },
      resolveTarget: async () => {
        throw new Error('the cloud must not reach for a machine session runtime')
      },
      startTurnHeartbeat: () => () => {},
      markTurnEnded: async () => {},
      dispatchNext: async (id: string) => {
        dispatched.push(id)
        return false
      },
      getCallLink: async () => undefined,
      settleCall: async () => {},
      announceInterrupted: async (id: string) => {
        announced.push(id)
        return { noted: true, queued: true }
      },
      homeSessionWhere: () => null,
      now: () => Date.now(),
    }

    expect(await reattachStaleTurns(deps)).toEqual([])
    expect(claimed).toEqual([])
    expect(announced).toEqual([])
    expect(dispatched).toEqual([])

    // The second guard: the two writers that put the note and the resume in.
    expect(await resume.postInterruptedResume(session.id)).toEqual({ noted: false, queued: false })
    expect(await dispatcher.dispatchNext(session.id)).toBe(false)

    expect(await db.chatMessage.count({ where: { sessionId: session.id } })).toBe(messagesBefore)
    expect(await db.chatQueuedMessage.count({ where: { sessionId: session.id } })).toBe(queuedBefore)
  })
})

describeIfPg('AC5 — a completed snapshot keeps what the cloud wrote (SHO-285)', () => {
  test('rows written in the cloud survive the snapshot; the desktop pulls them instead', async () => {
    const { ws, session, conversation, user } = await seedDesktop(`ac5-${suffix}`)
    // A finished run from an earlier case would make `drain` a delta, and rows
    // written straight into this database are not in the desktop's change log.
    await db.machineSyncState.updateMany({ where: { instanceId: INSTANCE }, data: { lastIngestAt: null } })
    await db.workspace.update({ where: { id: ws.id }, data: { hostInstanceId: INSTANCE } })
    await ownEverything()

    const seen: Seen = { sizes: [], batches: [], statuses: [] }
    expect(await drain(pusherFor(cloud(seen), await freezeDesktop()))).toBe(true)

    // Rows written in the cloud, e.g. a message sent from the web.
    const note = await db.chatMessage.create({
      data: { sessionId: session.id, role: 'assistant', content: 'I was interrupted while working…' },
    })
    const resumeRow = await db.chatQueuedMessage.create({
      data: {
        sessionId: session.id,
        userId: user.id,
        kind: 'resume',
        content: 'resume',
        body: 'resume',
      },
    })
    const seeded = await db.conversation.create({
      data: { workspaceId: ws.id, name: '#cloud-seeded', slug: `cloud-${suffix}` },
    })
    const desktopMessage = await db.chatMessage.findFirst({
      where: { sessionId: session.id, content: { startsWith: `ac5-${suffix}:0:` } },
    })

    const state = await db.machineSyncState.findFirst({ where: { instanceId: INSTANCE } })
    const res = await cloud({ sizes: [], batches: [], statuses: [] })(
      `http://cloud.test/api/machines/${INSTANCE}/sync`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          epoch: state?.epoch,
          mode: 'snapshot',
          cursor: 0,
          models: [],
          snapshot: { complete: true },
        }),
      },
    )
    expect(res.status).toBe(200)

    // A hosted workspace is writable from the cloud, so a snapshot no longer
    // prunes: the cloud's rows stay and reach the desktop through the change feed.
    expect(await db.chatMessage.findUnique({ where: { id: note.id } })).not.toBeNull()
    expect(await db.chatQueuedMessage.findUnique({ where: { id: resumeRow.id } })).not.toBeNull()
    expect(await db.conversation.findUnique({ where: { id: seeded.id } })).not.toBeNull()
    expect(await db.chatMessage.findUnique({ where: { id: desktopMessage!.id } })).not.toBeNull()
    expect(await db.conversation.findUnique({ where: { id: conversation.id } })).not.toBeNull()
  }, 180_000)
})

/**
 * SHO-562: a NUL byte is legal in the desktop's SQLite and illegal in Postgres
 * (`22021` in `text`, `22P05` in a `jsonb` escape), and one such row failed the
 * whole page — so a machine's cursor never moved and it re-sent the same page
 * forever (prod, machine `cmvrve2as000u01fbcvol5iw6`). The page below is that
 * page: a text column, a nested Json value and key, and a String[] element each
 * carry a NUL. On `main` the route answers 500 and the cursor stays put; here it
 * applies, the rows are stored clean, and the sync moves on.
 */
describeIfPg('AC6 — a NUL byte in a page does not stop the sync (SHO-562)', () => {
  test('the page applies, the NULs are gone and the cursor advances', async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const user = await db.user.create({ data: { name: tag, email: `nul-${tag}@example.com` } })
    const ws = await db.workspace.create({
      data: { name: `${tag} team`, slug: `nul-${tag}`, kind: 'team', hostInstanceId: INSTANCE },
    })

    const epoch = `e-nul-${tag}`
    const startedAt = new Date()
    await db.machineSyncState.upsert({
      where: { instanceId: INSTANCE },
      create: { instanceId: INSTANCE, epoch, cursor: 1387815, lastIngestAt: new Date(), enabled: true },
      update: { epoch, cursor: 1387815, lastIngestAt: new Date(), enabled: true },
    })

    const NUL = '\u0000'
    const now = new Date().toISOString()
    const sessionId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    const goalId = crypto.randomUUID()
    const projectId = crypto.randomUUID()

    const seen: Seen = { sizes: [], batches: [], statuses: [] }
    const res = await cloud(seen)(`http://cloud.test/api/machines/${INSTANCE}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        epoch,
        mode: 'changes',
        cursor: 1387900,
        models: [
          {
            model: 'ChatSession',
            rows: [
              {
                id: sessionId,
                inferredName: `${tag} chat`,
                contextType: 'workspace',
                workspaceId: ws.id,
                createdByUserId: user.id,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          // The prod shape: text in `chat_messages.content`.
          {
            model: 'ChatMessage',
            rows: [{ id: messageId, sessionId, role: 'user', content: `before${NUL}after`, createdAt: now, updatedAt: now }],
          },
          // A Json column, with the NUL in a value and in a key (`jsonb` 22P05).
          {
            model: 'Goal',
            rows: [
              {
                id: goalId,
                workspaceId: ws.id,
                title: `goal${NUL}title`,
                plan: [{ step: `a${NUL}b`, [`k${NUL}ey`]: 'v' }],
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          // A String[] column, and the same page's text column.
          {
            model: 'Project',
            rows: [
              { id: projectId, name: `project${NUL}name`, workspaceId: ws.id, schemas: [`s${NUL}chema`], createdAt: now, updatedAt: now },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.error).toBeUndefined()
    expect(body.ok).toBe(true)

    expect((await db.chatMessage.findUnique({ where: { id: messageId } }))?.content).toBe('beforeafter')
    const goal = await db.goal.findUnique({ where: { id: goalId } })
    expect(goal?.title).toBe('goaltitle')
    expect(goal?.plan).toEqual([{ step: 'ab', key: 'v' }])
    const project = await db.project.findUnique({ where: { id: projectId } })
    expect(project?.name).toBe('projectname')
    expect(project?.schemas).toEqual(['schema'])

    // The whole point of the fix: the machine's cursor moves, so the same page
    // is never sent again.
    const state = await db.machineSyncState.findFirst({ where: { instanceId: INSTANCE } })
    expect(Number(state?.cursor)).toBe(1387900)
    expect(state!.lastIngestAt!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime())
  }, 60_000)
})

/**
 * SHO-562 AC3, end to end.
 *
 * Stripping NULs is the fix for this incident, but the *safety net* is what has
 * to hold for the next value SQLite allows and Postgres refuses — and that net
 * only exists if `dataException()` reads the shape the pg adapter actually
 * throws. A fake transaction cannot prove that. Here Postgres itself refuses one
 * row: a `varchar(5)` is put on `ChatMessage.imageData` in this throwaway
 * database, so a longer value is `22001 value too long for type character
 * varying(5)` — a real SQLSTATE-class-22 error through the real route, the same
 * class as the incident's `22021`. The page must still answer 200, store the
 * clean row beside it and move the cursor, and the warn must name the model, the
 * id and the SQLSTATE without any of the row's contents.
 */
describeIfPg('AC7 — a row Postgres refuses as bad data is skipped, not fatal (SHO-562 AC3)', () => {
  test('the rest of the page applies, the row is logged and the cursor advances', async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const user = await db.user.create({ data: { name: tag, email: `skip-${tag}@example.com` } })
    const ws = await db.workspace.create({
      data: { name: `${tag} team`, slug: `skip-${tag}`, kind: 'team', hostInstanceId: INSTANCE },
    })

    const epoch = `e-skip-${tag}`
    const startedAt = new Date()
    await db.machineSyncState.upsert({
      where: { instanceId: INSTANCE },
      create: { instanceId: INSTANCE, epoch, cursor: 1387815, lastIngestAt: new Date(), enabled: true },
      update: { epoch, cursor: 1387815, lastIngestAt: new Date(), enabled: true },
    })

    const now = new Date().toISOString()
    const sessionId = crypto.randomUUID()
    const refusedId = crypto.randomUUID()
    const cleanId = crypto.randomUUID()
    const SECRET = 'data:image/png;base64,QQQQQQQQQQQQQQQQQQQQ'

    const warns: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((arg) => String(arg)).join(' '))
    }

    let res: Response
    try {
      await db.$executeRawUnsafe('ALTER TABLE "chat_messages" ALTER COLUMN "imageData" TYPE varchar(5)')
      const seen: Seen = { sizes: [], batches: [], statuses: [] }
      res = await cloud(seen)(`http://cloud.test/api/machines/${INSTANCE}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          epoch,
          mode: 'changes',
          cursor: 1387900,
          models: [
            {
              model: 'ChatSession',
              rows: [
                {
                  id: sessionId,
                  inferredName: `${tag} chat`,
                  contextType: 'workspace',
                  workspaceId: ws.id,
                  createdByUserId: user.id,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            },
            {
              model: 'ChatMessage',
              rows: [
                // Postgres refuses this one (22001); it must not take the page with it.
                { id: refusedId, sessionId, role: 'user', content: 'bad', imageData: SECRET, createdAt: now, updatedAt: now },
                { id: cleanId, sessionId, role: 'assistant', content: 'clean', createdAt: now, updatedAt: now },
              ],
            },
          ],
        }),
      })
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE "chat_messages" ALTER COLUMN "imageData" TYPE text')
      console.warn = realWarn
    }

    expect(res!.status).toBe(200)
    const body = (await res!.json()) as any
    expect(body.error).toBeUndefined()
    expect(body.ok).toBe(true)
    expect(body.applied).toBeGreaterThanOrEqual(2)
    expect(body.skipped).toBe(1)

    expect(await db.chatMessage.findUnique({ where: { id: refusedId } })).toBeNull()
    expect((await db.chatMessage.findUnique({ where: { id: cleanId } }))?.content).toBe('clean')

    const state = await db.machineSyncState.findFirst({ where: { instanceId: INSTANCE } })
    expect(Number(state?.cursor)).toBe(1387900)
    expect(state!.lastIngestAt!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime())

    const skipLine = warns.find((line) => line.includes('SQLSTATE'))
    expect(skipLine).toBeDefined()
    expect(skipLine).toContain('ChatMessage')
    expect(skipLine).toContain(refusedId)
    expect(skipLine).toContain('22001')
    // The row can hold a person's text, so the log names it and never quotes it.
    expect(warns.join('\n')).not.toContain(SECRET)
  }, 60_000)
})
