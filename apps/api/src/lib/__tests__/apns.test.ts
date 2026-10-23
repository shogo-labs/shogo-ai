// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import {
  apnsConfigFromEnv,
  buildApnsRequest,
  isDeadTokenResponse,
  sendVoipPush,
  signApnsJwt,
  type ApnsConfig,
  type ApnsRequest,
  type ApnsResponse,
  type VoipPayload,
} from '../apns'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const CONFIG: ApnsConfig = { keyId: 'KEY123', teamId: 'TEAM456', privateKey: PEM, bundleId: 'ai.shogo.app', sandbox: false }
const NOW_MS = 1_800_000_000_000
const NOW_S = Math.floor(NOW_MS / 1000)
const TOKEN = 'ab12'.repeat(16)

const PAYLOAD: VoipPayload = {
  huddleId: 'h1',
  conversationId: 'dm1',
  workspaceId: 'ws1',
  kind: 'dm',
  from: { userId: 'u2', name: 'Ada', image: null },
}

describe('apnsConfigFromEnv', () => {
  test('is null until key id, team id and key are all set', () => {
    expect(apnsConfigFromEnv({})).toBeNull()
    expect(apnsConfigFromEnv({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't' })).toBeNull()
  })

  test('reads the credentials, unescapes the PEM and defaults the bundle id', () => {
    const config = apnsConfigFromEnv({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_PRIVATE_KEY: 'line1\\nline2' })
    expect(config).toEqual({ keyId: 'k', teamId: 't', privateKey: 'line1\nline2', bundleId: 'ai.shogo.app', sandbox: false })
  })

  test('sandbox is on for true or 1', () => {
    const base = { APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_PRIVATE_KEY: 'x' }
    expect(apnsConfigFromEnv({ ...base, APNS_SANDBOX: '1' })?.sandbox).toBe(true)
    expect(apnsConfigFromEnv({ ...base, APNS_SANDBOX: 'true' })?.sandbox).toBe(true)
    expect(apnsConfigFromEnv({ ...base, APNS_SANDBOX: 'no' })?.sandbox).toBe(false)
  })
})

describe('signApnsJwt', () => {
  test('is a verifiable ES256 token naming the key and team', () => {
    const jwt = signApnsJwt(CONFIG, NOW_S)
    const [header, claims, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123' })
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ iss: 'TEAM456', iat: NOW_S })
    const ok = verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
    expect(ok).toBe(true)
  })
})

describe('buildApnsRequest', () => {
  test('sets the push type, topic suffix and priority it is given', () => {
    const request = buildApnsRequest({
      config: CONFIG,
      deviceToken: TOKEN,
      pushType: 'voip',
      topicSuffix: '.voip',
      priority: '10',
      body: { a: 1 },
      nowSeconds: NOW_S,
    })
    expect(request.host).toBe('api.push.apple.com')
    expect(request.deviceToken).toBe(TOKEN)
    expect(request.headers['apns-push-type']).toBe('voip')
    expect(request.headers['apns-topic']).toBe('ai.shogo.app.voip')
    expect(request.headers['apns-priority']).toBe('10')
    expect(request.headers.authorization).toMatch(/^bearer /)
    expect(request.body).toBe('{"a":1}')
  })

  test('uses the sandbox host when sandbox is on', () => {
    const request = buildApnsRequest({
      config: { ...CONFIG, sandbox: true },
      deviceToken: TOKEN,
      pushType: 'voip',
      topicSuffix: '.voip',
      priority: '10',
      body: {},
      nowSeconds: NOW_S,
    })
    expect(request.host).toBe('api.sandbox.push.apple.com')
  })
})

describe('sendVoipPush', () => {
  test('sends a PushKit VoIP push with the call payload', async () => {
    const sent: ApnsRequest[] = []
    const result = await sendVoipPush(TOKEN, PAYLOAD, {
      config: CONFIG,
      now: () => NOW_MS,
      transport: async (request) => (sent.push(request), { status: 200 }),
    })
    expect(result).toEqual({ sent: true, dead: false, status: 200, reason: undefined })
    expect(sent).toHaveLength(1)
    expect(sent[0].deviceToken).toBe(TOKEN)
    expect(sent[0].headers['apns-push-type']).toBe('voip')
    expect(sent[0].headers['apns-topic']).toBe('ai.shogo.app.voip')
    expect(sent[0].headers['apns-priority']).toBe('10')
    expect(JSON.parse(sent[0].body)).toEqual(PAYLOAD)
  })

  test('a dead token is reported so it can be cleared', async () => {
    const result = await sendVoipPush(TOKEN, PAYLOAD, {
      config: CONFIG,
      transport: async (): Promise<ApnsResponse> => ({ status: 410, reason: 'Unregistered' }),
    })
    expect(result.sent).toBe(false)
    expect(result.dead).toBe(true)
  })

  test('a server error is not treated as a dead token', async () => {
    const result = await sendVoipPush(TOKEN, PAYLOAD, {
      config: CONFIG,
      transport: async (): Promise<ApnsResponse> => ({ status: 503, reason: 'ServiceUnavailable' }),
    })
    expect(result).toMatchObject({ sent: false, dead: false, status: 503 })
  })

  test('without APNs credentials nothing is sent', async () => {
    let calls = 0
    const result = await sendVoipPush(TOKEN, PAYLOAD, {
      config: null,
      transport: async () => (calls++, { status: 200 }),
    })
    expect(result).toMatchObject({ sent: false, reason: 'not_configured' })
    expect(calls).toBe(0)
  })
})

describe('isDeadTokenResponse', () => {
  test('410 and the three dead-token reasons', () => {
    expect(isDeadTokenResponse({ status: 410 })).toBe(true)
    expect(isDeadTokenResponse({ status: 400, reason: 'BadDeviceToken' })).toBe(true)
    expect(isDeadTokenResponse({ status: 400, reason: 'Unregistered' })).toBe(true)
    expect(isDeadTokenResponse({ status: 400, reason: 'ExpiredToken' })).toBe(true)
    expect(isDeadTokenResponse({ status: 500, reason: 'InternalServerError' })).toBe(false)
  })
})
