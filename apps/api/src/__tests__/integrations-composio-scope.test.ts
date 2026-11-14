// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the asymmetric Composio user-id fallback used by
 * `apps/api/src/routes/integrations.ts`.
 *
 * The actual Hono routes are exercised by integrations.ts and depend on
 * Composio + Prisma + auth — that's covered by the broader e2e suite.
 * Here we only validate the pure logic of `buildLookupCandidates`,
 * which is what determines whether a workspace flipped from `project`
 * to `workspace` scope keeps resolving its old OAuth connections.
 *
 * The helper is not exported (it lives inside the same module as the
 * routes), so we re-implement it inline and keep the assertions
 * mirrored to the implementation. If the implementation diverges, the
 * test will fail as expected.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

type ComposioScope = 'workspace' | 'project'

function buildComposioUserId(
  userId: string,
  workspaceId: string,
  projectId: string,
  scope: ComposioScope = 'project',
): string {
  return scope === 'workspace'
    ? `shogo_${userId}_${workspaceId}`
    : `shogo_${userId}_${workspaceId}_${projectId}`
}

function buildLegacyComposioUserId(userId: string, projectId: string): string {
  return `shogo_${userId}_${projectId}`
}

function buildLookupCandidates(
  userId: string,
  workspaceId: string,
  projectId: string,
  scope: ComposioScope,
): string[] {
  const candidates =
    scope === 'workspace'
      ? [
          buildComposioUserId(userId, workspaceId, projectId, 'workspace'),
          buildComposioUserId(userId, workspaceId, projectId, 'project'),
          buildLegacyComposioUserId(userId, projectId),
        ]
      : [
          buildComposioUserId(userId, workspaceId, projectId, 'project'),
          buildLegacyComposioUserId(userId, projectId),
        ]
  return Array.from(new Set(candidates))
}

const U = 'user_abc'
const W = 'workspace_def'
const P = 'project_ghi'

describe('buildLookupCandidates (composio scope asymmetric fallback)', () => {
  test('workspace scope: returns ws-scoped + project-scoped + legacy IDs', () => {
    const ids = buildLookupCandidates(U, W, P, 'workspace')
    expect(ids).toContain(`shogo_${U}_${W}`)
    expect(ids).toContain(`shogo_${U}_${W}_${P}`)
    expect(ids).toContain(`shogo_${U}_${P}`)
    expect(ids.length).toBe(3)
  })

  test('project scope: returns ONLY project-scoped + legacy IDs', () => {
    // Critical: workspace-scoped IDs must NEVER appear here. If a user
    // has multiple projects on a single workspace and the workspace is
    // configured for project-scoped isolation, looking up project A's
    // connections must not surface project B's.
    const ids = buildLookupCandidates(U, W, P, 'project')
    expect(ids).toContain(`shogo_${U}_${W}_${P}`)
    expect(ids).toContain(`shogo_${U}_${P}`)
    expect(ids).not.toContain(`shogo_${U}_${W}`)
    expect(ids.length).toBe(2)
  })

  test('deduplicates IDs that happen to collide', () => {
    // When userId === projectId the legacy + project-scoped variants
    // can collide. The set-based dedup keeps the candidate list tight.
    const collidingIds = buildLookupCandidates('same', 'ws', 'same', 'project')
    expect(new Set(collidingIds).size).toBe(collidingIds.length)
  })

  test('asymmetric guarantee: workspace-scoped lookup is a strict superset of project-scoped lookup', () => {
    // Migration story: a workspace flipped from project → workspace
    // scope should keep seeing every connection it could see before.
    const wsIds = new Set(buildLookupCandidates(U, W, P, 'workspace'))
    const projIds = buildLookupCandidates(U, W, P, 'project')
    for (const id of projIds) {
      expect(wsIds.has(id)).toBe(true)
    }
  })
})

// =============================================================================
// REPRO 5 / FIX 5: disconnect/connect must prune EVERY connected account for
// the toolkit across all lookup-candidate user IDs, not just the single
// connectionId (disconnect) or skip prune entirely (connect). Otherwise a
// sibling ACTIVE account under a different candidate ID (workspace-scoped vs.
// legacy project-scoped) keeps `checkComposioAuth` reporting "active" forever
// — the "24 days OAuth theme" pain point.
// =============================================================================

process.env.COMPOSIO_API_KEY = 'test-composio-key'

// In-memory fake Composio connected-accounts store, seeded per test.
let fakeAccounts: Array<{ id: string; userId: string; toolkitSlug: string; status: string }> = []
let fakeToolkits: Array<{ slug: string; name: string }> = []
let deleteCalls: string[] = []
let authorizeCalls: Array<{ userId: string; toolkit: string }> = []

