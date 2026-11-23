// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-538 — opening a hosted workspace asks its desktop for the tunnel.
 *
 * The first files or plans read used to be what woke the host, so it arrived
 * while the request was already waiting. The workspace in view now says it as
 * soon as it is on screen — once per instance, however many screens read it.
 *
 *   bun test apps/mobile/hooks/__tests__/useHostTunnelWake.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('react-native', () => ({ Platform: { OS: 'web' } }))
mock.module('../../lib/auth-client', () => ({ authClient: { getCookie: () => null } }))
mock.module('../../lib/api', () => ({ API_URL: 'https://cloud.test' }))

const asked: Array<{ url: string; init: RequestInit }> = []

globalThis.fetch = (async (url: any, init: any) => {
  asked.push({ url: String(url), init: init ?? {} })
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
}) as any

const { requestHostTunnel, _resetHostTunnelWakeForTests } = await import('../useHostTunnelWake')
const { API_URL } = await import('../../lib/api')

/** Let the fire-and-forget request settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  asked.length = 0
  _resetHostTunnelWakeForTests()
})

describe('requestHostTunnel', () => {
  test('asks the existing request-connect route for that instance, naming the workspace', async () => {
    requestHostTunnel('inst-mac', 'ws-hosted')
    await settle()

    expect(asked).toHaveLength(1)
    expect(asked[0].url).toBe(`${API_URL}/api/instances/inst-mac/request-connect`)
    expect(asked[0].init.method).toBe('POST')
    expect(JSON.parse(String(asked[0].init.body))).toEqual({ workspaceId: 'ws-hosted' })
  })

  test('every screen that reads the workspace in view shares one request', async () => {
    requestHostTunnel('inst-mac', 'ws-hosted')
    requestHostTunnel('inst-mac', 'ws-hosted')
    requestHostTunnel('inst-mac', 'ws-hosted')
    await settle()

    expect(asked).toHaveLength(1)
  })

  test('a different host is its own request', async () => {
    requestHostTunnel('inst-mac', 'ws-hosted')
    requestHostTunnel('inst-pc', 'ws-hosted')
    await settle()

    expect(asked).toHaveLength(2)
  })
})
