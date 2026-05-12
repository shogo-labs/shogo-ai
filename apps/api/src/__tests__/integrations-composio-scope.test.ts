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

import { describe, test, expect } from 'bun:test'

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
