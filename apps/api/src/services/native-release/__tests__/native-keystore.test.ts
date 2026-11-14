// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Android upload keystore: what is accepted at save time, and what a read
 * is allowed to return.
 *
 * The keystore is the one credential that cannot be re-issued, and the one
 * whose *file* we can check without Java: a JKS starts with 0xFEEDFEED, a
 * PKCS#12 with a DER SEQUENCE. Everything else — a pasted path, a PNG, an
 * empty string — has to be refused when it is saved, not the first time a
 * release needs it.
 *
 * The masking half is just as important: `listCredentials` is what a settings
 * page reads, and it must never carry the file, the passwords or the alias in
 * the clear.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { prismaProxy, useFakePrisma } from './prisma-fixture'

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

const rows = new Map<string, Record<string, any>>()

const fakePrisma = {
  nativeAppCredential: {
    async findMany({ where }: any) {
      return [...rows.values()].filter((r) => r.workspaceId === where.workspaceId)
    },
    async findUnique({ where }: any) {
      const { workspaceId, kind } = where.workspaceId_kind
      return rows.get(`${workspaceId}:${kind}`) ?? null
    },
    async upsert({ where, create, update }: any) {
      const { workspaceId, kind } = where.workspaceId_kind
      const key = `${workspaceId}:${kind}`
      const next = { id: key, workspaceId, kind, ...(rows.has(key) ? update : create) }
      rows.set(key, next)
      return next
    },
    async deleteMany({ where }: any) {
      const key = `${where.workspaceId}:${where.kind}`
      const existed = rows.delete(key)
      return { count: existed ? 1 : 0 }
    },
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: prismaProxy }))
useFakePrisma(fakePrisma)

const { NativeReleaseError } = await import('../client')
const {
  exportAndroidKeystore,
  listCredentials,
  parseAndroidKeystore,
  readAndroidKeystore,
  saveCredential,
} = await import('../credentials.service')

/** A JKS-shaped file: the magic, then filler, which is all we can verify. */
function jksBase64(padding = 400): string {
  const bytes = Buffer.alloc(padding)
  bytes.writeUInt32BE(0xfeedfeed, 0)
  bytes.fill(0x2a, 4)
  return bytes.toString('base64')
}

function pkcs12Base64(): string {
  const bytes = Buffer.alloc(400)
  bytes[0] = 0x30
  bytes[1] = 0x82
  return bytes.toString('base64')
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    keystoreBase64: jksBase64(),
    keystorePassword: 'hunter2',
    keyAlias: 'upload',
    keyPassword: 'hunter2',
    ...overrides,
  }
}

const noValidation = async () => {}

beforeEach(() => rows.clear())
afterEach(() => rows.clear())

describe('parseAndroidKeystore', () => {
  it('accepts a JKS file', () => {
    const parsed = parseAndroidKeystore(payload())
    expect(parsed.keyAlias).toBe('upload')
    expect(parsed.keystorePassword).toBe('hunter2')
  })

  it('accepts a PKCS#12 export', () => {
    expect(parseAndroidKeystore(payload({ keystoreBase64: pkcs12Base64() })).keyAlias).toBe('upload')
  })

  it('strips a data-URL prefix and whitespace, so a pasted upload still works', () => {
    const uploaded = `data:application/octet-stream;base64,${jksBase64()}`
    const wrapped = uploaded.replace(/(.{60})/g, '$1\n')
    const parsed = parseAndroidKeystore(payload({ keystoreBase64: wrapped }))
    expect(parsed.keystoreBase64).toBe(jksBase64())
  })

  it('refuses a file that is not a keystore at all', () => {
    // A PNG header: base64-decodable, 400 bytes, wrong magic.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(400, 1)])
    expect(() => parseAndroidKeystore(payload({ keystoreBase64: png.toString('base64') }))).toThrow(
      /not a JKS\/JCEKS or PKCS#12 keystore/,
    )
  })

  it('refuses a pasted file path instead of silently storing nothing', () => {
    expect(() => parseAndroidKeystore(payload({ keystoreBase64: '~/keys/upload-keystore.jks' }))).toThrow(
      NativeReleaseError,
    )
  })

  it('requires all three signing values — the key password included', () => {
    for (const field of ['keystorePassword', 'keyAlias', 'keyPassword']) {
      try {
        parseAndroidKeystore(payload({ [field]: '' }))
        throw new Error(`expected ${field} to be required`)
      } catch (err) {
        expect(err).toBeInstanceOf(NativeReleaseError)
        expect((err as InstanceType<typeof NativeReleaseError>).code).toBe('keystore_incomplete')
        expect((err as Error).message).toContain(field)
      }
    }
  })
})

describe('the keystore at rest', () => {
  it('is encrypted, and the summary carries only a mask of the alias', async () => {
    const summary = await saveCredential('ws_1', 'android_keystore', payload(), noValidation)
    expect(summary.kind).toBe('android_keystore')
    expect(summary.maskedHint).not.toContain('upload')
    expect(summary.validatedAt).not.toBeNull()

    const stored = rows.get('ws_1:android_keystore')!
    expect(stored.encryptedPayload).not.toContain(jksBase64())
    expect(stored.encryptedPayload).not.toContain('hunter2')
    expect(stored.encryptedPayload).not.toContain('upload')
  })

  it('never returns the secret through the list a settings page reads', async () => {
    await saveCredential('ws_1', 'android_keystore', payload(), noValidation)
    const listed = await listCredentials('ws_1')
    expect(listed).toHaveLength(1)
    expect(Object.keys(listed[0]).sort()).toEqual(['kind', 'maskedHint', 'validatedAt'])
    expect(JSON.stringify(listed)).not.toContain('hunter2')
  })

  it('round-trips for the owner, so the copy is worth keeping', async () => {
    await saveCredential('ws_1', 'android_keystore', payload(), noValidation)
    const read = await readAndroidKeystore('ws_1')
    expect(read).toEqual({
      keystoreBase64: jksBase64(),
      keystorePassword: 'hunter2',
      keyAlias: 'upload',
      keyPassword: 'hunter2',
    })
    expect(await exportAndroidKeystore('ws_1')).toEqual(read)
  })

  it('is per workspace, and a workspace with none reads as null', async () => {
    await saveCredential('ws_1', 'android_keystore', payload(), noValidation)
    expect(await readAndroidKeystore('ws_2')).toBeNull()
    expect(await exportAndroidKeystore('ws_2')).toBeNull()
  })

  it('replaces the stored keystore instead of stacking a second one', async () => {
    await saveCredential('ws_1', 'android_keystore', payload(), noValidation)
    await saveCredential('ws_1', 'android_keystore', payload({ keyAlias: 'new-alias' }), noValidation)
    expect(rows.size).toBe(1)
    expect((await readAndroidKeystore('ws_1'))?.keyAlias).toBe('new-alias')
  })
})
