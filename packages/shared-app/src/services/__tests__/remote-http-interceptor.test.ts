// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the Remote HTTP Interceptor
 */

import { describe, it, expect } from 'vitest'
import {
  shouldRouteToRemote,
  rewritePathForRemote,
  REMOTE_ROUTED_PREFIXES,
  REMOTE_EXCLUDED_PATTERNS,
  ROUTE_TABLE,
  createRemoteAwareHttpClient,
} from '../remote-http-interceptor'
import * as interceptor from '../remote-http-interceptor'

describe('shouldRouteToRemote', () => {
  // ─── Paths that SHOULD be routed to remote ─────────────────────────
  it('routes /api/projects to remote', () => {
    expect(shouldRouteToRemote('/api/projects')).toBe(true)
  })

  it('routes /api/projects/<id> to remote', () => {
    expect(shouldRouteToRemote('/api/projects/proj_123')).toBe(true)
  })

  it('routes /api/projects with query params to remote', () => {
    expect(shouldRouteToRemote('/api/projects?workspaceId=ws_1')).toBe(true)
  })

  it('routes /api/chat-sessions to remote', () => {
    expect(shouldRouteToRemote('/api/chat-sessions')).toBe(true)
  })

  it('routes /api/chat-messages to remote', () => {
    expect(shouldRouteToRemote('/api/chat-messages')).toBe(true)
  })

  it('routes the chat-history delta read to the same place as the transcript', () => {
    // SHO-260: a machine workspace's `/changes` must come from that machine.
    expect(
      shouldRouteToRemote('/api/chat-messages/session/s1/changes?agent=technical&since=2026-10-30T00:00:00.000Z'),
    ).toBe(true)
  })

  it('routes /api/folders to remote', () => {
    expect(shouldRouteToRemote('/api/folders')).toBe(true)
  })

  it('routes /api/starred-projects to remote', () => {
    expect(shouldRouteToRemote('/api/starred-projects')).toBe(true)
  })

  it('routes /api/tool-call-logs to remote', () => {
    expect(shouldRouteToRemote('/api/tool-call-logs')).toBe(true)
  })

  // ─── Paths that should NOT be routed to remote ─────────────────────
  it('does NOT route /api/auth to remote', () => {
    expect(shouldRouteToRemote('/api/auth')).toBe(false)
  })

  it('does NOT route /api/billing to remote', () => {
    expect(shouldRouteToRemote('/api/billing')).toBe(false)
  })

  it('does NOT route /api/instances to remote', () => {
    expect(shouldRouteToRemote('/api/instances')).toBe(false)
  })

  it('does NOT route /api/workspaces to remote', () => {
    expect(shouldRouteToRemote('/api/workspaces')).toBe(false)
  })

  it('does NOT route /api/members to remote', () => {
    expect(shouldRouteToRemote('/api/members')).toBe(false)
  })

  it('does NOT route /health to remote', () => {
    expect(shouldRouteToRemote('/health')).toBe(false)
  })

  // ─── Excluded paths (match prefix but explicitly excluded) ─────────
  it('does NOT route /api/projects/:id/publish to remote', () => {
    expect(shouldRouteToRemote('/api/projects/proj_123/publish')).toBe(false)
  })

  it('does NOT route /api/projects/:id/thumbnail to remote', () => {
    expect(shouldRouteToRemote('/api/projects/proj_123/thumbnail')).toBe(false)
  })

  it('does NOT route /api/projects/:id/thumbnail/capture to remote', () => {
    expect(shouldRouteToRemote('/api/projects/proj_123/thumbnail/capture')).toBe(false)
  })
})

