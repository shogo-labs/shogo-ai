// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/lib/a2a/auth.ts (mint/list/revoke/verify
// shogo_a2a_<keyId>.<secret> keys). Prisma is mocked with a tiny in-memory
// store; hashApiKey is left real (cheap, deterministic SHA-256) so the
// mint -> verify round trip exercises the actual hashing path.

import { beforeEach, describe, expect, it } from 'bun:test'
import { mock } from 'bun:test'

interface FakeRow {
  id: string
  name: string
  keyId: string
  hashedSecret: string
  projectId: string
  workspaceId: string
  createdBy: string
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

let rows: FakeRow[] = []
let idCounter = 0

mock.module('../../prisma', () => ({
  prisma: {
    a2aApiKey: {
      create: async ({ data }: any) => {
        const row: FakeRow = {
          id: `key_${++idCounter}`,
          name: data.name,
          keyId: data.keyId,
          hashedSecret: data.hashedSecret,
          projectId: data.projectId,
          workspaceId: data.workspaceId,
          createdBy: data.createdBy,
          lastUsedAt: null,
          expiresAt: data.expiresAt ?? null,
          revokedAt: null,
          createdAt: new Date(Date.now() + idCounter), // monotonically increasing
        }
        rows.push(row)
        return row
      },
      findMany: async ({ where, orderBy }: any) => {
        let result = rows.filter((r) => r.projectId === where.projectId)
        if (orderBy?.createdAt === 'desc') {
          result = [...result].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        }
        return result
      },
      findUnique: async ({ where }: any) => rows.find((r) => r.keyId === where.keyId) ?? null,
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)
        if (!row) throw new Error('row not found')
        Object.assign(row, data)
        return row
      },
      updateMany: async ({ where, data }: any) => {
        const matches = rows.filter(
          (r) => r.id === where.id && r.projectId === where.projectId && r.revokedAt === where.revokedAt,
        )
        matches.forEach((r) => Object.assign(r, data))
        return { count: matches.length }
      },
    },
  },
}))

const { SHOGO_A2A_KEY_PREFIX, mintA2aApiKey, listA2aApiKeys, revokeA2aApiKey, verifyA2aApiKey } = await import(
  '../auth'
)

beforeEach(() => {
  rows = []
  idCounter = 0
})

describe('SHOGO_A2A_KEY_PREFIX', () => {
  it('is "shogo_a2a_"', () => {
    expect(SHOGO_A2A_KEY_PREFIX).toBe('shogo_a2a_')
  })
})

