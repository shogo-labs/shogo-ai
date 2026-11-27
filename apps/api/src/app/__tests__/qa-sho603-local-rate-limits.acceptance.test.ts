// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-603 QA acceptance — a desktop must not answer its own agents and UI 429.
 *
 * The card's evidence is a real machine: `work_item_*` tool calls, checkpoint
 * records and trust refreshes all landed on `/api/*` over loopback with no
 * forwarding headers, so `getClientIp` keyed every one of them as `'unknown'`
 * and a team of agents sharing the single 600/min bucket hit
 * `429 { code: 'rate_limited' }` inside a minute.
 *
 * This spec drives the **real local composer** (`createLocalApp`, the same app
 * `apps/api/src/local-server.ts` serves) against a real SQLite database with
 * the desktop migration history, and reproduces one minute of a running team:
 * board polling, workspace navigation, the auth handler, and the runtime's
 * internal checkpoint/trust callbacks, 2,000 requests in total, exactly the way
 * the renderer and the runtimes send them (loopback, no `x-forwarded-for`).
 *
 * Everything is asserted on the response itself — status AND headers — because
 * a 200 with `X-RateLimit-Remaining: 0` still means the limiter is mounted and
 * the machine is one burst away from answering 429 again.
 *
 * Cloud is not exercised here: `apps/api/src/server.ts` is a separate composer
 * this card does not touch (its `auth` 60/min and `global` 600/min mounts are
 * covered by `middleware/__tests__/rate-limit.test.ts`, and the composer-level
 * `profile: 'cloud'` branch by `local-rate-limits.test.ts`). The per-user limits
 * in `lib/chat-limits.ts` are keyed by user and stay on — covered by
 * `__tests__/chat-limits.integration.test.ts` (the 61st post is a 429).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from '../../__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const workspacesDir = mkdtempSync(join(tmpdir(), 'sho603-ws-'))
process.env.WORKSPACES_DIR = workspacesDir

const { prisma } = await import('../../lib/prisma')
const { createLocalApp } = await import('../create-local-app')

const db = prisma as any
const app = createLocalApp().app

let seed: SeededWorkspace
let boardId: string

beforeAll(async () => {
  seed = await seedWorkspace(db)
  const created = await app.request(`/api/workspaces/${seed.workspaceId}/boards`, {
    method: 'POST',
    headers: { 'x-tunnel-auth-user-id': seed.owner, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'QA Board' }),
  })
  expect(created.status).toBe(201)
  boardId = ((await created.json()) as any).board.id
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(workspacesDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

/** Exactly what the desktop sends: the person's tunnel identity, no IP headers. */
const asUser = (init: RequestInit = {}) => ({
  ...init,
  headers: {
    'x-tunnel-auth-user-id': seed.owner,
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(init.headers ?? {}),
  },
})

interface Observed {
  status: number
  rateLimitHeaders: string[]
}

async function observe(init: RequestInit | undefined, path: string): Promise<Observed> {
  const res = await app.request(path, init)
  const rateLimitHeaders = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after']
    .filter((h) => res.headers.get(h) !== null)
    .map((h) => `${h}=${res.headers.get(h)}`)
  return { status: res.status, rateLimitHeaders }
}

function tally(seen: Observed[]) {
  const statuses = new Map<number, number>()
  const withHeaders = new Map<string, number>()
  for (const one of seen) {
    statuses.set(one.status, (statuses.get(one.status) ?? 0) + 1)
    for (const header of one.rateLimitHeaders) withHeaders.set(header, (withHeaders.get(header) ?? 0) + 1)
  }
  return { statuses: Object.fromEntries(statuses), withHeaders: Object.fromEntries(withHeaders) }
}

describe('SHO-603 — the desktop never rate-limits its own user or agents by IP', () => {
  test('AC1 + AC2: one minute of a running team (2,000 /api/* calls) — no 429, no X-RateLimit headers', async () => {
    // The mix a busy machine actually produces: board polling while agents work
    // (the `work_item_*` tools), workspace navigation, the auth handler the app
    // hits constantly, and the runtime's internal checkpoint/trust callbacks.
    const mix: Array<[string, RequestInit | undefined]> = [
      ...Array.from({ length: 700 }, () => ['/api/workspaces', asUser()] as [string, RequestInit]),
      ...Array.from({ length: 500 }, () => [`/api/workspaces/${seed.workspaceId}/boards`, asUser()] as [string, RequestInit]),
      ...Array.from({ length: 300 }, () => [`/api/workspaces/${seed.workspaceId}/boards/health`, asUser()] as [string, RequestInit]),
      ...Array.from({ length: 300 }, () => ['/api/version', undefined] as [string, undefined]),
      ...Array.from({ length: 100 }, () => ['/api/auth/get-session', undefined] as [string, undefined]),
      ...Array.from({ length: 50 }, () => [`/api/internal/projects/${seed.projectId}/trust`, undefined] as [string, undefined]),
      ...Array.from({ length: 50 }, () =>
        [
          `/api/internal/projects/${seed.projectId}/checkpoints/record`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              commitSha: '0'.repeat(40),
              commitMessage: 'noop',
              branch: 'main',
              filesChanged: 0,
              additions: 0,
              deletions: 0,
            }),
          },
        ] as [string, RequestInit]),
    ]

    const seen: Observed[] = []
    for (const [path, init] of mix) seen.push(await observe(init, path))
    const { statuses, withHeaders } = tally(seen)

    expect(mix.length).toBe(2_000)
    // The whole point: not one 429 in a burst the old shared bucket answered 429.
    expect(statuses[429]).toBeUndefined()
    // No limiter touched the response, so it is not one burst away from 429 either.
    expect(withHeaders).toEqual({})
    // ...and the calls actually reached their handlers.
    expect(statuses[200]).toBeGreaterThanOrEqual(700 + 500 + 300 + 300 + 100)
  })

  test('AC1: the runtime’s internal callbacks are answered by their own auth, not the limiter', async () => {
    // Without a runtime token these are 401/403 — the point is that after 700
    // calls they are still that, and never 429 (this is what filled the bucket
    // on Russell's machine: postCheckpointRecord / trust-resolver on a loop).
    const seen: Observed[] = []
    for (let i = 0; i < 350; i++) {
      seen.push(await observe(undefined, `/api/internal/projects/${seed.projectId}/trust`))
      seen.push(await observe(undefined, `/api/internal/projects/${seed.projectId}/checkpoints/record`))
    }
    const { statuses, withHeaders } = tally(seen)

    expect(statuses[429]).toBeUndefined()
    expect(withHeaders).toEqual({})
    // Mounted and refusing on auth — not a 404 from a route that never ran.
    expect(Object.keys(statuses).every((code) => code === '401' || code === '403')).toBe(true)
  })

  test('AC1: a real board read keeps returning real data past the old limit', async () => {
    // A named route, not `/api/version`: the 650th authenticated board list is
    // still 200 with the board the person actually has, so the burst above got
    // through the gate and the route behind it, not just the public health path.
    let last: { status: number; boards: string[] } | null = null
    for (let i = 0; i < 650; i++) {
      const res = await app.request(`/api/workspaces/${seed.workspaceId}/boards`, asUser())
      const body: any = await res.json().catch(() => null)
      last = { status: res.status, boards: (body?.boards ?? []).map((b: any) => b.id) }
    }
    expect(last).not.toBeNull()
    expect(last!.status).toBe(200)
    expect(last!.boards).toContain(boardId)
  })
})
