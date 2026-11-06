// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Play publishing account, and the refusals a user has to fix by hand.
 *
 * Shogo owns one publisher service account and the app's owner grants it release
 * permission in Play Console, so the user never pastes a JSON key. These tests are
 * about the two things that can still go wrong, told apart correctly: the account
 * was never invited (401/403), and Play has never seen the package (404 — the
 * one-time first upload).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prismaProxy, useFakePrisma } from './prisma-fixture'

const prismaFake = {
  nativeAppCredential: {
    async findUnique() {
      return null
    },
    async findMany() {
      return []
    },
  },
  nativeApp: {
    async findUnique() {
      return null
    },
    async update() {
      return null
    },
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: prismaProxy }))
useFakePrisma(prismaFake)

const {
  PLAY_PUBLISHER_ENV,
  PLAY_PUBLISHER_FILE_ENV,
  googleAccessToken,
  playMissingAccountMessage,
  playPublisherEmail,
  playRefusalMessage,
  probePlayPackage,
  resolvePlayCredentials,
  shogoPlayPublisherKey,
} = await import('../play')
const { NativeReleaseError } = await import('../client')
const { assertStoreConnections, setStoreProbes } = await import('../release.service')

/** A real RSA key: `googleAccessToken` signs with it, so a fake would not do. */
function serviceAccountJson(email = 'publisher@shogo.test'): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return JSON.stringify({
    type: 'service_account',
    client_email: email,
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
  })
}

const key = () => ({ json: serviceAccountJson(), clientEmail: 'publisher@shogo.test' })

const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const name of [PLAY_PUBLISHER_ENV, PLAY_PUBLISHER_FILE_ENV]) {
    savedEnv[name] = process.env[name]
    delete process.env[name]
  }
})
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  setStoreProbes({})
})

describe('the Shogo publisher account', () => {
  it('is read from the environment as inline JSON', () => {
    process.env[PLAY_PUBLISHER_ENV] = serviceAccountJson()
    expect(playPublisherEmail()).toBe('publisher@shogo.test')
  })

  it('is read from a mounted file, which is how a k8s Secret arrives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'play-key-'))
    try {
      const path = join(dir, 'play.json')
      writeFileSync(path, serviceAccountJson('robot@shogo.test'))
      process.env[PLAY_PUBLISHER_FILE_ENV] = path
      expect(playPublisherEmail()).toBe('robot@shogo.test')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is absent rather than half-working when the key is junk', () => {
    process.env[PLAY_PUBLISHER_ENV] = '{"not":"a key"}'
    expect(shogoPlayPublisherKey()).toBeNull()
    expect(playPublisherEmail()).toBeNull()
  })

  it('prefers a workspace key, and falls back to Shogo’s', async () => {
    process.env[PLAY_PUBLISHER_ENV] = serviceAccountJson('publisher@shogo.test')
    const workspace = await resolvePlayCredentials('ws_1', {
      readByokKey: async () => serviceAccountJson('own@customer.test'),
    })
    expect(workspace?.source).toBe('workspace')
    expect(workspace?.key.clientEmail).toBe('own@customer.test')

    const shogo = await resolvePlayCredentials('ws_1', { readByokKey: async () => null })
    expect(shogo?.source).toBe('shogo')

    expect(await resolvePlayCredentials('ws_1', { readByokKey: async () => null })).not.toBeNull()
    delete process.env[PLAY_PUBLISHER_ENV]
    expect(await resolvePlayCredentials('ws_1', { readByokKey: async () => null })).toBeNull()
  })
})

