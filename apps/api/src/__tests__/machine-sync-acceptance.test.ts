// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for the machine copy (SHO-276, AC1-AC4).
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
const machineWorkspace = await import('../lib/machine-workspace')

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
 * page) legal — the ownership rule itself is SHO-241's suite.
 */
async function ownEverything() {
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
    const { conversation } = await seedDesktop(`ac1-${suffix}`)
    await ownEverything()

    const seen: Seen = { sizes: [], batches: [], statuses: [] }
    expect(await drain(pusherFor(cloud(seen), await freezeDesktop()))).toBe(true)

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

describeIfPg('AC4 — the cloud does not run a turn on the copy', () => {
  test('a stale turn in a machine workspace is never claimed or announced', async () => {
    const { ws, session } = await seedDesktop(`ac4-${suffix}`)
    await db.workspace.update({ where: { id: ws.id }, data: { machineInstanceId: INSTANCE } })
    machineWorkspace.invalidateMachineWorkspaceIds()

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

describeIfPg('AC5 — a completed snapshot removes what the cloud wrote into the copy', () => {
  test('the interrupted note and the queued resume do not survive it', async () => {
    const { ws, session, conversation, user } = await seedDesktop(`ac5-${suffix}`)
    // A finished run from an earlier case would make `drain` a delta, and rows
    // written straight into this database are not in the desktop's change log.
    await db.machineSyncState.updateMany({ where: { instanceId: INSTANCE }, data: { lastIngestAt: null } })
    await db.workspace.update({ where: { id: ws.id }, data: { machineInstanceId: INSTANCE } })
    await ownEverything()

    const seen: Seen = { sizes: [], batches: [], statuses: [] }
    expect(await drain(pusherFor(cloud(seen), await freezeDesktop()))).toBe(true)

    // What `postInterruptedResume` and the cloud's own seeding put in the copy:
    // rows in tables that carry only `sessionId`/`workspaceId`, not a machine id.
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

    // Gone: the note under a chat the desktop owns, the resume queued in it, and
    // a channel the cloud seeded. Kept: everything the desktop actually sent.
    expect(await db.chatMessage.findUnique({ where: { id: note.id } })).toBeNull()
    expect(await db.chatQueuedMessage.findUnique({ where: { id: resumeRow.id } })).toBeNull()
    expect(await db.conversation.findUnique({ where: { id: seeded.id } })).toBeNull()
    expect(await db.chatMessage.findUnique({ where: { id: desktopMessage!.id } })).not.toBeNull()
    expect(await db.conversation.findUnique({ where: { id: conversation.id } })).not.toBeNull()
  }, 180_000)
})
