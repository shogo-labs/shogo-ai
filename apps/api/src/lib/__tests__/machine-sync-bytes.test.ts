// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The snapshot that never finished (SHO-276).
 *
 * In production the first page of `ChatMessage` was 21.4 MB, Envoy cut the
 * request at 125 s, and the pusher answered by starting the whole database
 * again under a new epoch — eight epochs in one day, no copy, no channel ever
 * reaching the cloud. These tests pin the two rules that fix it:
 *
 *   • a page is bounded by **bytes**, so no request can be that large;
 *   • a page that fails is retried from the same keyset under the **same**
 *     epoch, with a smaller page when the failure was the size of the body.
 *
 * Plus the identity rule from the same card: a hostname change is a field
 * update on the row a device already has, never a second machine.
 */
import { describe, expect, test } from 'bun:test'
import { MachineSyncPusher, type SyncBatchRequest } from '../machine-sync/pusher.ts'
import { resolveInstanceIdentity } from '../instance-identity.ts'
import { machineSessionExclusion } from '../machine-workspace.ts'

const BIG = 'x'.repeat(200_000)

function chatRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${String(index).padStart(5, '0')}`,
    sessionId: 's1',
    role: 'assistant',
    content: BIG,
  }))
}

/**
 * A desktop database with `rows` and no accepted snapshot, so the next tick
 * sends one.
 */
function desktopDb(rows: Array<Record<string, unknown>>) {
  const state: Record<string, unknown> = {
    instanceId: 'inst-1',
    epoch: 'epoch-1',
    cursor: 0,
    enabled: true,
    lastIngestAt: null,
  }
  let seeded = false
  const delegate = (name: string) => {
    if (name === 'machineSyncChange') {
      return {
        findFirst: async () => null,
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
      }
    }
    if (name === 'machineSyncState') {
      return {
        findUnique: async () => (seeded ? { ...state } : null),
        create: async ({ data }: any) => {
          Object.assign(state, data)
          seeded = true
          return { ...state }
        },
        update: async ({ data }: any) => {
          Object.assign(state, data)
          return { ...state }
        },
      }
    }
    if (name !== 'chatMessage') {
      return { findMany: async () => [] }
    }
    return {
      findMany: async (args: any) => {
        const after = args?.where?.id?.gt
        const take = args?.take ?? rows.length
        return rows
          .filter((row) => (after ? String(row.id) > String(after) : true))
          .slice(0, take)
      },
    }
  }
  const db: any = new Proxy(
    { $transaction: async (fn: any) => fn(db) },
    {
      get(target, prop: string) {
        if (prop in target) return (target as any)[prop]
        return delegate(prop)
      },
    },
  )
  return { db, state }
}

function pusherFor(
  db: any,
  fetchImpl: typeof fetch,
  log?: (line: string) => void,
) {
  return new MachineSyncPusher({
    prisma: db,
    getCloudUrl: () => 'https://studio.example',
    getApiKey: () => 'key-1',
    getInstanceId: () => 'inst-1',
    fetchImpl,
    ...(log ? { log } : {}),
  })
}

describe('a snapshot page is bounded by bytes', () => {
  test('240 MB of chat messages goes out in pages no request could time out on', async () => {
    const rows = chatRows(120) // 120 × 200 KB ≈ 24 MB
    const { db } = desktopDb(rows)
    const posted: SyncBatchRequest[] = []
    const sizes: number[] = []

    const fetchImpl = (async (_url: string, init: any) => {
      sizes.push(String(init.body).length)
      posted.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ ok: true, applied: 1 }), { status: 200 })
    }) as unknown as typeof fetch

    await pusherFor(db, fetchImpl).tick()

    const pages = posted.filter((batch) => batch.mode === 'snapshot' && batch.models.length)
    expect(pages.length).toBeGreaterThan(1)
    // Every request, including the completion one, is under the byte cap.
    for (const size of sizes) expect(size).toBeLessThan(4_200_000)
    // Nothing is sent twice and nothing is dropped by the split.
    const sent = pages.flatMap((batch) => batch.models[0].rows.map((row) => String(row.id)))
    expect(new Set(sent).size).toBe(sent.length)
    expect(sent.length).toBe(rows.length)
    expect(posted[posted.length - 1].snapshot?.complete).toBe(true)
  })
})

describe('a failed page resumes where it stopped', () => {
  test('a timeout keeps the epoch and the cursor, and the run still finishes', async () => {
    const rows = chatRows(60) // ≈ 12 MB, so several pages
    const { db } = desktopDb(rows)
    const posted: SyncBatchRequest[] = []
    const logs: string[] = []
    let failedOnce = false

    const fetchImpl = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body) as SyncBatchRequest
      // The first page is cut off mid-upload: no status, no body.
      if (!failedOnce && body.mode === 'snapshot' && body.models.length) {
        failedOnce = true
        const err = new Error('The operation timed out.')
        err.name = 'TimeoutError'
        throw err
      }
      posted.push(body)
      return new Response(JSON.stringify({ ok: true, applied: 1 }), { status: 200 })
    }) as unknown as typeof fetch

    const pusher = pusherFor(db, fetchImpl, (line) => logs.push(line))
    // One tick, then the next one after the failure (the real loop is on a timer).
    await pusher.tick()
    await pusher.tick()

    const pages = posted.filter((batch) => batch.mode === 'snapshot' && batch.models.length)
    expect(pages.length).toBeGreaterThan(1)
    // Every page — before the failure, after it, and the completion request —
    // belongs to one epoch. A new epoch is the bug: it started the database over.
    expect(new Set(posted.map((batch) => batch.epoch)).size).toBe(1)
    // And every row arrived exactly once, so the retry continued rather than
    // restarted.
    const sent = pages.flatMap((batch) => batch.models[0].rows.map((row) => String(row.id)))
    expect(sent.length).toBe(rows.length)
    expect(new Set(sent).size).toBe(rows.length)
    expect(posted[posted.length - 1].snapshot?.complete).toBe(true)
    expect(logs.some((line) => line.includes('Retrying ChatMessage page'))).toBe(true)
    expect(pusher.status.copyReady).toBe(true)
  })
})

// ─── Identity: a hostname is not a machine ─────────────────────────────────

function fakeInstances(seed: Array<Record<string, any>> = []) {
  const rows = seed.map((row) => ({ hostname: 'old.local', deviceId: null, ...row }))
  const api = {
    findFirst: async ({ where }: any) =>
      rows.find(
        (row) =>
          row.workspaceId === where.workspaceId &&
          row.userId === where.userId &&
          (where.deviceId ? row.deviceId === where.deviceId : true),
      ) ?? null,
    findUnique: async ({ where }: any) =>
      rows.find(
        (row) =>
          row.workspaceId === where.workspaceId_userId_hostname.workspaceId &&
          row.userId === where.workspaceId_userId_hostname.userId &&
          row.hostname === where.workspaceId_userId_hostname.hostname,
      ) ?? null,
    create: async ({ data }: any) => {
      const row = { lastSeenAt: null, wsRequestedAt: null, ...data }
      rows.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = rows.find((entry) => entry.id === where.id)!
      Object.assign(row, data)
      return row
    },
  }
  return { api, tx: { instance: api }, rows }
}

describe('one machine, one instance row', () => {
  test('a renamed host keeps its row, its id, and only updates the hostname', async () => {
    const { tx, rows } = fakeInstances([
      { id: 'inst-a', workspaceId: 'w1', userId: 'u1', hostname: 'Russells-MacBook-Pro-2.local', deviceId: 'dev-1' },
    ])

    const resolved = await resolveInstanceIdentity(tx, {
      workspaceId: 'w1',
      userId: 'u1',
      hostname: 'unknown2e36ea9404bb.attlocal.net',
      name: 'Russells-MacBook-Pro-2.local',
      os: 'darwin',
      arch: 'arm64',
      kind: 'desktop',
      deviceId: 'dev-1',
      touch: true,
    })

    expect(resolved.id).toBe('inst-a')
    expect(rows).toHaveLength(1)
    expect(rows[0].hostname).toBe('unknown2e36ea9404bb.attlocal.net')
    expect(rows[0].deviceId).toBe('dev-1')
    expect(rows[0].lastSeenAt).toBeInstanceOf(Date)
  })

  test('a client without the header adopts the row its hostname already has', async () => {
    const { tx, rows } = fakeInstances([
      { id: 'inst-a', workspaceId: 'w1', userId: 'u1', hostname: 'old.local', deviceId: null },
    ])

    const resolved = await resolveInstanceIdentity(tx, {
      workspaceId: 'w1',
      userId: 'u1',
      hostname: 'old.local',
      name: 'old',
      os: null,
      arch: null,
      kind: 'desktop',
      metadata: { machine: { id: 'dev-1' } },
    })

    expect(resolved.id).toBe('inst-a')
    expect(resolved.adopted).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0].deviceId).toBe('dev-1')
  })
})

// ─── The cloud never claims a mirrored chat (SHO-276 §C) ───────────────────

describe('the reattach sweep skips a paired machine', () => {
  test('the candidate filter excludes workspace chats and project chats alike', () => {
    const where = machineSessionExclusion(['w-machine']) as any
    const clauses = JSON.stringify(where)
    expect(clauses).toContain('"workspaceId":{"notIn":["w-machine"]}')
    expect(clauses).toContain('"project":{"workspaceId":{"notIn":["w-machine"]}}')
    // No machine paired: the filter is empty, so the query plan is unchanged.
    expect(machineSessionExclusion([])).toEqual({})
  })
})
