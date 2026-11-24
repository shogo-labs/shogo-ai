// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-538 — opening a hosted workspace asks its desktop for the tunnel.
 *
 * The first files or plans read used to be what woke the host, so it arrived
 * while the request was already waiting. The workspace in view now says it as
 * soon as it is on screen — once per instance, however many screens read it.
 *
 * `agentFetch` is mocked by the app's preload (`test/testing-library.ts`), so
 * this goes through the same `installAgentFetchMock` every other screen test
 * uses (SHO-434) instead of stubbing `globalThis.fetch`.
 *
 *   bun test apps/mobile/hooks/__tests__/useHostTunnelWake.test.ts
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { installAgentFetchMock, recordedAgentFetch, restoreAgentFetch } from '../../test/helpers/mockAgentFetch'

const { requestHostTunnel, _resetHostTunnelWakeForTests } = await import('../useHostTunnelWake')
const { API_URL } = await import('../../lib/api-url')

/** Let the fire-and-forget request settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let fetcher: ReturnType<typeof recordedAgentFetch>

beforeEach(() => {
  _resetHostTunnelWakeForTests()
  fetcher = recordedAgentFetch()
  fetcher.setCatchAll(() => new Response('{"ok":true}', { status: 200 }))
  installAgentFetchMock(fetcher.handler)
})

describe('requestHostTunnel', () => {
  test('asks the existing request-connect route for that instance, naming the workspace', async () => {
    requestHostTunnel('inst-mac', 'ws-hosted')
    await settle()

    expect(fetcher.calls).toHaveLength(1)
    expect(fetcher.calls[0].url).toBe(`${API_URL}/api/instances/inst-mac/request-connect`)
    expect(fetcher.calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(fetcher.calls[0].init?.body))).toEqual({ workspaceId: 'ws-hosted' })
  })

  test('every screen that reads the workspace in view shares one request', async () => {
    requestHostTunnel('inst-mac', 'ws-hosted')
    requestHostTunnel('inst-mac', 'ws-hosted')
    requestHostTunnel('inst-mac', 'ws-hosted')
    await settle()

    expect(fetcher.calls).toHaveLength(1)
  })

  test('a different host is its own request', async () => {
    requestHostTunnel('inst-mac', 'ws-hosted')
    requestHostTunnel('inst-pc', 'ws-hosted')
    await settle()

    expect(fetcher.calls).toHaveLength(2)
  })

  test('a refused pre-wake does not throw into the screen that asked', async () => {
    fetcher.setCatchAll(() => new Response('{"error":{"code":"forbidden"}}', { status: 403 }))

    requestHostTunnel('inst-mac', 'ws-hosted')
    await settle()

    expect(fetcher.calls).toHaveLength(1)
    restoreAgentFetch()
  })
})
