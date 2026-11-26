// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for resolveWorkspaceIdForRequest — the home-region write router's
 * "which workspace is this request acting on?" resolver.
 *
 *   bun test apps/api/src/lib/__tests__/resolve-workspace-id.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'

// ---------------------------------------------------------------------------
// In-memory prisma double. Keys are row ids → the value returned by findUnique.
// ---------------------------------------------------------------------------
const projects: Record<string, { workspaceId: string }> = {
  proj_a: { workspaceId: 'ws_1' },
}
const chatSessions: Record<string, { workspaceId: string | null; contextType: string; contextId: string | null }> = {
  sess_ws: { workspaceId: 'ws_2', contextType: 'workspace', contextId: null },
  sess_proj: { workspaceId: null, contextType: 'project', contextId: 'proj_a' },
}
const subscriptions: Record<string, { workspaceId: string }> = {
  sub_a: { workspaceId: 'ws_3' },
}
const chatMessages: Record<string, { sessionId: string }> = {
  msg_a: { sessionId: 'sess_ws' },
}

function findUniqueFrom<T>(table: Record<string, T>) {
  return async ({ where: { id } }: { where: { id: string } }) => table[id] ?? null
}

const fakePrisma = {
  project: { findUnique: findUniqueFrom(projects) },
  chatSession: { findUnique: findUniqueFrom(chatSessions) },
  subscription: { findUnique: findUniqueFrom(subscriptions) },
  chatMessage: { findUnique: findUniqueFrom(chatMessages) },
  // Unused-by-these-tests accessors still need to exist for the lookup map.
  starredProject: { findUnique: async () => null },
  member: { findUnique: async () => null },
  billingAccount: { findUnique: async () => null },
  invitation: { findUnique: async () => null },
  folder: { findUnique: async () => null },
  usageWallet: { findUnique: async () => null },
  usageEvent: { findUnique: async () => null },
  workspaceGrant: { findUnique: async () => null },
  projectFolder: { findUnique: async () => null },
  featureSession: { findUnique: async () => null },
  chatSessionProject: { findUnique: async () => null },
  toolCallLog: { findUnique: async () => null },
  apiKey: { findUnique: async () => null },
  instance: { findUnique: async () => null },
  meeting: { findUnique: async () => null },
}

mock.module('../prisma', () => ({ prisma: fakePrisma }))

const { resolveWorkspaceIdForRequest } = await import('../resolve-workspace-id')

// ---------------------------------------------------------------------------
// Minimal Hono context double.
// ---------------------------------------------------------------------------
interface CtxOpts {
  path: string
  vars?: Record<string, unknown>
  query?: Record<string, string>
  method?: string
  /** Parsed JSON body the resolver may read for a body-only create. */
  body?: unknown
  contentType?: string
}

function makeCtx(opts: CtxOpts) {
  const store = new Map<string, unknown>(Object.entries(opts.vars ?? {}))
  const query = opts.query ?? {}
  const contentType = opts.contentType ?? (opts.body === undefined ? undefined : 'application/json')
  return {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => void store.set(k, v),
    req: {
      url: `https://studio.shogo.ai${opts.path}`,
      method: opts.method ?? 'POST',
      query: (k?: string) => (k ? query[k] : query),
      param: () => undefined,
      header: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : undefined),
      json: async () => {
        if (opts.body === undefined) throw new SyntaxError('no body')
        return opts.body
      },
      text: async () => JSON.stringify(opts.body),
    },
  } as any
}

