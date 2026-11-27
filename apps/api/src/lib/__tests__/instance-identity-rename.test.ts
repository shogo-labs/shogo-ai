// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Heartbeat identity — a rename onto a taken hostname must not 500 (PERF-21).
 *
 * macOS renames its host per network, so a machine that moves from
 * `Russells-MacBook-Pro.local` to `Russells-MacBook-Pro-2.local` renames its
 * instance row. When a leftover row from an earlier registration already holds
 * that hostname, the `(workspaceId, userId, hostname)` unique key rejected the
 * update with P2002, which the heartbeat let escape as a 500. The machine then
 * 500'd on every beat and never went online — 752 a day, the largest source of
 * US server errors outside an outage.
 *
 *   bun --conditions=development --no-env-file test apps/api/src/lib/__tests__/instance-identity-rename.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { resolveInstanceIdentity } from '../instance-identity'

interface Row {
  id: string
  workspaceId: string
  userId: string
  hostname: string
  name: string
  os: string | null
  arch: string | null
  kind: string
  lastSeenAt: Date | null
  wsRequestedAt: Date | null
  deviceId: string | null
  metadata?: unknown
  status?: string
}

const WS = 'ws-1'
const USER = 'user-1'

function row(overrides: Partial<Row> & Pick<Row, 'id' | 'hostname'>): Row {
  return {
    workspaceId: WS,
    userId: USER,
    name: overrides.hostname,
    os: 'darwin',
    arch: 'arm64',
    kind: 'desktop',
    lastSeenAt: null,
    wsRequestedAt: null,
    deviceId: null,
    ...overrides,
  }
}

/**
 * Just enough of the Prisma client to exercise identity resolution, including the
 * unique key on `(workspaceId, userId, hostname)` that produced the 500.
 */
function fakeTx(rows: Row[]) {
  const ids = (where: any) => (where?.id?.not ? { not: where.id.not as string } : null)
  const match = (r: Row, where: any) => {
    if (typeof where.id === 'string' && r.id !== where.id) return false
    if (where.workspaceId && r.workspaceId !== where.workspaceId) return false
    if (where.userId && r.userId !== where.userId) return false
    if (where.kind && r.kind !== where.kind) return false
    if (where.hostname && r.hostname !== where.hostname) return false
    if (where.deviceId !== undefined && r.deviceId !== where.deviceId) return false
    const not = ids(where)
    if (not && r.id === not.not) return false
    return true
  }

  return {
    rows,
    instance: {
      async findFirst({ where }: any) {
        return rows.find((r) => match(r, where)) ?? null
      },
      async findUnique({ where }: any) {
        const key = where.workspaceId_userId_hostname
        return rows.find((r) => match(r, key)) ?? null
      },
      async findMany({ where }: any) {
        return rows.filter((r) => match(r, where))
      },
      async update({ where, data }: any) {
        const target = rows.find((r) => r.id === where.id)
        if (!target) throw new Error(`no row ${where.id}`)
        const taken = rows.some(
          (r) =>
            r.id !== target.id &&
            r.workspaceId === target.workspaceId &&
            r.userId === target.userId &&
            r.hostname === data.hostname,
        )
        if (taken) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`workspaceId`,`userId`,`hostname`)'), {
            code: 'P2002',
          })
        }
        Object.assign(target, data)
        return target
      },
      async create({ data }: any) {
        if (rows.some((r) => match(r, { workspaceId: data.workspaceId, userId: data.userId, hostname: data.hostname }))) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
        }
        const created = { id: `i-${rows.length + 1}`, lastSeenAt: null, wsRequestedAt: null, ...data } as Row
        rows.push(created)
        return created
      },
      async deleteMany({ where }: any) {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (match(rows[i], where)) rows.splice(i, 1)
        }
        return { count: 1 }
      },
    },
  }
}

describe('resolveInstanceIdentity — hostname rename', () => {
  test('retires a stale duplicate that holds the hostname, then renames', async () => {
    // The live row for device-1, and a leftover from before device ids existed
    // (same `metadata.machine.id`) still holding the hostname the Mac is using now.
    const live = row({ id: 'live', hostname: 'Russells-MacBook-Pro.local', deviceId: 'device-1' })
    const stale = row({
      id: 'stale',
      hostname: 'Russells-MacBook-Pro-2.local',
      metadata: { machine: { id: 'device-1' } },
    })
    const tx = fakeTx([live, stale])

    const resolved = await resolveInstanceIdentity(tx, {
      workspaceId: WS,
      userId: USER,
      hostname: 'Russells-MacBook-Pro-2.local',
      name: 'Russells MacBook Pro',
      os: 'darwin',
      arch: 'arm64',
      kind: 'desktop',
      deviceId: 'device-1',
      touch: true,
    })

    expect(resolved.id).toBe('live')
    expect(resolved.hostname).toBe('Russells-MacBook-Pro-2.local')
    expect(tx.rows.map((r) => r.id)).toEqual(['live'])
    expect(live.lastSeenAt).not.toBeNull()
  })

  test('keeps its own hostname when another machine genuinely owns the name', async () => {
    const mine = row({ id: 'mine', hostname: 'Russells-MacBook-Pro.local', deviceId: 'device-1' })
    const theirs = row({ id: 'theirs', hostname: 'Russells-MacBook-Pro-2.local', deviceId: 'device-2' })
    const tx = fakeTx([mine, theirs])

    const resolved = await resolveInstanceIdentity(tx, {
      workspaceId: WS,
      userId: USER,
      hostname: 'Russells-MacBook-Pro-2.local',
      name: 'Russells MacBook Pro',
      os: 'darwin',
      arch: 'arm64',
      kind: 'desktop',
      deviceId: 'device-1',
      touch: true,
    })

    expect(resolved.id).toBe('mine')
    expect(resolved.hostname).toBe('Russells-MacBook-Pro.local')
    expect(mine.hostname).toBe('Russells-MacBook-Pro.local')
    // The other machine keeps its row and its name.
    expect(tx.rows.map((r) => r.id).sort()).toEqual(['mine', 'theirs'])
  })

  test('a plain rename with no conflict applies the new hostname', async () => {
    const mine = row({ id: 'mine', hostname: 'old.local', deviceId: 'device-1' })
    const tx = fakeTx([mine])

    const resolved = await resolveInstanceIdentity(tx, {
      workspaceId: WS,
      userId: USER,
      hostname: 'new.local',
      name: 'machine',
      os: 'darwin',
      arch: 'arm64',
      kind: 'desktop',
      deviceId: 'device-1',
    })

    expect(resolved.hostname).toBe('new.local')
    expect(mine.hostname).toBe('new.local')
  })
})