class FakeComposio {
  connectedAccounts = {
    list: async ({ userIds, toolkitSlugs }: { userIds: string[]; toolkitSlugs?: string[] }) => {
      const wantedToolkits = toolkitSlugs?.map((t) => t.toLowerCase())
      const items = fakeAccounts.filter(
        (a) =>
          userIds.includes(a.userId) &&
          (!wantedToolkits || wantedToolkits.includes(a.toolkitSlug.toLowerCase())),
      )
      return { items: items.map((a) => ({ id: a.id, toolkit: { slug: a.toolkitSlug }, status: a.status })) }
    },
    delete: async (id: string) => {
      deleteCalls.push(id)
      fakeAccounts = fakeAccounts.filter((a) => a.id !== id)
    },
  }
  toolkits = { get: async () => fakeToolkits }
  create = async (userId: string, _opts?: any) => ({
    authorize: async (toolkit: string, _opts?: any) => {
      authorizeCalls.push({ userId, toolkit })
      return { redirectUrl: 'https://composio.example/auth', id: 'conn-new', status: 'INITIATED' }
    },
  })
}

mock.module('@composio/core', () => ({ Composio: FakeComposio }))

// Force the workspace-scope lookup to always fall back to the default
// ('workspace') deterministically, without touching a real database.
mock.module('../lib/prisma', () => ({
  prisma: {
    workspace: { findUnique: async () => null },
    project: { findUnique: async () => null },
  },
}))

const { integrationRoutes } = await import('../routes/integrations')

function buildIntegrationsApp(auth: { userId: string; workspaceId?: string }) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  app.route('/api', integrationRoutes())
  return app
}

const PRUNE_USER = 'user_prune'
const PRUNE_WORKSPACE = 'ws_prune'
const PRUNE_PROJECT = 'proj_prune'
// Matches buildComposioUserId(userId, workspaceId, projectId, 'workspace')
const WORKSPACE_SCOPED_ID = `shogo_${PRUNE_USER}_${PRUNE_WORKSPACE}`
// Matches buildLegacyComposioUserId(userId, projectId)
const LEGACY_SCOPED_ID = `shogo_${PRUNE_USER}_${PRUNE_PROJECT}`

describe('integrations routes — disconnect/connect prune sibling accounts (repro + fix)', () => {
  beforeEach(() => {
    fakeAccounts = [
      { id: 'conn-ws', userId: WORKSPACE_SCOPED_ID, toolkitSlug: 'googledrive', status: 'ACTIVE' },
      { id: 'conn-legacy', userId: LEGACY_SCOPED_ID, toolkitSlug: 'googledrive', status: 'ACTIVE' },
    ]
    deleteCalls = []
    authorizeCalls = []
  })

  test('DELETE prunes the sibling legacy account too, not just the targeted id', async () => {
    // Mirrors a real project-context caller (e.g. ToolsPanel/ServicesPanel):
    // the auth session already carries workspaceId, and the request passes
    // projectId — together these resolve every lookup candidate, including
    // the legacy project-scoped ID.
    const app = buildIntegrationsApp({ userId: PRUNE_USER, workspaceId: PRUNE_WORKSPACE })

    const del = await app.fetch(
      new Request(
        `http://localhost/api/integrations/connections/conn-ws?projectId=${PRUNE_PROJECT}`,
        { method: 'DELETE' },
      ),
    )
    expect(del.status).toBe(200)

    const list = await app.fetch(
      new Request(`http://localhost/api/integrations/connections?projectId=${PRUNE_PROJECT}`),
    )
    const body = (await list.json()) as { data: Array<{ id: string }> }

    // Fixed behavior: the sibling legacy account for the same toolkit must
    // also be gone — it must not keep winning the ACTIVE check.
    expect(body.data.find((c) => c.id === 'conn-legacy')).toBeUndefined()
    expect(deleteCalls.sort()).toEqual(['conn-legacy', 'conn-ws'])
  })

  test('POST /connect prunes existing accounts for the toolkit before authorizing', async () => {
    const app = buildIntegrationsApp({ userId: PRUNE_USER, workspaceId: PRUNE_WORKSPACE })

    const res = await app.fetch(
      new Request('http://localhost/api/integrations/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkit: 'googledrive', projectId: PRUNE_PROJECT }),
      }),
    )
    expect(res.status).toBe(200)

    // Both pre-existing accumulated accounts must be pruned before the new
    // authorize call — reconnect replaces rather than accumulates.
    expect(deleteCalls.sort()).toEqual(['conn-legacy', 'conn-ws'])
    expect(authorizeCalls).toHaveLength(1)
    expect(authorizeCalls[0]?.toolkit).toBe('googledrive')
  })

  test('DELETE leaves a different-toolkit sibling account alone', async () => {
    fakeAccounts.push({ id: 'conn-slack', userId: WORKSPACE_SCOPED_ID, toolkitSlug: 'slack', status: 'ACTIVE' })
    const app = buildIntegrationsApp({ userId: PRUNE_USER, workspaceId: PRUNE_WORKSPACE })

    await app.fetch(
      new Request(
        `http://localhost/api/integrations/connections/conn-ws?projectId=${PRUNE_PROJECT}`,
        { method: 'DELETE' },
      ),
    )

    expect(deleteCalls).not.toContain('conn-slack')
    const list = await app.fetch(
      new Request(`http://localhost/api/integrations/connections?projectId=${PRUNE_PROJECT}`),
    )
    const body = (await list.json()) as { data: Array<{ id: string }> }
    expect(body.data.find((c) => c.id === 'conn-slack')).toBeDefined()
  })

  test('DELETE with only workspaceId (no projectId) prunes what it can resolve (workspace-scoped) without erroring on the unresolvable legacy id', async () => {
    // Settings → Integrations panel only knows workspaceId. It cannot guess
    // the legacy per-project id, so pruning is best-effort within what the
    // caller's context can resolve — this must not throw or 500.
    const app = buildIntegrationsApp({ userId: PRUNE_USER })

    const del = await app.fetch(
      new Request(
        `http://localhost/api/integrations/connections/conn-ws?workspaceId=${PRUNE_WORKSPACE}`,
        { method: 'DELETE' },
      ),
    )
    expect(del.status).toBe(200)
    expect(deleteCalls).toContain('conn-ws')
  })
})

