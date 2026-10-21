// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-87 acceptance — the URL the app builds for a machine workspace's agent is
 * the one the relay can stream.
 *
 * Each half of this is covered by its own unit test (`agent-proxy-base.test.ts`,
 * `instances-normalize.test.ts`), and both can stay green while the pair is
 * wrong: the app writes `<relay>/api/workspaces/<localId>/agent-proxy/agent/chat`
 * and the relay has to recognise exactly that shape before it decides between
 * the streaming and the buffered tunnel pipeline. This composes the two — build
 * the URL the screen passes to `ChatPanel`, take its path behind the relay
 * prefix, and assert the relay streams it.
 *
 *   bun test ./apps/api/src/__tests__/qa-machine-agent-turn.acceptance.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { agentProxyBase } from '../../../mobile/lib/agent-proxy-base'
import { isStreamingRequest, normalizeTransparentProxyPath } from '../routes/instances'

const API_URL = 'https://shogo.example'
const INSTANCE = 'inst_samasra'
const LOCAL_WORKSPACE = 'f8019c80-local'

/** The agent base `WorkspaceAgentChatScreen` hands to `ChatPanel`. */
const agentBase = agentProxyBase({
  machine: { instanceId: INSTANCE, localWorkspaceId: LOCAL_WORKSPACE },
  workspaceId: 'cloud-personal',
  apiUrl: API_URL,
}) as string

/** The path a tunneled request carries — everything after the machine relay. */
function behindRelay(url: string): string {
  const prefix = `${API_URL}/api/machines/${INSTANCE}/w/${LOCAL_WORKSPACE}`
  expect(url.startsWith(prefix)).toBe(true)
  return url.slice(prefix.length)
}

describe('SHO-87 — a machine workspace agent turn', () => {
  test('the agent base hangs off the machine relay with the machine’s own workspace id', () => {
    expect(agentBase).toBe(
      `${API_URL}/api/machines/${INSTANCE}/w/${LOCAL_WORKSPACE}/api/workspaces/${LOCAL_WORKSPACE}/agent-proxy`,
    )
  })

  test('the relay unwraps it to the agent path the desktop serves', () => {
    expect(normalizeTransparentProxyPath(`${behindRelay(agentBase)}/agent/chat`)).toBe('/agent/chat')
  })

  test('a turn streams instead of being buffered until it ends', () => {
    const path = normalizeTransparentProxyPath(`${behindRelay(agentBase)}/agent/chat`)
    expect(isStreamingRequest('POST', path)).toBe(true)
  })

  test('the canvas and chat-resume streams through the same base stream too', () => {
    const base = behindRelay(agentBase)
    expect(isStreamingRequest('GET', normalizeTransparentProxyPath(`${base}/agent/canvas/stream`))).toBe(true)
    expect(
      isStreamingRequest('GET', normalizeTransparentProxyPath(`${base}/agent/chat/ses_1/stream`)),
    ).toBe(true)
  })

  test('a plain workspace read through the same base stays buffered', () => {
    const base = behindRelay(agentBase)
    // The history search the chat panel runs before it renders.
    expect(
      isStreamingRequest(
        'GET',
        normalizeTransparentProxyPath(`/api/workspaces/${LOCAL_WORKSPACE}/history/search`),
      ),
    ).toBe(false)
    expect(base).toContain(`/api/workspaces/${LOCAL_WORKSPACE}`)
  })

  test('without a machine the workspace agent base is the cloud one, untouched', () => {
    expect(agentProxyBase({ workspaceId: 'cloud-personal', apiUrl: API_URL })).toBe(
      `${API_URL}/api/workspaces/cloud-personal/agent-proxy`,
    )
  })
})
