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
  rewriteMachineWorkspacePath,
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
  it('rewrites both the base URL and the workspaceId on a write, and leaves cloud routes alone', async () => {
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

    await proxy.post('/api/boards?workspaceId=ws-cloud')
    await proxy.get('/api/billing/summary')

    expect(calls[0]).toBe(
      'https://studio.shogo.ai/api/machines/inst-1/w/lw-1/api/boards?workspaceId=lw-1',
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

// ─── A paired desktop's own workspace (#SHO-87) ─────────────────────────────
//
// While `samasra → Samsara` is open, the workspace agent, its sessions and the
// workspace's team chat belong to that machine. The same URLs are cloud routes
// for a cloud workspace, so they only join the remote set with a machine id.

const MACHINE = { machineWorkspaceId: 'lw-1' }

describe('shouldRouteToRemote with a machine workspace', () => {
  it('routes the machine workspace agent, its chat and its team chat to remote', () => {
    expect(
      shouldRouteToRemote('/api/workspaces/ws-cloud/agent-proxy/agent/chat', MACHINE),
    ).toBe(true)
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/agent-profile', MACHINE)).toBe(true)
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/chat/sess-1/turn', MACHINE)).toBe(true)
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/history/search?q=x', MACHINE)).toBe(true)
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/conversations', MACHINE)).toBe(true)
    expect(shouldRouteToRemote('/api/conversations/conv-1/messages', MACHINE)).toBe(true)
    expect(shouldRouteToRemote('/api/conversation-messages/msg-1', MACHINE)).toBe(true)
    // Every other workspace-scoped surface follows the workspace it names: the
    // @-mention picker, presence and the inbox are all the machine's while its
    // workspace is open.
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/mentionables', MACHINE)).toBe(true)
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/presence', MACHINE)).toBe(true)
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/inbox?limit=20', MACHINE)).toBe(true)
  })

  it('keeps the workspace list, its cloud-only surfaces and this app’s own routes on cloud', () => {
    for (const path of [
      '/api/workspaces',
      '/api/workspaces/ws-cloud',
      // The workspace's own analytics and cost analytics are the *machine's*
      // since SHO-108 — see the analytics case above; only the cloud account
      // families stay here.
      '/api/workspaces/ws-cloud/chat-installations',
      '/api/workspaces/ws-cloud/permissions',
      '/api/workspaces/ws-cloud/leave',
      '/api/workspaces/ws-cloud/deletion-preview',
      '/api/workspaces/ws-cloud/member-activity',
      // Cloud-only API routes (server.ts): the desktop does not mount them.
      '/api/workspaces/ws-cloud/instance',
      '/api/workspaces/ws-cloud/metrics?period=24h',
      '/api/workspaces/ws-cloud/storage',
      '/api/workspaces/ws-cloud/children',
      // The export download is a raw fetch to cloud, so its estimate is too.
      '/api/workspaces/ws-cloud/export',
      '/api/workspaces/ws-cloud/export/estimate',
      '/api/billing',
      '/api/instances',
      '/api/machines',
      '/api/auth/session',
      '/api/invitations',
    ]) {
      expect(shouldRouteToRemote(path, MACHINE)).toBe(false)
    }
  })

  /**
   * SHO-108: a workspace feature the machine serves from a *top-level* path
   * follows the workspace in view. Boards and cards name their board or card in
   * the path, the agent task board and the mention pickers are the agent's, and
   * the chat plumbing names the file or message — none of them reach
   * `/api/workspaces/:id/...`, so they are declared in one list.
   */
  it('routes the workspace features that name their board, card or agent', () => {
    for (const path of [
      '/api/boards',
      '/api/boards?conversationId=c1',
      '/api/boards/b1',
      '/api/boards/b1/items',
      '/api/boards/b1/columns',
      '/api/work-items/i1',
      '/api/work-items/i1/move',
      '/api/work-items/i1/comments',
      '/api/work-items/i1/history?filter=all',
      '/api/work-items/i1/follow',
      '/api/conversation-messages/m1/card',
      '/api/agent-tasks',
      '/api/agent-tasks/t1',
      '/api/chat-mentionables?workspaceId=ws-cloud',
      '/api/chat-mention-status?workspaceId=ws-cloud',
      '/api/conversation-files/f1',
      '/api/chat-attachments/a1',
      '/api/chat-queued-messages',
    ]) {
      expect(shouldRouteToRemote(path, MACHINE)).toBe(true)
    }
  })

  it('routes the machine’s own analytics — the tab and the CSV are one workspace', () => {
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/analytics/overview', MACHINE)).toBe(true)
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/analytics/usage-log.csv', MACHINE)).toBe(true)
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/cost-analytics', MACHINE)).toBe(true)
    expect(shouldRouteToRemote('/api/workspaces/ws-cloud/activity', MACHINE)).toBe(true)
  })

  it('keeps the cloud account families on cloud, whichever host is in view', () => {
    for (const path of [
      '/api/billing/subscription',
      '/api/subscriptions',
      '/api/members?workspaceId=ws-cloud',
      '/api/invitations',
      '/api/marketplace/listings',
      '/api/admin/settings',
      '/api/auth/session',
      '/api/instances',
      '/api/machines',
      '/api/machines/inst-1/workspaces',
      '/api/sync',
    ]) {
      expect(shouldRouteToRemote(path, MACHINE)).toBe(false)
    }
  })

  it('leaves every machine-owned family on cloud without a machine in view', () => {
    for (const path of [
      '/api/boards/b1',
      '/api/work-items/i1/move',
      '/api/agent-tasks',
      '/api/chat-mentionables?workspaceId=ws-cloud',
      '/api/workspaces/ws-cloud/analytics/overview',
    ]) {
      expect(shouldRouteToRemote(path)).toBe(false)
    }
  })

  it('is unchanged without a machine in view', () => {
    expect(shouldRouteToRemote('/api/workspaces/ws-1/agent-proxy/agent/chat')).toBe(false)
    expect(shouldRouteToRemote('/api/conversations/conv-1')).toBe(false)
    expect(shouldRouteToRemote('/api/conversation-messages/msg-1')).toBe(false)
  })
})

describe('rewriteMachineWorkspacePath', () => {
  it("points a workspace-scoped path at the machine's own id", () => {
    expect(rewriteMachineWorkspacePath('/api/workspaces/ws-cloud/agent-proxy/agent/chat', 'lw-1')).toBe(
      '/api/workspaces/lw-1/agent-proxy/agent/chat',
    )
  })

  it('leaves paths without a workspace id segment alone', () => {
    expect(rewriteMachineWorkspacePath('/api/projects?workspaceId=ws-cloud', 'lw-1')).toBe(
      '/api/projects?workspaceId=ws-cloud',
    )
    expect(rewriteMachineWorkspacePath('/api/chat-messages', 'lw-1')).toBe('/api/chat-messages')
  })
})

describe('createRemoteAwareHttpClient in a machine workspace', () => {
  it('reads a workspace the cloud has no copy of from the machine instead of 403', async () => {
    // The cloud's backstop answers `409 machine_copy_pending` for a read of a
    // machine workspace it holds no copy of (first sync still running, sync off,
    // or sync broken). Showing "No access to this workspace" for that was the
    // bug; the read has to be retried through the relay, once (SHO-241).
    const calls: string[] = []
    const http = {
      get: async (path: string) => {
        calls.push(path)
        if (path === '/api/workspaces/ws-cloud/conversations') {
          throw Object.assign(new Error('Conflict'), {
            status: 409,
            details: { error: { code: 'machine_copy_pending', message: 'no copy yet' } },
          })
        }
        return { data: {} }
      },
      post: async (path: string) => {
        calls.push(path)
        return { data: {} }
      },
      patch: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
      request: async () => ({ data: {} }),
    } as any

    const proxy = createRemoteAwareHttpClient(http, () => ({
      remoteProxyBaseUrl: 'https://studio.shogo.ai/api/machines/inst-1/w/lw-1',
      machineWorkspaceId: 'lw-1',
    }))

    const answer = await proxy.get('/api/workspaces/ws-cloud/conversations')

    expect(answer).toEqual({ data: {} })
    expect(calls).toEqual([
      '/api/workspaces/ws-cloud/conversations',
      'https://studio.shogo.ai/api/machines/inst-1/w/lw-1/api/workspaces/lw-1/conversations',
    ])
  })

  it('does not retry an answer that is about access, not a missing copy', async () => {
    const calls: string[] = []
    const denied = Object.assign(new Error('Forbidden'), {
      status: 403,
      details: { error: { code: 'forbidden', message: 'No access to this workspace' } },
    })
    const http = {
      get: async (path: string) => {
        calls.push(path)
        throw denied
      },
      post: async () => ({ data: {} }),
      patch: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
      request: async () => ({ data: {} }),
    } as any

    const proxy = createRemoteAwareHttpClient(http, () => ({
      remoteProxyBaseUrl: 'https://studio.shogo.ai/api/machines/inst-1/w/lw-1',
      machineWorkspaceId: 'lw-1',
    }))

    await expect(proxy.get('/api/workspaces/ws-cloud/conversations')).rejects.toBe(denied)
    expect(calls).toHaveLength(1)
  })

  it('sends writes through the relay with the local workspace id, and reads to the cloud copy', async () => {
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
      patch: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
      request: async () => ({ data: {} }),
    } as any

    const proxy = createRemoteAwareHttpClient(http, () => ({
      remoteProxyBaseUrl: 'https://studio.shogo.ai/api/machines/inst-1/w/lw-1',
      machineWorkspaceId: 'lw-1',
    }))

    await proxy.post('/api/workspaces/ws-cloud/agent-proxy/agent/chat')
    // Rows: the cloud copy answers, so a panel opens while the machine sleeps.
    await proxy.get('/api/workspaces/ws-cloud/conversations')
    await proxy.get('/api/conversations/conv-1')
    // The machine's runtime: still a live call.
    await proxy.get('/api/workspaces/ws-cloud/preview')
    await proxy.get('/api/conversation-files/file-1')

    expect(calls).toEqual([
      'https://studio.shogo.ai/api/machines/inst-1/w/lw-1/api/workspaces/lw-1/agent-proxy/agent/chat',
      '/api/workspaces/ws-cloud/conversations',
      '/api/conversations/conv-1',
      'https://studio.shogo.ai/api/machines/inst-1/w/lw-1/api/workspaces/lw-1/preview',
      'https://studio.shogo.ai/api/machines/inst-1/w/lw-1/api/conversation-files/file-1',
    ])
  })
})

// ─── Reads vs. the machine's runtime (#SHO-185) ─────────────────────────────
//
// A machine workspace's rows live on the desktop, but the cloud keeps a copy of
// them under the desktop's own ids. A read therefore has two possible hosts, and
// which one it is decides whether a page waits on a sleeping machine. Rows come
// from the copy; only an answer that *is* the machine (an agent turn, a preview
// frame, a file on its disk) goes through the tunnel.

describe('shouldRouteToRemote: machine-workspace reads', () => {
  it('answers row reads from the cloud copy', () => {
    for (const path of [
      '/api/workspaces/ws-cloud/agent-profile',
      '/api/workspaces/ws-cloud/conversations?limit=30',
      '/api/workspaces/ws-cloud/history/search?q=x',
      '/api/conversations/conv-1',
      '/api/conversation-messages/msg-1',
      '/api/boards',
      '/api/work-items/SUP-42',
      '/api/projects?workspaceId=ws-cloud',
      '/api/chat-sessions',
    ]) {
      expect(shouldRouteToRemote(path, { ...MACHINE, isRead: true })).toBe(false)
    }
  })

  it("still tunnels the reads that only the machine can answer", () => {
    for (const path of [
      '/api/workspaces/ws-cloud/agent-proxy/agent/chat',
      '/api/workspaces/ws-cloud/preview?port=37626',
      '/api/workspaces/ws-cloud/runtime',
      '/api/workspaces/ws-cloud/local-files/list?path=/',
      '/api/workspaces/ws-cloud/ide/session',
      '/api/conversation-files/file-1',
      '/api/chat-attachments/att-1',
    ]) {
      expect(shouldRouteToRemote(path, { ...MACHINE, isRead: true })).toBe(true)
    }
  })

  it('leaves a write alone — a write is always the machine’s', () => {
    expect(shouldRouteToRemote('/api/boards', { ...MACHINE, isRead: false })).toBe(true)
    expect(shouldRouteToRemote('/api/conversations/conv-1', { ...MACHINE, isRead: false })).toBe(true)
  })

  it('keeps cloud-only families cloud-side even for a live read', () => {
    expect(
      shouldRouteToRemote('/api/workspaces/ws-cloud/instance', { ...MACHINE, isRead: true }),
    ).toBe(false)
    expect(shouldRouteToRemote('/api/billing/summary', { ...MACHINE, isRead: true })).toBe(false)
  })
})