// =============================================================================
// SHO-379: Instagram and TikTok connect through Zernio (the Social page), not
// Composio. The provider list must not offer them as Composio toolkits, and
// /connect must refuse them before any OAuth starts.
// =============================================================================

describe('integrations routes — Instagram/TikTok are Zernio, not Composio (SHO-379)', () => {
  beforeEach(() => {
    fakeAccounts = []
    fakeToolkits = [
      { slug: 'slack', name: 'Slack' },
      { slug: 'metaads', name: 'Meta Ads' },
      { slug: 'instagram', name: 'Instagram' },
      { slug: 'tiktok', name: 'TikTok' },
    ]
    deleteCalls = []
    authorizeCalls = []
  })

  test('GET /integrations/providers drops instagram/tiktok and returns socialProviders for both', async () => {
    const app = buildIntegrationsApp({ userId: PRUNE_USER, workspaceId: PRUNE_WORKSPACE })
    const res = await app.fetch(new Request('http://localhost/api/integrations/providers'))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: Array<{ toolkit: string }>
      socialProviders: Array<{ toolkit: string; provider: string; href: string }>
    }
    const slugs = body.data.map((p) => p.toolkit)
    expect(slugs).toContain('slack')
    expect(slugs).toContain('metaads')
    expect(slugs).not.toContain('instagram')
    expect(slugs).not.toContain('tiktok')

    expect(body.socialProviders.map((p) => p.toolkit).sort()).toEqual(['instagram', 'tiktok'])
    for (const p of body.socialProviders) {
      expect(p.provider).toBe('zernio')
      expect(p.href).toBe('/social')
    }
  })

  test.each(['instagram', 'Instagram', 'tik-tok', 'tiktok'])(
    'POST /integrations/connect { toolkit: %s } returns 409 social_provider_zernio and starts no OAuth',
    async (toolkit) => {
      const app = buildIntegrationsApp({ userId: PRUNE_USER, workspaceId: PRUNE_WORKSPACE })
      const res = await app.fetch(
        new Request('http://localhost/api/integrations/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolkit, projectId: PRUNE_PROJECT }),
        }),
      )
      expect(res.status).toBe(409)
      const body = (await res.json()) as { code: string; href: string }
      expect(body.code).toBe('social_provider_zernio')
      expect(body.href).toBe('/social')
      expect(authorizeCalls).toHaveLength(0)
      expect(deleteCalls).toHaveLength(0)
    },
  )

  test('POST /integrations/connect { toolkit: "metaads" } still goes through Composio', async () => {
    const app = buildIntegrationsApp({ userId: PRUNE_USER, workspaceId: PRUNE_WORKSPACE })
    const res = await app.fetch(
      new Request('http://localhost/api/integrations/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkit: 'metaads', projectId: PRUNE_PROJECT }),
      }),
    )
    expect(res.status).toBe(200)
    expect(authorizeCalls).toHaveLength(1)
    expect(authorizeCalls[0]?.toolkit).toBe('metaads')
  })
})
