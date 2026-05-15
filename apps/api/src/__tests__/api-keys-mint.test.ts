// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  SHOGO_API_KEY_PREFIX,
  SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH,
  SHOGO_API_KEY_RANDOM_BYTES,
  generateApiKey,
  hashApiKey,
  mintDeviceApiKey,
} from '../lib/api-keys-mint'

describe('public constants', () => {
  test('SHOGO_API_KEY_PREFIX is the documented "shogo_sk_"', () => {
    expect(SHOGO_API_KEY_PREFIX).toBe('shogo_sk_')
  })

  test('SHOGO_API_KEY_RANDOM_BYTES is 32 bytes', () => {
    expect(SHOGO_API_KEY_RANDOM_BYTES).toBe(32)
  })

  test('SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH is prefix.length + 8 hex chars', () => {
    expect(SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH).toBe(SHOGO_API_KEY_PREFIX.length + 8)
    expect(SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH).toBe(17)
  })
})

describe('hashApiKey', () => {
  test('produces a 64-char lowercase hex SHA-256 digest', async () => {
    const hash = await hashApiKey('shogo_sk_test')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('is deterministic (same input → same hash)', async () => {
    const a = await hashApiKey('same-key')
    const b = await hashApiKey('same-key')
    expect(a).toBe(b)
  })

  test('different inputs produce different hashes', async () => {
    const a = await hashApiKey('key-one')
    const b = await hashApiKey('key-two')
    expect(a).not.toBe(b)
  })

  test('matches a known SHA-256 vector (empty string)', async () => {
    // sha256('') = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(await hashApiKey('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  test('handles unicode input correctly (UTF-8 encoded before hashing)', async () => {
    // sha256(utf8('héllo')) — emoji and non-ASCII must not crash.
    const h = await hashApiKey('héllo 🔑')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('generateApiKey', () => {
  test('returns the documented {fullKey, keyHash, keyPrefix} triple', async () => {
    const out = await generateApiKey()
    expect(Object.keys(out).sort()).toEqual(['fullKey', 'keyHash', 'keyPrefix'])
  })

  test('fullKey starts with shogo_sk_ and has prefix + 64 hex chars (32 bytes × 2)', async () => {
    const { fullKey } = await generateApiKey()
    expect(fullKey.startsWith(SHOGO_API_KEY_PREFIX)).toBe(true)
    const suffix = fullKey.slice(SHOGO_API_KEY_PREFIX.length)
    expect(suffix).toMatch(/^[0-9a-f]{64}$/)
    expect(fullKey.length).toBe(SHOGO_API_KEY_PREFIX.length + 64)
  })

  test('keyHash is the SHA-256 hex of fullKey', async () => {
    const { fullKey, keyHash } = await generateApiKey()
    expect(keyHash).toBe(await hashApiKey(fullKey))
  })

  test('keyPrefix is the first 17 chars of fullKey (prefix + 8 hex)', async () => {
    const { fullKey, keyPrefix } = await generateApiKey()
    expect(keyPrefix).toBe(fullKey.slice(0, SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH))
    expect(keyPrefix.length).toBe(17)
  })

  test('two consecutive keys are different (random suffix has entropy)', async () => {
    const a = await generateApiKey()
    const b = await generateApiKey()
    expect(a.fullKey).not.toBe(b.fullKey)
    expect(a.keyHash).not.toBe(b.keyHash)
  })

  test('100 keys produce 100 unique values (no collisions in practice)', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const { fullKey } = await generateApiKey()
      seen.add(fullKey)
    }
    expect(seen.size).toBe(100)
  })
})

describe('mintDeviceApiKey', () => {
  function makeFakePrisma() {
    const updateMany = mock(async (_: any) => ({ count: 0 }))
    const create = mock(async (args: any) => ({
      id: 'apikey_generated_id',
      name: args.data.name,
      workspaceId: args.data.workspaceId,
      deviceId: args.data.deviceId ?? null,
      deviceName: args.data.deviceName ?? null,
      devicePlatform: args.data.devicePlatform ?? null,
      deviceAppVersion: args.data.deviceAppVersion ?? null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      kind: args.data.kind ?? 'device',
    }))
    const transaction = mock(async (fn: any) =>
      fn({ apiKey: { updateMany, create } })
    )
    return {
      prisma: { $transaction: transaction } as any,
      updateMany,
      create,
      transaction,
    }
  }

  beforeEach(() => {})

  test('mints a key inside a single $transaction with revoke-then-create order', async () => {
    const p = makeFakePrisma()
    const order: string[] = []
    p.updateMany.mockImplementation(async () => {
      order.push('updateMany')
      return { count: 0 }
    })
    p.create.mockImplementation(async (args: any) => {
      order.push('create')
      return {
        id: 'x',
        name: args.data.name,
        workspaceId: args.data.workspaceId,
        deviceId: args.data.deviceId,
        deviceName: args.data.deviceName,
        devicePlatform: args.data.devicePlatform,
        deviceAppVersion: args.data.deviceAppVersion,
        createdAt: new Date(),
        kind: 'device',
      }
    })

    await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'ws_1',
      userId: 'user_1',
      deviceId: 'dev_1',
    })

    expect(p.transaction).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['updateMany', 'create'])
  })

  test('soft-revokes prior un-revoked device keys for (workspaceId, deviceId, kind=device)', async () => {
    const p = makeFakePrisma()
    await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'ws_dedupe',
      userId: 'user_1',
      deviceId: 'dev_dedupe',
    })

    expect(p.updateMany).toHaveBeenCalledTimes(1)
    const args = p.updateMany.mock.calls[0][0]
    expect(args.where).toEqual({
      workspaceId: 'ws_dedupe',
      deviceId: 'dev_dedupe',
      kind: 'device',
      revokedAt: null,
    })
    expect(args.data.revokedAt).toBeInstanceOf(Date)
  })

  test('passes the generated keyHash + keyPrefix + lastSeenAt to apiKey.create', async () => {
    const p = makeFakePrisma()
    const result = await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'ws_2',
      userId: 'user_2',
      deviceId: 'dev_2',
      deviceName: 'Ash MBP',
      devicePlatform: 'darwin-arm64',
      deviceAppVersion: '1.2.20',
    })

    const args = p.create.mock.calls[0][0]
    expect(args.data.keyHash).toBe(await hashApiKey(result.fullKey))
    expect(args.data.keyPrefix).toBe(result.keyPrefix)
    expect(args.data.kind).toBe('device')
    expect(args.data.workspaceId).toBe('ws_2')
    expect(args.data.userId).toBe('user_2')
    expect(args.data.deviceId).toBe('dev_2')
    expect(args.data.deviceName).toBe('Ash MBP')
    expect(args.data.devicePlatform).toBe('darwin-arm64')
    expect(args.data.deviceAppVersion).toBe('1.2.20')
    expect(args.data.lastSeenAt).toBeInstanceOf(Date)
  })

  test('truncates deviceName to 120 chars', async () => {
    const p = makeFakePrisma()
    const longName = 'A'.repeat(500)
    await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
      deviceName: longName,
    })
    expect(p.create.mock.calls[0][0].data.deviceName.length).toBe(120)
  })

  test('truncates devicePlatform and deviceAppVersion to 32 chars', async () => {
    const p = makeFakePrisma()
    await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
      devicePlatform: 'P'.repeat(200),
      deviceAppVersion: 'V'.repeat(200),
    })
    const data = p.create.mock.calls[0][0].data
    expect(data.devicePlatform.length).toBe(32)
    expect(data.deviceAppVersion.length).toBe(32)
  })

  test('defaults deviceName to "Shogo Device" when neither deviceName nor defaultDeviceName is supplied', async () => {
    const p = makeFakePrisma()
    await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
    })
    expect(p.create.mock.calls[0][0].data.deviceName).toBe('Shogo Device')
  })

  test('uses defaultDeviceName when deviceName is missing', async () => {
    const p = makeFakePrisma()
    await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
      defaultDeviceName: 'CLI Login',
    })
    expect(p.create.mock.calls[0][0].data.deviceName).toBe('CLI Login')
  })

  test('uses defaultDeviceName when deviceName is the empty string (falsy)', async () => {
    const p = makeFakePrisma()
    await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
      deviceName: '',
      defaultDeviceName: 'CLI Login',
    })
    expect(p.create.mock.calls[0][0].data.deviceName).toBe('CLI Login')
  })

  test('explicit deviceName wins over defaultDeviceName', async () => {
    const p = makeFakePrisma()
    await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
      deviceName: 'My Laptop',
      defaultDeviceName: 'CLI Login',
    })
    expect(p.create.mock.calls[0][0].data.deviceName).toBe('My Laptop')
  })

  test('leaves devicePlatform/deviceAppVersion undefined when not supplied', async () => {
    const p = makeFakePrisma()
    await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
    })
    const data = p.create.mock.calls[0][0].data
    expect(data.devicePlatform).toBeUndefined()
    expect(data.deviceAppVersion).toBeUndefined()
  })

  test('returns the {fullKey, apiKey, keyPrefix} shape', async () => {
    const p = makeFakePrisma()
    const out = await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'ws_1',
      userId: 'user_1',
      deviceId: 'dev_1',
    })
    expect(out.fullKey.startsWith(SHOGO_API_KEY_PREFIX)).toBe(true)
    expect(out.keyPrefix).toBe(out.fullKey.slice(0, SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH))
    expect(out.apiKey.kind).toBe('device')
  })

  test('propagates transaction errors to the caller', async () => {
    const p = makeFakePrisma()
    p.create.mockImplementation(async () => {
      throw new Error('unique constraint failed: keyHash')
    })
    await expect(
      mintDeviceApiKey({
        prisma: p.prisma,
        workspaceId: 'w',
        userId: 'u',
        deviceId: 'd',
      })
    ).rejects.toThrow('unique constraint failed: keyHash')
  })

  test('two consecutive mints produce different fullKey/keyHash (entropy preserved through wrapper)', async () => {
    const p = makeFakePrisma()
    const a = await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
    })
    const b = await mintDeviceApiKey({
      prisma: p.prisma,
      workspaceId: 'w',
      userId: 'u',
      deviceId: 'd',
    })
    expect(a.fullKey).not.toBe(b.fullKey)
    expect(a.apiKey).not.toBe(b.apiKey)
  })
})
