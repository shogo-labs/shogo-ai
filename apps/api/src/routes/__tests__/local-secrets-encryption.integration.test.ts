// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-75 acceptance — what the desktop's generated `SECRETS_ENCRYPTION_KEY`
 * actually unblocks, driven through the real admin routes over a real SQLite
 * database (desktop migrations replayed).
 *
 * The reported failure was not provider-keys-only: `secret-crypto.ts` fails
 * closed, so on a packaged desktop every `encryptSecret()` call site threw. A
 * unit test on the key helper cannot show that, and neither can a mocked-prisma
 * route test. This file proves the three things a user would notice:
 *
 *  1. a native provider key saves (200), lands in `PlatformSetting` encrypted,
 *     and reads back masked with `source: "db"` and the right plaintext;
 *  2. a custom provider (`ModelProvider`) can be created with an `apiKey` and
 *     later edited without re-sending it;
 *  3. with no key provisioned — the pre-fix desktop — the same two writes
 *     fail with the exact `SECRETS_ENCRYPTION_KEY` error and write no rows.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { adminModelCatalogRoutes } = await import('../admin-model-catalog')
const { getOrCreateSecretsEncryptionKey } = await import('../../../../desktop/src/local-secrets')
const { decryptSecret } = await import('../../lib/secret-crypto')
const { getNativeProviderApiKeySync, getNativeProviderKeyInfoSync } = await import(
  '../../services/provider-credentials.service'
)

const PLAINTEXT = 'sk-live-sho75-provider-key'
const CUSTOM_PLAINTEXT = 'cp-live-sho75-custom-key'

const app = new Hono()
app.use('*', async (c, next) => {
  c.set('auth', { user: { id: 'qa-sho75-user' }, userId: 'qa-sho75-user', isAuthenticated: true } as never)
  await next()
})
app.route('/api/admin/settings', adminModelCatalogRoutes())

const request = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })

const originalKey = process.env.SECRETS_ENCRYPTION_KEY
const settingKey = 'provider-key.anthropic'

afterAll(async () => {
  await prisma.platformSetting.deleteMany({ where: { key: settingKey } })
  if (originalKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY
  else process.env.SECRETS_ENCRYPTION_KEY = originalKey
})

describe('SHO-75 a desktop-provisioned key makes encrypted credentials work', () => {
  test('a native provider key saves, stores ciphertext and reads back masked', async () => {
    // Exactly what `startLocalServer()` puts in the api child's env.
    process.env.SECRETS_ENCRYPTION_KEY = getOrCreateSecretsEncryptionKey(
      mkdtempSync(join(tmpdir(), 'shogo-sho75-desktop-')),
    )

    const put = await request('/api/admin/settings/provider-keys', {
      method: 'PUT',
      body: JSON.stringify({ anthropic: PLAINTEXT }),
    })
    expect(put.status).toBe(200)
    const putBody = (await put.json()) as any
    expect(putBody.keys.anthropic).toMatchObject({ configured: true, source: 'db' })
    expect(putBody.keys.anthropic.mask).not.toBe(PLAINTEXT)
    expect(JSON.stringify(putBody)).not.toContain(PLAINTEXT)

    const row = await prisma.platformSetting.findUnique({ where: { key: settingKey } })
    expect(row?.value.startsWith('v1:')).toBe(true)
    expect(row?.value).not.toContain(PLAINTEXT)
    expect(decryptSecret(String(row?.value))).toBe(PLAINTEXT)

    const get = await request('/api/admin/settings/provider-keys')
    expect(get.status).toBe(200)
    const getBody = (await get.json()) as any
    expect(getBody.keys.anthropic).toMatchObject({ configured: true, source: 'db' })
    expect(JSON.stringify(getBody)).not.toContain(PLAINTEXT)

    // The stored key is what actually gets used to call the provider.
    expect(getNativeProviderKeyInfoSync('anthropic').source).toBe('db')
    expect(getNativeProviderApiKeySync('anthropic')).toBe(PLAINTEXT)
  })

  test('a custom provider can be created with a key and edited without re-sending it', async () => {
    const created = await request('/api/admin/settings/model-providers', {
      method: 'POST',
      body: JSON.stringify({
        label: 'SHO-75 custom',
        baseUrl: 'https://llm.example.test/v1',
        apiKey: CUSTOM_PLAINTEXT,
      }),
    })
    expect(created.status).toBe(200)
    const createdBody = (await created.json()) as any
    expect(createdBody.provider.label).toBe('SHO-75 custom')
    expect(JSON.stringify(createdBody)).not.toContain(CUSTOM_PLAINTEXT)

    const row = await (prisma as any).modelProvider.findUnique({
      where: { id: createdBody.provider.id },
    })
    expect(row.encryptedApiKey.startsWith('v1:')).toBe(true)
    expect(decryptSecret(row.encryptedApiKey)).toBe(CUSTOM_PLAINTEXT)

    const edited = await request(`/api/admin/settings/model-providers/${row.id}`, {
      method: 'PUT',
      body: JSON.stringify({ label: 'SHO-75 custom renamed' }),
    })
    expect(edited.status).toBe(200)
    const after = await (prisma as any).modelProvider.findUnique({ where: { id: row.id } })
    expect(after.label).toBe('SHO-75 custom renamed')
    expect(after.encryptedApiKey).toBe(row.encryptedApiKey)
    expect(decryptSecret(after.encryptedApiKey)).toBe(CUSTOM_PLAINTEXT)

    await (prisma as any).modelProvider.delete({ where: { id: row.id } })
  })

  test('without a key the same writes fail exactly as reported and store nothing', async () => {
    delete process.env.SECRETS_ENCRYPTION_KEY
    await prisma.platformSetting.deleteMany({ where: { key: settingKey } })

    const put = await request('/api/admin/settings/provider-keys', {
      method: 'PUT',
      body: JSON.stringify({ anthropic: PLAINTEXT }),
    })
    expect(put.status).toBe(503)
    expect(((await put.json()) as any).error).toContain('SECRETS_ENCRYPTION_KEY')
    expect(await prisma.platformSetting.findUnique({ where: { key: settingKey } })).toBeNull()

    const created = await request('/api/admin/settings/model-providers', {
      method: 'POST',
      body: JSON.stringify({
        label: 'SHO-75 unencrypted',
        baseUrl: 'https://llm.example.test/v1',
        apiKey: CUSTOM_PLAINTEXT,
      }),
    })
    expect(created.status).toBe(503)
    expect(((await created.json()) as any).error).toContain('SECRETS_ENCRYPTION_KEY')
    const rows = await (prisma as any).modelProvider.findMany({ where: { label: 'SHO-75 unencrypted' } })
    expect(rows).toHaveLength(0)
  })
})
