// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Codegen-Safety Evals (P0 reproduction)
 *
 * Reproduces the Subliminal regression where regenerating the backend after a
 * schema change clobbered custom code the user had added to `server.tsx`
 * (here: tenant-isolation middleware), silently re-opening a data-exposure
 * hole.
 *
 * Two-phase pipeline:
 *   Phase 1 — build a Post model + a route, and add custom middleware to
 *             server.tsx that rejects requests without an x-tenant-id header.
 *   Phase 2 — add a field to Post and regenerate the API. The tenant guard
 *             must survive.
 *
 * The `tenant-probe:posts` tag makes the runtime check issue an
 * unauthenticated GET /api/posts; `expect-tenant-isolation` scores it. Pre-fix
 * regeneration strips the guard and the route answers 200 (RED); post-fix the
 * guard is preserved and the route answers 401/403 (GREEN).
 *
 * NOTE: The deterministic root-cause proof is the protected-region unit test
 * (packages/sdk/src/generators/__tests__/server-custom-regions.test.ts); this
 * eval is the end-to-end behavioral guard.
 *
 * Track: --track codegen-safety
 */

import type { AgentEval, EvalResult } from './types'

function wroteTenantMiddleware(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file' && t.name !== 'edit_file') return false
    const path = String((t.input as any).path ?? '')
    const content = String((t.input as any).content ?? (t.input as any).new_string ?? '').toLowerCase()
    return /server\.tsx?$/.test(path) && (content.includes('x-tenant-id') || content.includes('403') || content.includes('forbidden'))
  })
}

/** Last server.tsx write still carries the tenant guard (regeneration didn't drop it). */
function lastServerWriteKeepsGuard(r: EvalResult): boolean {
  const writes = r.toolCalls.filter(t =>
    (t.name === 'write_file' || t.name === 'edit_file') &&
    /server\.tsx?$/.test(String((t.input as any).path ?? '')),
  )
  if (writes.length === 0) return false
  const last = writes[writes.length - 1]
  const content = String((last.input as any).content ?? (last.input as any).new_string ?? '').toLowerCase()
  return content.includes('x-tenant-id') || content.includes('403') || content.includes('forbidden')
}

function verifiedTenantGuard(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    const blob = JSON.stringify(t.input).toLowerCase()
    return (t.name === 'exec' || t.name === 'web' || t.name === 'browser') &&
      blob.includes('/api/posts') && (blob.includes('tenant') || blob.includes('403') || blob.includes('401'))
  })
}

export const CODEGEN_SAFETY_EVALS: AgentEval[] = [
  {
    id: 'codegen-safety-phase1-add-guard',
    name: 'Codegen safety — add Post model + tenant middleware',
    category: 'code-agent',
    level: 4,
    useRuntimeTemplate: true,
    useSkillServer: true,
    pipeline: 'codegen-safety',
    pipelinePhase: 1,
    tags: ['expect-tenant-isolation', 'tenant-probe:posts'],
    input: [
      'Add a `Post` model with fields: title (string), body (string), tenantId (string).',
      'Generate the REST route for it.',
      'Then add custom middleware to the root server.tsx that rejects ANY request',
      'missing an `x-tenant-id` request header with HTTP 403. Keep it clearly marked',
      'as custom code. Verify an unauthenticated GET /api/posts returns 403.',
    ].join('\n'),
    validationCriteria: [
      {
        id: 'added-tenant-middleware',
        description: 'Agent added tenant-guard middleware to server.tsx',
        points: 6,
        phase: 'execution',
        validate: (r) => wroteTenantMiddleware(r),
      },
      {
        id: 'verified-guard',
        description: 'Agent verified the guard via the API path',
        points: 4,
        phase: 'execution',
        validate: (r) => verifiedTenantGuard(r),
      },
    ],
    antiPatterns: ['Tool loop or repeated identical calls'],
    maxScore: 15,
  },
  {
    id: 'codegen-safety-phase2-regenerate',
    name: 'Codegen safety — schema change must not clobber custom middleware',
    category: 'code-agent',
    level: 4,
    useRuntimeTemplate: true,
    useSkillServer: true,
    pipeline: 'codegen-safety',
    pipelinePhase: 2,
    tags: ['expect-tenant-isolation', 'tenant-probe:posts'],
    input: [
      'Add a `published` boolean field (default false) to the Post model and regenerate the API so the new field is usable.',
      'The custom tenant guard you added earlier MUST still be enforced afterward —',
      'confirm an unauthenticated GET /api/posts still returns 403.',
    ].join('\n'),
    validationCriteria: [
      {
        id: 'guard-survives-regen',
        description: 'After regeneration, the tenant guard is still present in server.tsx',
        points: 6,
        phase: 'intention',
        validate: (r) => lastServerWriteKeepsGuard(r),
      },
      {
        id: 're-verified-guard',
        description: 'Agent re-verified tenant isolation after the schema change',
        points: 4,
        phase: 'execution',
        validate: (r) => verifiedTenantGuard(r),
      },
    ],
    antiPatterns: ['Regeneration overwrote custom server.tsx code'],
    maxScore: 15,
  },
]