describe('resolveWorkspaceIdForRequest', () => {
  test('returns the workspaceId already cached on the context', async () => {
    const c = makeCtx({ path: '/api/anything', vars: { workspaceId: 'ws_cached' } })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_cached')
  })

  test('reads an explicit ?workspaceId query param', async () => {
    const c = makeCtx({ path: '/api/usage-events', query: { workspaceId: 'ws_q' } })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_q')
  })

  test('treats /api/workspaces/:id as the workspace id', async () => {
    const c = makeCtx({ path: '/api/workspaces/ws_direct/visible-models' })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_direct')
  })

  test('uses auth.workspaceId for API-key / runtime-token callers', async () => {
    const c = makeCtx({ path: '/api/some-resource', vars: { auth: { workspaceId: 'ws_key' } } })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_key')
  })

  test('resolves a project path to its workspace', async () => {
    const c = makeCtx({ path: '/api/projects/proj_a/chat' })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_1')
  })

  test('resolves ?projectId query to its workspace', async () => {
    const c = makeCtx({ path: '/api/checkpoints', query: { projectId: 'proj_a' } })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_1')
  })

  test('resolves a generated workspace-owned resource by id', async () => {
    const c = makeCtx({ path: '/api/subscriptions/sub_a' })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_3')
  })

  test('resolves a workspace-scoped chat session by id', async () => {
    const c = makeCtx({ path: '/api/chat-sessions/sess_ws' })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_2')
  })

  test('resolves a project-scoped chat session through its project', async () => {
    const c = makeCtx({ path: '/api/chat-sessions/sess_proj' })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_1')
  })

  test('resolves a chat message through its session', async () => {
    const c = makeCtx({ path: '/api/chat-messages/msg_a' })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_2')
  })

  test('returns null for identity/global routes (no workspace)', async () => {
    const c = makeCtx({ path: '/api/users/user_123' })
    expect(await resolveWorkspaceIdForRequest(c)).toBeNull()
  })

  test('returns null for reserved project keyword paths', async () => {
    const c = makeCtx({ path: '/api/projects/import' })
    expect(await resolveWorkspaceIdForRequest(c)).toBeNull()
  })

  test('caches the resolved id back onto the context', async () => {
    const c = makeCtx({ path: '/api/projects/proj_a/files' })
    await resolveWorkspaceIdForRequest(c)
    expect(c.get('workspaceId')).toBe('ws_1')
  })

  test('returns null when an unknown project cannot be resolved', async () => {
    const c = makeCtx({ path: '/api/projects/missing/chat' })
    expect(await resolveWorkspaceIdForRequest(c)).toBeNull()
  })
})

/**
 * A create has no id in its path, so the body is the only thing naming the
 * workspace. These rows are drained / deleted / replied to by the home region —
 * a wrong-region write strands them (SHO-585).
 */
describe('resolveWorkspaceIdForRequest — body-only creates', () => {
  test('resolves a queued chat message from its sessionId', async () => {
    const c = makeCtx({ path: '/api/chat-queued-messages', body: { sessionId: 'sess_ws', content: 'hi' } })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_2')
  })

  test('resolves a chat message through a project-scoped session', async () => {
    const c = makeCtx({ path: '/api/chat-messages', body: { sessionId: 'sess_proj', role: 'user' } })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_1')
  })

  test('accepts chatSessionId as well as sessionId', async () => {
    const c = makeCtx({ path: '/api/tool-call-logs', body: { chatSessionId: 'sess_ws', toolName: 'x' } })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_2')
  })

  test('resolves a project folder from projectId', async () => {
    const c = makeCtx({ path: '/api/project-folders', body: { projectId: 'proj_a', name: 'Docs' } })
    expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_1')
  })

  test('resolves starred-projects and folders from a literal workspaceId', async () => {
    for (const collection of ['starred-projects', 'folders']) {
      const c = makeCtx({ path: `/api/${collection}`, body: { workspaceId: 'ws_body' } })
      expect(await resolveWorkspaceIdForRequest(c)).toBe('ws_body')
    }
  })

  test('stashes the bytes it consumed for the router to forward', async () => {
    const { FORWARD_BODY_KEY } = await import('../resolve-workspace-id')
    const body = { sessionId: 'sess_ws', content: 'hi' }
    const c = makeCtx({ path: '/api/chat-queued-messages', body })
    await resolveWorkspaceIdForRequest(c)
    expect(c.get(FORWARD_BODY_KEY)).toBe(JSON.stringify(body))
  })

  test('does not read a body for a non-create path', async () => {
    const c = makeCtx({ path: '/api/chat-queued-messages', method: 'GET', body: { sessionId: 'sess_ws' } })
    expect(await resolveWorkspaceIdForRequest(c)).toBeNull()
  })

  test('does not read a non-JSON body', async () => {
    const c = makeCtx({
      path: '/api/chat-queued-messages',
      body: { sessionId: 'sess_ws' },
      contentType: 'application/x-www-form-urlencoded',
    })
    expect(await resolveWorkspaceIdForRequest(c)).toBeNull()
  })

  test('stays local (null) when the body names an unknown session', async () => {
    const c = makeCtx({ path: '/api/chat-queued-messages', body: { sessionId: 'sess_missing' } })
    expect(await resolveWorkspaceIdForRequest(c)).toBeNull()
  })

  test('does not read the body of a collection it has no lookup for', async () => {
    const c = makeCtx({ path: '/api/notifications', body: { workspaceId: 'ws_body', userId: 'u1' } })
    expect(await resolveWorkspaceIdForRequest(c)).toBeNull()
  })
})
