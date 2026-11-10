// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

const transcribe = mock(async () => ({ ok: true as const, text: 'spoken text' }))
const resolveWorkspace = mock(async () => 'personal-workspace')
const mintToken = mock(async () => 'token')
mock.module('../../services/meeting.service', () => ({
  DICTATION_MAX_BYTES: 8 * 1024 * 1024,
  friendlyMeetingError: () => 'Transcription failed',
  resolvePersonalWorkspaceId: resolveWorkspace,
  transcribeDictation: transcribe,
}))
mock.module('../../lib/ai-proxy-token', () => ({ generateProxyToken: mintToken }))
mock.module('../../lib/internal-proxy-config', () => ({ resolveApiBaseUrl: () => 'http://localhost:8002' }))

const { dictationRoutes } = await import('../dictation')
let auth: { isAuthenticated: boolean; userId?: string; via?: string } = {
  isAuthenticated: true, userId: 'user', via: 'session',
}
const app = new Hono()
app.use('*', bodyLimit({ maxSize: 8 * 1024 * 1024 }))
app.use('*', async (c, next) => { c.set('auth', auth); await next() })
app.route('/api', dictationRoutes)

const originalLocalMode = process.env.SHOGO_LOCAL_MODE
beforeEach(() => {
  process.env.SHOGO_LOCAL_MODE = 'true'
  auth = { isAuthenticated: true, userId: 'user', via: 'session' }
  transcribe.mockClear()
  resolveWorkspace.mockClear()
  mintToken.mockClear()
})
afterAll(() => {
  if (originalLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = originalLocalMode
})

const wav = new Uint8Array(48)
wav.set(new TextEncoder().encode('RIFF'), 0)
wav.set(new TextEncoder().encode('WAVE'), 8)

test('accepts a session clip and transcribes it', async () => {
  const response = await app.request('/api/dictation/transcribe', {
    method: 'POST', body: wav,
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ text: 'spoken text' })
  expect(transcribe).toHaveBeenCalledTimes(1)
  expect(mintToken).not.toHaveBeenCalled()
})

test('allows signed-out dictation on the local desktop API', async () => {
  auth = { isAuthenticated: false }
  const response = await app.request('/api/dictation/transcribe', {
    method: 'POST', body: wav,
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ text: 'spoken text' })
  expect(transcribe).toHaveBeenCalledTimes(1)
})

test('still requires authentication for cloud dictation', async () => {
  process.env.SHOGO_LOCAL_MODE = 'false'
  auth = { isAuthenticated: false }
  const response = await app.request('/api/dictation/transcribe', {
    method: 'POST', body: wav,
  })
  expect(response.status).toBe(401)
  expect(transcribe).not.toHaveBeenCalled()
})

test('bills cloud transcription to the signed-in user personal workspace', async () => {
  process.env.SHOGO_LOCAL_MODE = 'false'
  const response = await app.request('/api/dictation/transcribe', { method: 'POST', body: wav })
  expect(response.status).toBe(200)
  expect(resolveWorkspace).toHaveBeenCalledWith('user')
  expect(mintToken).toHaveBeenCalledWith('workspace', 'personal-workspace', 'user', 5 * 60 * 1000)
  expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), {
    cloudAuth: { proxyUrl: 'http://localhost:8002/api/ai/v1', proxyToken: 'token' },
  })
})

test('rejects a runtime identity before spending transcription resources', async () => {
  process.env.SHOGO_LOCAL_MODE = 'false'
  auth = { isAuthenticated: true, userId: 'owner', via: 'runtimeToken' }
  const response = await app.request('/api/dictation/transcribe', { method: 'POST', body: wav })
  expect(response.status).toBe(403)
  expect(transcribe).not.toHaveBeenCalled()
})

test('rejects an oversized stream without a Content-Length', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5 * 1024 * 1024))
      controller.enqueue(new Uint8Array(4 * 1024 * 1024))
      controller.close()
    },
  })
  const request = new Request('http://localhost/api/dictation/transcribe', {
    method: 'POST', body: stream, duplex: 'half',
  } as RequestInit)
  const response = await app.fetch(request)
  expect(response.status).toBe(413)
  expect(transcribe).not.toHaveBeenCalled()
})