describe('mintA2aApiKey', () => {
  it('mints a fullKey shaped shogo_a2a_<24-hex-keyId>.<64-hex-secret>', async () => {
    const minted = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    expect(minted.fullKey.startsWith(SHOGO_A2A_KEY_PREFIX)).toBe(true)
    const rest = minted.fullKey.slice(SHOGO_A2A_KEY_PREFIX.length)
    const [keyId, secret] = rest.split('.')
    expect(keyId).toMatch(/^[0-9a-f]{24}$/)
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(minted.keyId).toBe(keyId)
  })

  it('persists a hashed secret, never the raw secret', async () => {
    const minted = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    const row = rows.find((r) => r.keyId === minted.keyId)!
    const secret = minted.fullKey.split('.')[1]
    expect(row.hashedSecret).not.toBe(secret)
    expect(row.hashedSecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('defaults name to "A2A key" and truncates a long name to 120 chars', async () => {
    const noName = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    expect(noName.name).toBe('A2A key')

    const long = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1', name: 'x'.repeat(500) })
    expect(long.name.length).toBe(120)
  })

  it('produces a unique key on every call', async () => {
    const a = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    const b = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    expect(a.fullKey).not.toBe(b.fullKey)
    expect(a.keyId).not.toBe(b.keyId)
  })

  it('does not dedupe against existing keys for the same project', async () => {
    await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1', name: 'first' })
    await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1', name: 'second' })
    expect(rows.filter((r) => r.projectId === 'p1')).toHaveLength(2)
  })
})

describe('listA2aApiKeys', () => {
  it('returns only keys for the given project, newest first, without hashedSecret', async () => {
    await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1', name: 'older' })
    const newer = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1', name: 'newer' })
    await mintA2aApiKey({ projectId: 'p2', workspaceId: 'w2', createdBy: 'u2', name: 'other project' })

    const list = await listA2aApiKeys('p1')
    expect(list).toHaveLength(2)
    expect(list[0].name).toBe(newer.name)
    expect(list.every((k) => !('hashedSecret' in k))).toBe(true)
  })
})

describe('revokeA2aApiKey', () => {
  it('revokes a key scoped to the correct project and returns true', async () => {
    const minted = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    const ok = await revokeA2aApiKey({ id: minted.id, projectId: 'p1' })
    expect(ok).toBe(true)
    expect(rows.find((r) => r.id === minted.id)?.revokedAt).toBeInstanceOf(Date)
  })

  it('returns false for a key belonging to a different project (no cross-project revoke)', async () => {
    const minted = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    const ok = await revokeA2aApiKey({ id: minted.id, projectId: 'p2' })
    expect(ok).toBe(false)
    expect(rows.find((r) => r.id === minted.id)?.revokedAt).toBeNull()
  })

  it('returns false when already revoked', async () => {
    const minted = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    expect(await revokeA2aApiKey({ id: minted.id, projectId: 'p1' })).toBe(true)
    expect(await revokeA2aApiKey({ id: minted.id, projectId: 'p1' })).toBe(false)
  })

  it('returns false for an unknown id', async () => {
    expect(await revokeA2aApiKey({ id: 'nope', projectId: 'p1' })).toBe(false)
  })
})

describe('verifyA2aApiKey', () => {
  it('accepts a freshly minted key for its own project', async () => {
    const minted = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    const result = await verifyA2aApiKey(minted.fullKey, 'p1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.key).toEqual({ id: minted.id, keyId: minted.keyId, projectId: 'p1', workspaceId: 'w1' })
    }
  })

  it('bumps lastUsedAt on success (fire-and-forget)', async () => {
    const minted = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    await verifyA2aApiKey(minted.fullKey, 'p1')
    // The update is fire-and-forget; flush microtasks before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rows.find((r) => r.id === minted.id)?.lastUsedAt).toBeInstanceOf(Date)
  })

  it('rejects a token with the wrong prefix', async () => {
    expect((await verifyA2aApiKey('shogo_sk_deadbeef.secret', 'p1')).ok).toBe(false)
  })

  it('rejects a malformed token with no dot separator', async () => {
    expect((await verifyA2aApiKey(`${SHOGO_A2A_KEY_PREFIX}abcdef`, 'p1')).ok).toBe(false)
  })

  it('rejects a malformed token with an empty keyId or empty secret', async () => {
    expect((await verifyA2aApiKey(`${SHOGO_A2A_KEY_PREFIX}.secret`, 'p1')).ok).toBe(false)
    expect((await verifyA2aApiKey(`${SHOGO_A2A_KEY_PREFIX}abcdef.`, 'p1')).ok).toBe(false)
  })

  it('rejects an unknown keyId', async () => {
    expect((await verifyA2aApiKey(`${SHOGO_A2A_KEY_PREFIX}000000000000000000000000.deadbeef`, 'p1')).ok).toBe(false)
  })

  it('rejects a revoked key', async () => {
    const minted = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    await revokeA2aApiKey({ id: minted.id, projectId: 'p1' })
    expect((await verifyA2aApiKey(minted.fullKey, 'p1')).ok).toBe(false)
  })

  it('rejects an expired key', async () => {
    const minted = await mintA2aApiKey({
      projectId: 'p1',
      workspaceId: 'w1',
      createdBy: 'u1',
      expiresAt: new Date(Date.now() - 1000),
    })
    expect((await verifyA2aApiKey(minted.fullKey, 'p1')).ok).toBe(false)
  })

  it('accepts a key that has not expired yet', async () => {
    const minted = await mintA2aApiKey({
      projectId: 'p1',
      workspaceId: 'w1',
      createdBy: 'u1',
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect((await verifyA2aApiKey(minted.fullKey, 'p1')).ok).toBe(true)
  })

  it('rejects a key presented for the wrong project', async () => {
    const minted = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    expect((await verifyA2aApiKey(minted.fullKey, 'p2')).ok).toBe(false)
  })

  it('rejects a valid keyId with a tampered secret', async () => {
    const minted = await mintA2aApiKey({ projectId: 'p1', workspaceId: 'w1', createdBy: 'u1' })
    const tampered = `${SHOGO_A2A_KEY_PREFIX}${minted.keyId}.${'0'.repeat(64)}`
    expect((await verifyA2aApiKey(tampered, 'p1')).ok).toBe(false)
  })
})
