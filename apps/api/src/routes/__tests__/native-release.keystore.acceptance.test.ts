// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-395 acceptance, at the HTTP surface: the Android upload keystore is stored
 * encrypted per workspace, never handed back by a read a settings page makes,
 * downloadable only on the owner's own POST, and revocable.
 *
 * The unit test proves the parsing and the encryption. This one proves the thing
 * the user actually experiences: they can save the key, see only a mask, pull
 * their own copy back once, and make it disappear — and that a viewer can do
 * none of it.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { prismaProxy, useFakePrisma } from '../../services/native-release/__tests__/prisma-fixture'

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

const rows = new Map<string, Record<string, any>>()

const nativeAppCredential = {
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
    return { count: rows.delete(key) ? 1 : 0 }
  },
}

/** owner can write and read; viewer is a read-only member of the same workspace. */
const ROLES: Record<string, string> = { user_owner: 'owner', user_viewer: 'viewer' }

const fakePrisma = {
  nativeAppCredential,
  project: { findUnique: async () => null },
  // `getWorkspaceRole` reads the member row, so the role is stubbed at that level
  // rather than by replacing conversation.service (mock.module is process-wide).
  member: {
    findFirst: async ({ where }: any) => {
      const role = ROLES[where?.userId]
      return role ? { role } : null
    },
  },
}

mock.module('../../lib/prisma', () => ({ prisma: prismaProxy }))
useFakePrisma(fakePrisma)

const { nativeReleaseRoutes } = await import('../native-release')

const WS = 'ws_1'

function app(userId: string | null) {
  const hono = new Hono()
  hono.route('/api', nativeReleaseRoutes({ resolveUserId: async () => userId }))
  return hono
}

async function call(
  userId: string | null,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await app(userId).request(path, {
    method: init.method ?? 'GET',
    ...(init.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
  })
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) }
}

/** A JKS-shaped file: the magic, then filler — all that can be checked without Java. */
function jksBase64(): string {
  const bytes = Buffer.alloc(400)
  bytes.writeUInt32BE(0xfeedfeed, 0)
  bytes.fill(0x2a, 4)
  return bytes.toString('base64')
}

const keystore = () => ({
  keystoreBase64: jksBase64(),
  keystorePassword: 'store-pass-9f3',
  keyAlias: 'upload',
  keyPassword: 'key-pass-4c1',
})

const base = `/api/workspaces/${WS}/native/credentials`

beforeEach(() => rows.clear())

describe('SHO-395: the Android upload keystore through the API', () => {
  it('saves it, masks the read, hands back one copy, and revokes it', async () => {
    const saved = await call('user_owner', `${base}/android_keystore`, { method: 'PUT', body: keystore() })
    expect(saved.status).toBe(200)
    expect(saved.json.credential.kind).toBe('android_keystore')
    // The save response is what the settings card renders: a mask, nothing else.
    expect(JSON.stringify(saved.json)).not.toContain(jksBase64())
    expect(JSON.stringify(saved.json)).not.toContain('store-pass-9f3')
    expect(JSON.stringify(saved.json)).not.toContain('key-pass-4c1')

    // At rest: encrypted, so neither the file nor a password is readable in the row.
    const stored = [...rows.values()][0]
    expect(stored.encryptedPayload).not.toContain(jksBase64())
    expect(stored.encryptedPayload).not.toContain('store-pass-9f3')
    expect(stored.encryptedPayload).not.toContain('upload')

    const listed = await call('user_owner', base)
    expect(listed.status).toBe(200)
    expect(listed.json.credentials.map((c: any) => c.kind)).toEqual(['android_keystore'])
    expect(Object.keys(listed.json.credentials[0]).sort()).toEqual(['kind', 'maskedHint', 'validatedAt'])
    expect(JSON.stringify(listed.json)).not.toContain('store-pass-9f3')

    // The owner's own copy: POST, never cached, and the only place plaintext leaves.
    const exported = await call('user_owner', `${base}/android_keystore/export`, { method: 'POST', body: {} })
    expect(exported.status).toBe(200)
    expect(exported.headers.get('cache-control')).toBe('no-store')
    expect(exported.json).toEqual({
      filename: 'upload-keystore.jks',
      keystoreBase64: jksBase64(),
      keystorePassword: 'store-pass-9f3',
      keyAlias: 'upload',
      keyPassword: 'key-pass-4c1',
    })

    expect((await call('user_owner', `${base}/android_keystore`, { method: 'DELETE' })).status).toBe(200)
    expect(rows.size).toBe(0)
    const afterRevoke = await call('user_owner', `${base}/android_keystore/export`, { method: 'POST', body: {} })
    expect(afterRevoke.status).toBe(404)
    expect(afterRevoke.json.error.code).toBe('keystore_missing')
  })

  it('refuses a file that is not a keystore, and stores nothing', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(400, 1)]).toString('base64')
    const res = await call('user_owner', `${base}/android_keystore`, {
      method: 'PUT',
      body: { ...keystore(), keystoreBase64: png },
    })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('keystore_invalid')
    expect(rows.size).toBe(0)
  })

  it('keeps the workspace honest: a viewer cannot upload, export or revoke', async () => {
    await call('user_owner', `${base}/android_keystore`, { method: 'PUT', body: keystore() })

    const save = await call('user_viewer', `${base}/android_keystore`, { method: 'PUT', body: keystore() })
    expect(save.status).toBe(403)

    const exported = await call('user_viewer', `${base}/android_keystore/export`, { method: 'POST', body: {} })
    expect(exported.status).toBe(403)
    expect(exported.json).not.toHaveProperty('keystoreBase64')

    const revoked = await call('user_viewer', `${base}/android_keystore`, { method: 'DELETE' })
    expect(revoked.status).toBe(403)
    expect(rows.size).toBe(1)
  })

  it('never reaches another workspace', async () => {
    await call('user_owner', `${base}/android_keystore`, { method: 'PUT', body: keystore() })
    const other = await call('user_owner', `/api/workspaces/ws_2/native/credentials/android_keystore/export`, {
      method: 'POST',
      body: {},
    })
    expect(other.status).toBe(404)
    expect(other.json.error.code).toBe('keystore_missing')
  })
})
