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
  rewriteMachineWorkspaceParam,
  rewriteMachineWorkspaceBody,
  createRemoteAwareHttpClient,
} from '../remote-http-interceptor'

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

// ─── Machine workspaces (SHO-54) ──────────────────────────────────────────
//
// A machine workspace is one of a paired desktop's own workspaces, reached
// through `/api/machines/<id>/w/<localWorkspaceId>`. The cloud workspace id
// the UI happens to have selected must not survive the hop: the desktop would
// filter its projects by an id it has never heard of and answer `200 []`.

describe('rewriteMachineWorkspaceParam', () => {
  it('replaces the cloud workspaceId with the machine’s own id', () => {
    expect(rewriteMachineWorkspaceParam('/api/projects?workspaceId=ws-cloud&limit=50', 'lw-1')).toBe(
      '/api/projects?workspaceId=lw-1&limit=50',
    )
  })

  it('leaves paths without a workspaceId untouched', () => {
    expect(rewriteMachineWorkspaceParam('/api/projects/p-1', 'lw-1')).toBe('/api/projects/p-1')
    expect(rewriteMachineWorkspaceParam('/api/chat-sessions?limit=5', 'lw-1')).toBe(
      '/api/chat-sessions?limit=5',
    )
  })

  it('is a no-op when the id already matches', () => {
    expect(rewriteMachineWorkspaceParam('/api/projects?workspaceId=lw-1', 'lw-1')).toBe(
      '/api/projects?workspaceId=lw-1',
    )
  })
})

describe('rewriteMachineWorkspaceBody', () => {
  it("points a create at the machine's own workspace", () => {
    expect(rewriteMachineWorkspaceBody({ name: 'Docs', workspaceId: 'ws-cloud' }, 'lw-1')).toEqual({
      name: 'Docs',
      workspaceId: 'lw-1',
    })
  })

  it('leaves a matching id, bodies without one and non-objects untouched', () => {
    const body = { workspaceId: 'lw-1' }
    expect(rewriteMachineWorkspaceBody(body, 'lw-1')).toBe(body)
    expect(rewriteMachineWorkspaceBody({ name: 'x' }, 'lw-1')).toEqual({ name: 'x' })
    expect(rewriteMachineWorkspaceBody('raw', 'lw-1')).toBe('raw')
    expect(rewriteMachineWorkspaceBody([{ workspaceId: 'ws-cloud' }], 'lw-1')).toEqual([
      { workspaceId: 'ws-cloud' },
    ])
  })
})

describe('createRemoteAwareHttpClient with a machine workspace', () => {
  it('rewrites both the base URL and the workspaceId, and leaves cloud routes alone', async () => {
    const calls: string[] = []
    const http = {
      get: async (path: string) => {
        calls.push(path)
        return { data: {} }
      },
      post: async (path: string) => {
        calls.push(path)
        return { data: {} }
      },
      patch: async (path: string) => ({ data: {} }),
      delete: async () => ({ data: {} }),
      request: async () => ({ data: {} }),
    } as any

    const proxy = createRemoteAwareHttpClient(http, () => ({
      remoteProxyBaseUrl: 'https://studio.shogo.ai/api/machines/inst-1/w/lw-1',
      machineWorkspaceId: 'lw-1',
    }))

    await proxy.get('/api/projects?workspaceId=ws-cloud')
    await proxy.get('/api/billing/summary')

    expect(calls[0]).toBe(
      'https://studio.shogo.ai/api/machines/inst-1/w/lw-1/api/projects?workspaceId=lw-1',
    )
    // Billing is cloud-pinned even inside a machine workspace.
    expect(calls[1]).toBe('/api/billing/summary')
  })
})

describe('createRemoteAwareHttpClient body rewrite', () => {
  it("files a create into the machine's own workspace", async () => {
    const posts: { path: string; body: unknown }[] = []
    const http = {
      get: async () => ({ data: {} }),
      post: async (path: string, body: unknown) => {
        posts.push({ path, body })
        return { data: {} }
      },
      patch: async (path: string, body: unknown) => {
        posts.push({ path, body })
        return { data: {} }
      },
      delete: async () => ({ data: {} }),
      request: async () => ({ data: {} }),
    } as any

    const proxy = createRemoteAwareHttpClient(http, () => ({
      remoteProxyBaseUrl: 'https://studio.shogo.ai/api/machines/inst-1/w/lw-1',
      machineWorkspaceId: 'lw-1',
    }))

    await proxy.post('/api/projects', { name: 'Docs', workspaceId: 'ws-cloud' })

    expect(posts[0]).toEqual({
      path: 'https://studio.shogo.ai/api/machines/inst-1/w/lw-1/api/projects',
      body: { name: 'Docs', workspaceId: 'lw-1' },
    })
  })
})
