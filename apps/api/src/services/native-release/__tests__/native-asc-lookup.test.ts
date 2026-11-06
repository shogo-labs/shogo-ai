// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Looking up the App Store Connect app, and what each answer means.
 *
 * `findAscAppId` returned `null` for every non-200 reply, so a revoked key (401)
 * was reported to the user as "create the app in App Store Connect" — work that
 * cannot fix a rejected key. A 404-shaped empty list still means "no app record";
 * an auth failure is its own refusal.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { findAscAppId } from '../signing.service'

function escKey() {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return { keyP8: privateKey, keyId: 'KEY123', issuerId: 'issuer-uuid', teamId: 'TEAM123' }
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function reply(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('findAscAppId', () => {
  it('returns the app id when the key can list apps', async () => {
    reply(200, { data: [{ id: '1234567890', type: 'apps' }] })
    expect(await findAscAppId(escKey(), 'ai.shogo.app.cool')).toBe('1234567890')
  })

  it('returns null when the app does not exist yet', async () => {
    reply(200, { data: [] })
    expect(await findAscAppId(escKey(), 'ai.shogo.app.cool')).toBeNull()
  })

  it('refuses a rejected key instead of asking for an app record', async () => {
    reply(401, { errors: [{ status: '401', title: 'NOT_AUTHORIZED' }] })
    const err = await findAscAppId(escKey(), 'ai.shogo.app.cool').catch((e) => e)
    expect(err.code).toBe('asc_key_rejected')
    expect(err.message).toContain('Re-upload it in Project → App stores')
    expect(err.message.toLowerCase()).not.toContain('create the app')
    expect(err.details.next_action).toBe('connect_asc')
  })

  it('treats a role that may not list apps the same way', async () => {
    reply(403, { errors: [{ status: '403', title: 'FORBIDDEN' }] })
    const err = await findAscAppId(escKey(), 'ai.shogo.app.cool').catch((e) => e)
    expect(err.code).toBe('asc_key_rejected')
  })

  it('still reports a transient failure as "no record" rather than a key problem', async () => {
    reply(500, {})
    expect(await findAscAppId(escKey(), 'ai.shogo.app.cool')).toBeNull()
  })
})
