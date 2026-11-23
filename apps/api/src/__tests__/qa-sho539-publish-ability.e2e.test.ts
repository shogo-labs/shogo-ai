// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-539 acceptance 2, at the boundary that actually decides it.
 *
 * `publish` is a *project* permission, so the per-turn workspace gate no longer
 * touches it (access-gate.ts) — the internal publish route is the gate. This
 * mounts the real `routes/internal` router with a real workspace runtime token
 * and a signed requester ticket, and asserts a project viewer is refused in the
 * envelope the agent's tool maps (`ability_not_allowed` + `project:publish`),
 * while an editor gets past the gate.
 *
 * The unit tests build that body from `abilityDenial`; this one proves the route
 * emits it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from './helpers/channels-test-db'

process.env.AI_PROXY_SECRET ||= 'sho-539-publish-ability-secret'
process.env.BETTER_AUTH_SECRET ||= 'sho-539-publish-ability-secret'
delete process.env.SHOGO_LOCAL_MODE

const { dir } = setupChannelsTestDb()

const { seedRbacWorld, db, _setRbacModeForTests } = await import('./helpers/rbac-world')
const { deriveWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')
const app = (await import('../routes/internal')).default

type World = Awaited<ReturnType<typeof seedRbacWorld>>

let w: World
let workspaceToken: string

beforeAll(async () => {
  _setRbacModeForTests('on')
  w = await seedRbacWorld()
  workspaceToken = deriveWorkspaceRuntimeToken(w.workspaceA)
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

function ticketFor(userId: string): string {
  return signRequesterTicket({ projectId: workspaceTicketKey(w.workspaceA), userId })
}

async function call(
  method: string,
  path: string,
  userId: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method,
    headers: {
      'x-runtime-token': workspaceToken,
      'X-Requester-Ticket': ticketFor(userId),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed }
}

describe('SHO-539: the internal publish route refuses a project viewer in the tool envelope', () => {
  test('POST /publish as a viewer → ability_not_allowed / project:publish', async () => {
    const res = await call('POST', `/projects/${w.projects.open}/publish`, w.users.viewer, {
      subdomain: 'viewer-cannot-publish',
    })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('ability_not_allowed')
    expect(res.body.error.permission).toBe('project:publish')
    expect(res.body.error.message).toMatch(/ask a workspace admin for project:publish/i)
  })

  test('POST /publish/ops as a viewer → the same envelope', async () => {
    const res = await call('POST', `/projects/${w.projects.open}/publish/ops`, w.users.viewer, {
      action: 'status',
    })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('ability_not_allowed')
    expect(res.body.error.permission).toBe('project:publish')
  })

  test('POST /domains (a custom-domain write) as a viewer → the same envelope', async () => {
    const res = await call('POST', `/projects/${w.projects.open}/domains`, w.users.viewer, {
      hostname: 'app.viewer-refused.example.com',
    })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('ability_not_allowed')
    expect(res.body.error.permission).toBe('project:publish')
  })

  test('an editor passes the gate and gets a publish-domain answer, not a refusal', async () => {
    // No subdomain: the route refuses before any build, which is all this needs
    // to show — the gate let the call through.
    const res = await call('POST', `/projects/${w.projects.open}/publish`, w.users.member, {})

    expect(res.status).not.toBe(403)
    expect(res.body.error?.code).not.toBe('ability_not_allowed')
  })

  test('reading the publish state stays open to a viewer', async () => {
    const res = await call('GET', `/projects/${w.projects.open}/publish`, w.users.viewer)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})
