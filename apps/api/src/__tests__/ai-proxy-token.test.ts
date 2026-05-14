// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  extractProjectIdFromProxyToken,
  generateProxyToken,
  verifyProxyToken,
} from '../lib/ai-proxy-token'

const ENV_KEYS = ['AI_PROXY_SECRET', 'BETTER_AUTH_SECRET', 'PREVIEW_TOKEN_SECRET', 'NODE_ENV'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function base64urlEncodeJson(value: unknown): string {
  const json = JSON.stringify(value)
  const bytes = new TextEncoder().encode(json)
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlEncodeString(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('generateProxyToken and verifyProxyToken', () => {
  test('round-trips a project scoped token with AI_PROXY_SECRET', async () => {
    process.env.AI_PROXY_SECRET = 'proxy-secret'

    const token = await generateProxyToken('proj-1', 'ws-1', 'user-1', 60_000)
    const payload = await verifyProxyToken(token)

    expect(payload).not.toBeNull()
    expect(payload!.projectId).toBe('proj-1')
    expect(payload!.workspaceId).toBe('ws-1')
    expect(payload!.userId).toBe('user-1')
    expect(payload!.type).toBe('ai-proxy')
    expect(payload!.exp).toBeGreaterThanOrEqual(payload!.iat)
  })

  test('uses BETTER_AUTH_SECRET fallback when AI_PROXY_SECRET is absent', async () => {
    process.env.BETTER_AUTH_SECRET = 'better-secret'

    const token = await generateProxyToken('proj-2', 'ws-2')

    expect((await verifyProxyToken(token))!.projectId).toBe('proj-2')
  })

  test('uses PREVIEW_TOKEN_SECRET fallback when other secrets are absent', async () => {
    process.env.PREVIEW_TOKEN_SECRET = 'preview-secret'

    const token = await generateProxyToken('proj-3', 'ws-3')

    expect((await verifyProxyToken(token))!.workspaceId).toBe('ws-3')
  })

  test('uses development fallback secret outside production', async () => {
    process.env.NODE_ENV = 'test'

    const token = await generateProxyToken('proj-dev', 'ws-dev')

    expect((await verifyProxyToken(token))!.projectId).toBe('proj-dev')
  })

  test('throws in production when no signing secret is configured', async () => {
    process.env.NODE_ENV = 'production'

    await expect(generateProxyToken('proj', 'ws')).rejects.toThrow('No signing secret configured')
  })

  test('rejects malformed, tampered, expired, and wrong-type tokens', async () => {
    process.env.AI_PROXY_SECRET = 'proxy-secret'

    expect(await verifyProxyToken('not-a-jwt')).toBeNull()

    const token = await generateProxyToken('proj-1', 'ws-1', undefined, 60_000)
    const parts = token.split('.')
    const tamperedPayload = base64urlEncodeJson({
      projectId: 'proj-evil',
      workspaceId: 'ws-1',
      type: 'ai-proxy',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    expect(await verifyProxyToken(`${parts[0]}.${tamperedPayload}.${parts[2]}`)).toBeNull()

    const expired = await generateProxyToken('proj-1', 'ws-1', undefined, -1_000)
    expect(await verifyProxyToken(expired)).toBeNull()

    const wrongTypePayload = base64urlEncodeJson({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      type: 'preview-token',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    const wrongTypeSigningInput = `${parts[0]}.${wrongTypePayload}`
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('proxy-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const wrongTypeSig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(wrongTypeSigningInput))
    const wrongTypeToken = `${wrongTypeSigningInput}.${btoa(String.fromCharCode(...new Uint8Array(wrongTypeSig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
    expect(await verifyProxyToken(wrongTypeToken)).toBeNull()
  })

  test('returns null when a valid signature wraps invalid JSON payload', async () => {
    process.env.AI_PROXY_SECRET = 'proxy-secret'
    const header = base64urlEncodeJson({ alg: 'HS256', typ: 'JWT' })
    const payload = base64urlEncodeString('not-json')
    const signingInput = `${header}.${payload}`
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('proxy-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
    const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    expect(await verifyProxyToken(`${signingInput}.${encodedSignature}`)).toBeNull()
  })
})

describe('extractProjectIdFromProxyToken', () => {
  test('extracts project id without verifying signature', async () => {
    process.env.AI_PROXY_SECRET = 'secret'
    const token = await generateProxyToken('proj-extract', 'ws-1')

    expect(extractProjectIdFromProxyToken(token)).toBe('proj-extract')
  })

  test('returns null for malformed tokens or missing project id', () => {
    expect(extractProjectIdFromProxyToken('bad')).toBeNull()
    expect(extractProjectIdFromProxyToken('a.@@@.c')).toBeNull()

    const tokenWithoutProject = [
      base64urlEncodeJson({ alg: 'HS256', typ: 'JWT' }),
      base64urlEncodeJson({ workspaceId: 'ws-1', type: 'ai-proxy' }),
      'signature',
    ].join('.')

    expect(extractProjectIdFromProxyToken(tokenWithoutProject)).toBeNull()
  })
})
