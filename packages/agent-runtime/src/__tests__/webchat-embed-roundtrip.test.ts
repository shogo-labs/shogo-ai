// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Cross-origin embed round trip (SHO-380, acceptance #4/#5).
 *
 * The Channels panel now hands the owner a snippet carrying `?widgetKey=`.
 * This drives the runtime routes that snippet actually calls — widget.js →
 * config → session → message → reply — from a foreign Origin, and asserts the
 * public health route never leaks the key. It is the runtime half of the
 * embed; the API half (anonymous `/api/projects/*` proxy) is covered by
 * `apps/api/src/__tests__/project-attachments-mount-scope.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { WebChatAdapter } from '../channels/webchat'

const ORIGIN = 'https://customer.example'
const KEY = 'widget-key-abc123'

function makeApp() {
  const adapter = new WebChatAdapter()
  const app = new Hono()
  WebChatAdapter.registerRoutes(app, () => adapter)
  return { adapter, app }
}

async function connected() {
  const { adapter, app } = makeApp()
  await adapter.connect({ widgetSecret: KEY, title: 'Support', allowedOrigins: '*' })
  // Echo the visitor's message back as the agent reply.
  adapter.onMessage((msg) => {
    void adapter.sendMessage(msg.channelId, `echo: ${msg.text}`)
  })
  return { adapter, app }
}

const req = (app: Hono, path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { origin: ORIGIN, ...(init.headers as Record<string, string> | undefined) },
  })

describe('webchat embed round trip (SHO-380)', () => {
  test('widget.js is served as public JS with CORS for any origin', async () => {
    const { app } = await connected()
    const res = await req(app, '/agent/channels/webchat/widget.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/javascript')
    // The CORS middleware echoes the caller's origin (or `*` when absent).
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const body = await res.text()
    // The script reads the key from its own src and refuses to start without it.
    expect(body).toContain('widgetKey')
  })

  test('config → session → message → reply completes with the widget key', async () => {
    const { app } = await connected()

    const config = await req(app, '/agent/channels/webchat/config', {
      headers: { 'x-webchat-widget-key': KEY },
    })
    expect(config.status).toBe(200)
    expect((await config.json()).title).toBe('Support')

    const session = await req(app, '/agent/channels/webchat/session', {
      method: 'POST',
      headers: { 'x-webchat-widget-key': KEY },
    })
    expect(session.status).toBe(200)
    const { sessionId, sessionToken } = await session.json()
    expect(typeof sessionId).toBe('string')
    expect(typeof sessionToken).toBe('string')

    const message = await req(app, '/agent/channels/webchat/message', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webchat-session-token': sessionToken,
      },
      body: JSON.stringify({ message: 'hello', sessionId }),
    })
    expect(message.status).toBe(200)
    expect((await message.json()).reply).toBe('echo: hello')
  })

  test('config and session reject a missing or wrong widget key', async () => {
    const { app } = await connected()
    expect((await req(app, '/agent/channels/webchat/config')).status).toBe(403)
    expect(
      (await req(app, '/agent/channels/webchat/config', {
        headers: { 'x-webchat-widget-key': 'wrong' },
      })).status,
    ).toBe(403)
    expect(
      (await req(app, '/agent/channels/webchat/session', { method: 'POST' })).status,
    ).toBe(403)
  })

  test('public health never includes the widget key', async () => {
    const { app } = await connected()
    const res = await req(app, '/agent/channels/webchat/health')
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain(KEY)
  })
})