describe('the Play probe', () => {
  it('opens and deletes an edit when the account can publish', async () => {
    const calls: { url: string; method: string }[] = []
    const fakeFetch = (async (url: string, init: any) => {
      calls.push({ url: String(url), method: init.method })
      if (String(url).includes('/edits/')) return new Response('{}', { status: 200 })
      if (init.method === 'POST' && String(url).endsWith('/edits')) {
        return new Response(JSON.stringify({ id: 'edit_1' }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const probe = await probePlayPackage(key(), 'ai.shogo.app.cool', {
      fetchImpl: fakeFetch,
      accessToken: 'token',
    })
    expect(probe.ok).toBe(true)
    // Opened one edit and deleted it: an edit left open blocks every later release.
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE'])
  })

  it('tells "never invited" apart from "Play has never seen the package"', async () => {
    const notInvited = (async () =>
      new Response(JSON.stringify({ error: { code: 403, message: 'no permission' } }), {
        status: 403,
      })) as unknown as typeof fetch
    expect(
      (await probePlayPackage(key(), 'ai.shogo.app.cool', { fetchImpl: notInvited, accessToken: 't' })).code,
    ).toBe('play_not_invited')

    const unknownPackage = (async () =>
      new Response(JSON.stringify({ error: { code: 404, message: 'applicationNotFound' } }), {
        status: 404,
      })) as unknown as typeof fetch
    expect(
      (
        await probePlayPackage(key(), 'ai.shogo.app.cool', {
          fetchImpl: unknownPackage,
          accessToken: 't',
        })
      ).code,
    ).toBe('play_package_not_found')
  })

  it('mints a token from the service-account key', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: 'ya29.test' }), { status: 200 })) as unknown as typeof fetch
    expect(await googleAccessToken(key(), { fetchImpl: fakeFetch })).toBe('ya29.test')
  })

  it('reports a rejected key instead of minting a token', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as unknown as typeof fetch
    await expect(googleAccessToken(key(), { fetchImpl: fakeFetch })).rejects.toThrow('google_token_rejected')
  })

  it('points at Project → App stores when no publisher is configured at all', () => {
    // The live case: NATIVE_RELEASE_MODE=byok and no SHOGO_PLAY_PUBLISHER_SA, so
    // there is no email to invite and "invite the Shogo publisher account" is an
    // instruction nobody can follow.
    const msg = playMissingAccountMessage({ packageName: 'ai.shogo.app.cool' })
    expect(msg).toContain('Project → App stores')
    expect(msg).toContain('ai.shogo.app.cool')
    expect(msg.toLowerCase()).not.toContain('invite')
    expect(msg).not.toContain('the Shogo publisher account')
  })

  it('writes the invite step in the user’s words', () => {
    expect(playRefusalMessage('play_not_invited', { email: 'publisher@shogo.test' })).toContain(
      'publisher@shogo.test',
    )
    expect(
      playRefusalMessage('play_package_not_found', { packageName: 'ai.shogo.app.cool' }),
    ).toContain('ai.shogo.app.cool')
  })
})

describe('the store connections a release is checked against', () => {
  const app = {
    id: 'app_1',
    workspaceId: 'ws_1',
    projectId: 'p1',
    mode: 'managed',
    easAccountId: 'acc_1',
    easAppId: 'eas_1',
    bundleIdentifier: 'ai.shogo.app.cool',
    androidPackage: 'ai.shogo.app.cool',
    ascAppId: null,
    idsLockedAt: null,
    firstPlaySubmissionAt: null,
  }

  it('refuses before anything is built when no Play account can reach the app', async () => {
    process.env[PLAY_PUBLISHER_ENV] = serviceAccountJson()
    setStoreProbes({
      play: async () => ({ ok: false, code: 'play_not_invited', message: 'no permission' }),
    })
    await expect(
      assertStoreConnections({ workspaceId: 'ws_1', app, platforms: ['android'] }),
    ).rejects.toMatchObject({ code: 'play_not_invited' })
  })

  it('names the publisher email when there is no key at all', async () => {
    await expect(
      assertStoreConnections({ workspaceId: 'ws_1', app, platforms: ['android'] }),
    ).rejects.toBeInstanceOf(NativeReleaseError)
  })

  it('says "first upload" when Play has never seen the package', async () => {
    process.env[PLAY_PUBLISHER_ENV] = serviceAccountJson()
    setStoreProbes({ play: async () => ({ ok: false, code: 'play_package_not_found' }) })
    const err = await assertStoreConnections({ workspaceId: 'ws_1', app, platforms: ['android'] }).catch(
      (e) => e,
    )
    expect(err.code).toBe('play_package_not_found')
    expect(err.details.next_action).toBe('play_package_not_found')
    expect(err.message).toContain('ai.shogo.app.cool')
  })

  it('passes when the account can reach the app', async () => {
    process.env[PLAY_PUBLISHER_ENV] = serviceAccountJson()
    setStoreProbes({ play: async () => ({ ok: true }) })
    await expect(
      assertStoreConnections({ workspaceId: 'ws_1', app, platforms: ['android'] }),
    ).resolves.toBeUndefined()
  })

  it('asks for an App Store Connect key before an iOS build', async () => {
    // The fixture has no credential rows, so there is no ASC key.
    const err = await assertStoreConnections({
      workspaceId: 'ws_1',
      app,
      platforms: ['ios'],
    }).catch((e) => e)
    expect(err.code).toBe('connect_asc')
  })
})
