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
}

function makeCtx(opts: CtxOpts) {
  const store = new Map<string, unknown>(Object.entries(opts.vars ?? {}))
  const query = opts.query ?? {}
  return {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => void store.set(k, v),
    req: {
      url: `https://studio.shogo.ai${opts.path}`,
      method: opts.method ?? 'POST',
      query: (k?: string) => (k ? query[k] : query),
      param: () => undefined,
      header: () => undefined,
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
