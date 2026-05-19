// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  SHOGO_API_KEY_PREFIX,
  SHOGO_API_KEY_RANDOM_BYTES,
  SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH,
  hashApiKey,
  generateApiKey,
  mintDeviceApiKey,
} from '../api-keys-mint'

describe('constants', () => {
  it('SHOGO_API_KEY_PREFIX is "shogo_sk_"', () => {
    expect(SHOGO_API_KEY_PREFIX).toBe('shogo_sk_')
  })
  it('SHOGO_API_KEY_RANDOM_BYTES is 32', () => {
    expect(SHOGO_API_KEY_RANDOM_BYTES).toBe(32)
  })
  it('SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH = prefix.length + 8', () => {
    expect(SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH).toBe(SHOGO_API_KEY_PREFIX.length + 8)
  })
})

describe('hashApiKey', () => {
  it('is deterministic for a given key', async () => {
    const a = await hashApiKey('shogo_sk_abc')
    const b = await hashApiKey('shogo_sk_abc')
    expect(a).toBe(b)
  })
  it('produces a 64-character lowercase hex string (SHA-256)', async () => {
    const h = await hashApiKey('shogo_sk_anything')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
  it('differs for different inputs', async () => {
    const a = await hashApiKey('a')
    const b = await hashApiKey('b')
    expect(a).not.toBe(b)
  })
})

describe('generateApiKey', () => {
  it('returns the documented triple with correct shape', async () => {
    const r = await generateApiKey()
    expect(r.fullKey.startsWith(SHOGO_API_KEY_PREFIX)).toBe(true)
    expect(r.fullKey.length).toBe(SHOGO_API_KEY_PREFIX.length + SHOGO_API_KEY_RANDOM_BYTES * 2)
    expect(r.keyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.keyPrefix.length).toBe(SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH)
    expect(r.keyPrefix).toBe(r.fullKey.slice(0, SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH))
  })
  it('produces a unique key on every call', async () => {
    const a = await generateApiKey()
    const b = await generateApiKey()
    expect(a.fullKey).not.toBe(b.fullKey)
    expect(a.keyHash).not.toBe(b.keyHash)
  })
  it("hashes fullKey to keyHash (round-trip)", async () => {
    const r = await generateApiKey()
    expect(await hashApiKey(r.fullKey)).toBe(r.keyHash)
  })
})

describe('mintDeviceApiKey', () => {
  function makePrismaStub(opts: { existingRows?: any[] } = {}) {
    const updateManyCalls: any[] = []
    const createCalls: any[] = []
    const txCalls: any[] = []
    let existing = opts.existingRows ?? []
    const stub = {
      $transaction: async (fn: any) => {
        txCalls.push(true)
        const tx = {
          apiKey: {
            updateMany: async (args: any) => {
              updateManyCalls.push(args)
              const before = existing.length
              existing = existing.map((e) =>
                e.workspaceId === args.where.workspaceId &&
                e.deviceId === args.where.deviceId &&
                e.kind === args.where.kind &&
                e.revokedAt === null
                  ? { ...e, ...args.data }
                  : e,
              )
              return { count: before }
            },
            create: async ({ data }: any) => {
              createCalls.push(data)
              const row = { id: `ak_${createCalls.length}`, ...data }
              existing.push(row)
              return row
            },
          },
        }
        return fn(tx)
      },
    } as any
    return { stub, updateManyCalls, createCalls, txCalls, get rows() { return existing } }
  }

  it('mints a device key inside one transaction', async () => {
    const { stub, txCalls, createCalls } = makePrismaStub()
    const r = await mintDeviceApiKey({
      prisma: stub,
      workspaceId: 'w1',
      userId: 'u1',
      deviceId: 'd1',
      deviceName: 'My Mac',
      devicePlatform: 'darwin-arm64',
      deviceAppVersion: '1.2.3',
    })
    expect(txCalls).toHaveLength(1)
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0].name).toBe('My Mac')
    expect(createCalls[0].devicePlatform).toBe('darwin-arm64')
    expect(createCalls[0].deviceAppVersion).toBe('1.2.3')
    expect(createCalls[0].kind).toBe('device')
    expect(r.fullKey.startsWith('shogo_sk_')).toBe(true)
    expect(r.keyPrefix.length).toBe(SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH)
  })

  it('soft-revokes any existing un-revoked device key for the same (workspace, device)', async () => {
    const { stub, updateManyCalls } = makePrismaStub({
      existingRows: [
        {
          id: 'old',
          workspaceId: 'w1',
          deviceId: 'd1',
          kind: 'device',
          revokedAt: null,
        },
      ],
    })
    await mintDeviceApiKey({
      prisma: stub,
      workspaceId: 'w1',
      userId: 'u1',
      deviceId: 'd1',
    })
    expect(updateManyCalls).toHaveLength(1)
    expect(updateManyCalls[0].where).toMatchObject({
      workspaceId: 'w1',
      deviceId: 'd1',
      kind: 'device',
      revokedAt: null,
    })
    expect(updateManyCalls[0].data.revokedAt).toBeInstanceOf(Date)
  })

  it('truncates deviceName to 120 chars', async () => {
    const { stub, createCalls } = makePrismaStub()
    const long = 'x'.repeat(500)
    await mintDeviceApiKey({
      prisma: stub,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
      deviceName: long,
    })
    expect(createCalls[0].name.length).toBe(120)
    expect(createCalls[0].deviceName.length).toBe(120)
  })

  it('truncates devicePlatform and deviceAppVersion to 32 chars', async () => {
    const { stub, createCalls } = makePrismaStub()
    const long = 'y'.repeat(200)
    await mintDeviceApiKey({
      prisma: stub,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
      devicePlatform: long,
      deviceAppVersion: long,
    })
    expect(createCalls[0].devicePlatform.length).toBe(32)
    expect(createCalls[0].deviceAppVersion.length).toBe(32)
  })

  it('falls back to "Shogo Device" when no deviceName/defaultDeviceName is given', async () => {
    const { stub, createCalls } = makePrismaStub()
    await mintDeviceApiKey({
      prisma: stub,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
    })
    expect(createCalls[0].name).toBe('Shogo Device')
  })

  it('uses defaultDeviceName when deviceName is empty', async () => {
    const { stub, createCalls } = makePrismaStub()
    await mintDeviceApiKey({
      prisma: stub,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
      deviceName: '',
      defaultDeviceName: 'CLI Device',
    })
    expect(createCalls[0].name).toBe('CLI Device')
  })

  it('leaves devicePlatform/deviceAppVersion undefined when not passed', async () => {
    const { stub, createCalls } = makePrismaStub()
    await mintDeviceApiKey({
      prisma: stub,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
    })
    expect(createCalls[0].devicePlatform).toBeUndefined()
    expect(createCalls[0].deviceAppVersion).toBeUndefined()
  })
})
