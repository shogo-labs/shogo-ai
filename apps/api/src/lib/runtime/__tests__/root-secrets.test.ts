// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-384: the API-side store for a workspace root's `.env*`.
 *
 * Real sqlite (desktop migrations) for the rows, real AES for the envelope:
 * the point of these tests is that nothing readable reaches the database and
 * that a blob only opens for the runtime it was written for.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64')

const {
  WORKSPACE_ROOT_SECRETS_KEY_PURPOSE,
  RootSecretsDecryptError,
  deleteRootSecrets,
  openRootSecrets,
  readRootSecrets,
  sealRootSecrets,
  writeRootSecrets,
} = await import('../root-secrets')
const { workspaceSecretsTag } = await import('@shogo/shared-runtime/workspace-root-secrets')
const { prisma } = await import('../../prisma')

function payload(entries: Record<string, string>, slot = 'root') {
  return {
    version: 1 as const,
    slots: [
      {
        slot,
        files: Object.entries(entries).map(([name, value]) => ({
          name,
          content: Buffer.from(value).toString('base64'),
          mode: 0o600,
          mtimeMs: 1_700_000_000_000,
        })),
      },
    ],
  }
}

afterAll(async () => {
  await prisma.workspaceRootSecret.deleteMany({})
  await prisma.$disconnect().catch(() => {})
  const { rmSync } = await import('node:fs')
  rmSync(dir, { recursive: true, force: true })
})

describe('seal / open', () => {
  test('round-trips the payload and leaves nothing readable in the blob', () => {
    const secrets = payload({ '.env': 'STRIPE_KEY=sk_test_123\n' })
    const blob = sealRootSecrets('ws:w1', secrets)
    expect(blob).not.toContain('STRIPE_KEY')
    expect(blob).not.toContain(Buffer.from('STRIPE_KEY').toString('base64').slice(0, 8))
    expect(openRootSecrets('ws:w1', blob)).toEqual(secrets)
  })

  test('a blob does not open for another runtime, even holding the same key material', () => {
    const blob = sealRootSecrets('ws:w1', payload({ '.env': 'A=1\n' }))
    expect(() => openRootSecrets('ws:w2', blob)).toThrow(RootSecretsDecryptError)
    expect(() => openRootSecrets('ws:proj:p1', blob)).toThrow(RootSecretsDecryptError)
  })

  test('a different purpose derives a different key (the AAD is not the only guard)', async () => {
    const { deriveProjectKey } = await import('../../secret-crypto')
    const homeStateKey = deriveProjectKey('home-state:v1', 'ws:w1')
    const rootSecretsKey = deriveProjectKey(WORKSPACE_ROOT_SECRETS_KEY_PURPOSE, 'ws:w1')
    expect(homeStateKey.equals(rootSecretsKey)).toBe(false)
  })

  test('a tampered ciphertext fails the tag check instead of returning garbage', () => {
    const blob = sealRootSecrets('ws:w1', payload({ '.env': 'A=1\n' }))
    const parts = blob.split(':')
    const bytes = Buffer.from(parts[3]!, 'base64')
    bytes[0] = bytes[0]! ^ 0xff
    const tampered = [parts[0], parts[1], parts[2], bytes.toString('base64')].join(':')
    expect(() => openRootSecrets('ws:w1', tampered)).toThrow(RootSecretsDecryptError)
  })
})

describe('store', () => {
  test('writes a row whose ciphertext holds none of the plaintext', async () => {
    await writeRootSecrets('ws:store-1', payload({ '.env': 'TOKEN=abc123\n' }))
    const row = await prisma.workspaceRootSecret.findUnique({ where: { runtimeKey: 'ws:store-1' } })
    expect(row).not.toBeNull()
    expect(row!.ciphertext).not.toContain('TOKEN')
    expect(row!.ciphertext).not.toContain('abc123')
    expect(row!.tag).toBe(workspaceSecretsTag(payload({ '.env': 'TOKEN=abc123\n' }) as any))

    const stored = await readRootSecrets('ws:store-1')
    expect(stored?.secrets.slots[0]!.files[0]!.name).toBe('.env')
    expect(Buffer.from(stored!.secrets.slots[0]!.files[0]!.content, 'base64').toString()).toBe('TOKEN=abc123\n')
    await deleteRootSecrets('ws:store-1')
  })

  test('an unchanged payload writes nothing, a changed one replaces the row', async () => {
    const first = await writeRootSecrets('ws:store-2', payload({ '.env': 'A=1\n' }))
    expect(first.stored).toBe(true)
    const before = await prisma.workspaceRootSecret.findUnique({ where: { runtimeKey: 'ws:store-2' } })

    const again = await writeRootSecrets('ws:store-2', payload({ '.env': 'A=1\n' }))
    expect(again.stored).toBe(false)
    expect(again.tag).toBe(first.tag)
    const afterNoop = await prisma.workspaceRootSecret.findUnique({ where: { runtimeKey: 'ws:store-2' } })
    expect(afterNoop!.updatedAt.getTime()).toBe(before!.updatedAt.getTime())

    const changed = await writeRootSecrets('ws:store-2', payload({ '.env': 'A=2\n' }))
    expect(changed.stored).toBe(true)
    expect(changed.tag).not.toBe(first.tag)
    const rows = await prisma.workspaceRootSecret.count({ where: { runtimeKey: 'ws:store-2' } })
    expect(rows).toBe(1)
    await deleteRootSecrets('ws:store-2')
  })

  test('an empty slot is stored as a real, readable payload (a deleted .env stays deleted)', async () => {
    await writeRootSecrets('ws:store-3', payload({ '.env': 'A=1\n' }))
    await writeRootSecrets('ws:store-3', { version: 1, slots: [{ slot: 'root', files: [] }] })
    const stored = await readRootSecrets('ws:store-3')
    expect(stored!.secrets.slots).toEqual([{ slot: 'root', files: [] }])
    await deleteRootSecrets('ws:store-3')
  })

  test('refuses a payload that names a non-secret file', async () => {
    await expect(
      writeRootSecrets('ws:store-4', payload({ 'MEMORY.md': 'hi' })),
    ).rejects.toThrow('non-secret file name')
    expect(await readRootSecrets('ws:store-4')).toBeNull()
  })

  test('a runtime that never exported reads null instead of inventing one', async () => {
    expect(await readRootSecrets('ws:never')).toBeNull()
  })
})

beforeAll(() => {
  // The table the migrations created must be the one Prisma knows.
  expect(prisma.workspaceRootSecret).toBeDefined()
})
