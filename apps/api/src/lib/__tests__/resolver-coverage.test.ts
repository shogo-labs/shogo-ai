// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolver-coverage CI guard.
 *
 * Every Prisma model that carries a `workspaceId` or `projectId` scalar is a
 * workspace-owned (tenant) table, so a mutation to it MUST resolve to a single
 * home region — otherwise it becomes a multi-writer row and reintroduces the
 * exact replication-conflict class region write-ownership exists to kill.
 *
 * This test parses prisma/schema.prisma and fails if such a model is neither
 *   - resolvable by the home-region router (present in `WORKSPACE_RESOLVED_MODELS`
 *     or `USER_RESOLVED_MODELS`), nor
 *   - explicitly listed in `EXEMPT` below with a documented reason.
 *
 * When this fails on a NEW model, do ONE of:
 *   1. Add a lookup in resolve-workspace-id.ts / resolve-user-id.ts (preferred
 *      for anything mutated via its own `/api/<resource>/:id` route), or
 *   2. Add it to `EXEMPT` with a reason (for models routed by URL path params,
 *      pinned to primary by prefix, or not mutated via REST).
 *
 *   bun test apps/api/src/lib/__tests__/resolver-coverage.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Importing the resolvers pulls in `./prisma`; stub it so this test needs no DB.
mock.module('../prisma', () => ({ prisma: {} }))

const { WORKSPACE_RESOLVED_MODELS } = await import('../resolve-workspace-id')
const { USER_RESOLVED_MODELS } = await import('../resolve-user-id')

/** PascalCase model name → Prisma client accessor (lowercase first char). */
function accessor(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

/**
 * Models that legitimately carry `workspaceId`/`projectId` but are NOT in the
 * resolver lookup maps, with the reason each is still single-writer-safe.
 * Keyed by Prisma client accessor. See docs/runbooks/region-write-ownership.md.
 */
const EXEMPT: Record<string, string> = {
  // --- Mutated only via workspace/project-scoped routes -------------------
  // These have no standalone `/api/<resource>/:id` mutation; their HTTP routes
  // always carry workspaceId/projectId in the path or query, which the router
  // resolves (steps 2-5) BEFORE the lookup table — so they're already pinned to
  // the workspace's home region.
  agentConfig: 'Mutated via /api/projects/:projectId/... — resolved by path projectId.',
  agentCostMetric: 'Written via project/workspace-scoped agent routes — resolved by path params.',
  agentEvalResult: 'Mutated via workspace/project-scoped eval routes — resolved by path params.',
  agentEvalSet: 'Mutated via workspace/project-scoped eval routes — resolved by path params.',
  budgetAlert: 'Mutated via /api/workspaces/:id/... budget routes — resolved by path workspaceId.',
  customDomain: 'Mutated via /api/projects/:projectId/domains — resolved by path projectId.',
  gitHubConnection: 'Mutated via /api/projects/:projectId/github — resolved by path projectId.',
  instanceSubscription: 'Mutated via /api/workspaces/:id/... — resolved by path workspaceId.',
  inviteLink: 'Mutated via /api/workspaces/:id/invite-links — resolved by path workspaceId.',
  marketplaceInstall: 'Mutated via /api/workspaces/:id/... — resolved by path workspaceId.',
  marketplaceListing: 'Mutated via /api/projects/:projectId/... — resolved by path projectId.',
  modelExperiment: 'Mutated via workspace/project-scoped routes — resolved by path params.',
  projectAgent: 'Mutated via /api/projects/:projectId/agents — resolved by path projectId.',
  projectAttachment: 'Mutated via /api/projects/:projectId/attachments — resolved by path projectId.',
  projectAuthConfig: 'Mutated via /api/projects/:projectId/auth — resolved by path projectId.',
  projectAuthSignIn: 'Mutated via /api/projects/:projectId/auth — resolved by path projectId.',
  projectCheckpoint: 'Mutated via /api/projects/:projectId/checkpoints — resolved by path projectId.',
  storageUsage: 'Counter table written via workspace-scoped usage routes — resolved by path workspaceId.',
  subagentModelOverride: 'Mutated via workspace/project-scoped routes — resolved by path params.',
  voiceCallMeter: 'Counter table written via project-scoped voice routes — resolved by path projectId.',
  voiceProjectConfig: 'Mutated via /api/projects/:projectId/voice — resolved by path projectId.',
  workspaceModelVisibility: 'Mutated via /api/workspaces/:id/... — resolved by path workspaceId.',
}

function parseModelsWithTenantKey(schema: string): string[] {
  const out: string[] = []
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  let m: RegExpExecArray | null
  while ((m = modelRe.exec(schema)) !== null) {
    const [, name, body] = m
    // A scalar FK field literally named workspaceId / projectId (not a relation
    // field like `workspace Workspace @relation(...)`).
    const hasTenantKey = /\n\s*(workspaceId|projectId)\s+String/.test(body)
    if (hasTenantKey) out.push(name)
  }
  return out
}

describe('resolver coverage', () => {
  const schema = readFileSync(
    join(import.meta.dir, '../../../../../prisma/schema.prisma'),
    'utf8',
  )
  const tenantModels = parseModelsWithTenantKey(schema)

  test('schema has tenant-scoped models to check', () => {
    expect(tenantModels.length).toBeGreaterThan(0)
  })

  test('every workspaceId/projectId model is resolvable or explicitly exempt', () => {
    const covered = new Set<string>([
      ...WORKSPACE_RESOLVED_MODELS,
      ...USER_RESOLVED_MODELS,
      ...Object.keys(EXEMPT),
    ])

    const uncovered = tenantModels
      .map(accessor)
      .filter((a) => !covered.has(a))

    expect(
      uncovered,
      `These models have a workspaceId/projectId but are not resolvable by the ` +
        `home-region router and are not in EXEMPT. Add a resolver lookup or an ` +
        `EXEMPT entry (with reason): ${uncovered.join(', ')}`,
    ).toEqual([])
  })

  test('EXEMPT has no stale entries', () => {
    const tenantAccessors = new Set(tenantModels.map(accessor))
    const stale = Object.keys(EXEMPT).filter((a) => !tenantAccessors.has(a))
    expect(
      stale,
      `EXEMPT lists models with no workspaceId/projectId field (remove them): ${stale.join(', ')}`,
    ).toEqual([])
  })

  test('EXEMPT does not duplicate resolvable models', () => {
    const resolvable = new Set<string>([...WORKSPACE_RESOLVED_MODELS, ...USER_RESOLVED_MODELS])
    const dup = Object.keys(EXEMPT).filter((a) => resolvable.has(a))
    expect(
      dup,
      `These EXEMPT entries are already resolvable; drop them from EXEMPT: ${dup.join(', ')}`,
    ).toEqual([])
  })
})