describe('rewritePathForRemote', () => {
  const baseUrl = 'https://studio.shogo.ai/api/instances/inst_abc/p'

  it('rewrites /api/projects to the proxy URL', () => {
    expect(rewritePathForRemote('/api/projects', baseUrl)).toBe(
      'https://studio.shogo.ai/api/instances/inst_abc/p/api/projects',
    )
  })

  it('rewrites /api/projects/<id> to the proxy URL', () => {
    expect(rewritePathForRemote('/api/projects/proj_123', baseUrl)).toBe(
      'https://studio.shogo.ai/api/instances/inst_abc/p/api/projects/proj_123',
    )
  })

  it('rewrites /api/chat-sessions to the proxy URL', () => {
    expect(rewritePathForRemote('/api/chat-sessions', baseUrl)).toBe(
      'https://studio.shogo.ai/api/instances/inst_abc/p/api/chat-sessions',
    )
  })

  it('preserves query params in the path', () => {
    expect(
      rewritePathForRemote('/api/projects?workspaceId=ws_1', baseUrl),
    ).toBe(
      'https://studio.shogo.ai/api/instances/inst_abc/p/api/projects?workspaceId=ws_1',
    )
  })
})

describe('configuration', () => {
  it('has all expected prefixes', () => {
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/projects')
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/chat-sessions')
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/chat-messages')
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/folders')
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/starred-projects')
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/tool-call-logs')
  })

  it('has exclusion patterns', () => {
    expect(REMOTE_EXCLUDED_PATTERNS.length).toBeGreaterThan(0)
  })
})

// ─── Remote Control only (SHO-285) ────────────────────────────────────────
//
// A paired desktop's workspace is a normal cloud workspace now: the client talks
// to the cloud API for it like any other, and the cloud sends its turns to the
// host. The interceptor keeps Remote Control routing and nothing else.

function recordingClient() {
  const calls: Array<{ method: string; path: string; init?: any }> = []
  const http: any = {
    get: async (path: string) => (calls.push({ method: 'get', path }), { data: null }),
    post: async (path: string, body: unknown, headers?: unknown) =>
      (calls.push({ method: 'post', path, init: { body, headers } }), { data: null }),
    patch: async (path: string) => (calls.push({ method: 'patch', path }), { data: null }),
    delete: async (path: string) => (calls.push({ method: 'delete', path }), { data: null }),
    request: async (path: string, init?: any) => (calls.push({ method: 'request', path, init }), { data: null }),
  }
  return { http, calls }
}

describe('no machine-workspace routing is left (SHO-285)', () => {
  it('exports no machine tables, rewrites or error codes', () => {
    const names = Object.keys(interceptor)
    expect(names.filter((name) => /machine/i.test(name))).toEqual([])
  })

  it('sends a workspace-scoped call to the cloud even while Remote Control is on', async () => {
    const { http, calls } = recordingClient()
    const client = createRemoteAwareHttpClient(http, () => ({
      remoteProxyBaseUrl: 'https://studio.shogo.ai/api/instances/inst-1/p',
    }))
    await client.get('/api/workspaces/ws-1/conversations')
    await client.get('/api/boards?workspaceId=ws-1')
    expect(calls.map((call) => call.path)).toEqual([
      '/api/workspaces/ws-1/conversations',
      '/api/boards?workspaceId=ws-1',
    ])
  })

  it('still routes Remote Control paths through the instance proxy with its headers', async () => {
    const { http, calls } = recordingClient()
    const client = createRemoteAwareHttpClient(http, () => ({
      remoteProxyBaseUrl: 'https://studio.shogo.ai/api/instances/inst-1/p',
      protocolVersion: 3,
    }))
    await client.post('/api/projects', { name: 'x', workspaceId: 'ws-1' })
    expect(calls[0].path).toBe('https://studio.shogo.ai/api/instances/inst-1/p/api/projects')
    expect(calls[0].init.body).toEqual({ name: 'x', workspaceId: 'ws-1' })
    expect(calls[0].init.headers).toMatchObject({ 'x-remote-control': 'true', 'x-remote-protocol-version': '3' })
  })

  it('passes everything through untouched without Remote Control', async () => {
    const { http, calls } = recordingClient()
    const client = createRemoteAwareHttpClient(http, () => ({ remoteProxyBaseUrl: null }))
    await client.get('/api/projects')
    expect(calls[0].path).toBe('/api/projects')
  })
})
