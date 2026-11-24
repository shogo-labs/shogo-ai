// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-538 — a hosted workspace's runtime call must answer inside Cloudflare's edge
 * budget, in both states a paired desktop can be in.
 *
 * The bug: an idle desktop's tunnel closes, and `handleHostTunnel` then waited out
 * its next heartbeat poll (up to 75s) *and* ran the request on top of it (up to
 * 30s), with no bytes sent in between — past the 100s Cloudflare allows for
 * response headers, so the first call after an idle period answered **524** and a
 * retry worked.
 *
 * This measures, on the real two-process harness (cloud + desktop + their own
 * Postgres/Redis databases), what Rusty would have seen:
 *
 *   1. host live, tunnel up        → plans is a normal, fast 200
 *   2. host switched off           → an immediate, retryable 503 — never a hang
 *   3. host alive, tunnel down     → the first plans call answers inside the
 *                                    interactive wake window (503 host_connecting
 *                                    with Retry-After), and the client's retry
 *                                    gets its 200 once the tunnel is back
 *
 * State 3 is the bug's state. Whether the tunnel closed because the desktop idled
 * or because the process restarted makes no difference to the code path: the
 * cloud has no tunnel and the desktop only learns it is wanted from its next
 * heartbeat poll. Killing and restarting the desktop is how this harness produces
 * that state without waiting the five idle minutes.
 *
 * Needs `CHANNELS_TEST_PG_URL` and `TEST_REDIS_URL`/`REDIS_URL`; skipped otherwise.
 *
 *   CHANNELS_TEST_PG_URL=postgresql://postgres@127.0.0.1:55432/postgres \
 *   REDIS_URL=redis://127.0.0.1:6379/9 \
 *   bun test apps/api/src/__tests__/hosted-workspace-wake-budget.e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  httpClient,
  pairMachine,
  read,
  REPO_ROOT,
  startCloud,
  waitFor,
  type CloudProcess,
  type PairedMachine,
} from './helpers/machine-vm-harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

/** Cloudflare gives an origin 100s for response headers; nothing here may approach it. */
const EDGE_LIMIT_MS = 100_000

/** What a first call is allowed to spend before the cloud answers for the host. */
const INTERACTIVE_ANSWER_MS = 30_000

let cloud: CloudProcess
let machine: PairedMachine

const clients = () => ({
  cloud: httpClient(cloud.base, machine.cookies),
  desktop: httpClient(machine.localApiBase, machine.localCookies),
})

async function send(client: ReturnType<typeof httpClient>, method: string, path: string, body?: unknown) {
  try {
    const res: any = await client.request(path, { method, body: body as any })
    return { status: (res.status ?? 200) as number, data: res.data }
  } catch (err: any) {
    return { status: (err?.status ?? 0) as number, data: err?.details ?? err?.message ?? null }
  }
}

const plansPath = () => `/api/workspaces/${encodeURIComponent(machine.machineWorkspaceId)}/agent-proxy/agent/plans`

/**
 * A GET read the way a person experiences it: how long until the cloud answered
 * at all, and how long until the body was there.
 */
async function timedGet(path: string, timeoutMs: number) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${cloud.base}${path}`, {
      headers: { cookie: machine.cookies, origin: cloud.base },
      signal: controller.signal,
    })
    const headersAt = Date.now() - startedAt
    const text = await res.text()
    return {
      status: res.status,
      headersAt,
      totalAt: Date.now() - startedAt,
      retryAfter: res.headers.get('retry-after'),
      body: text.slice(0, 400),
      json: (() => {
        try {
          return JSON.parse(text)
        } catch {
          return null
        }
      })(),
    }
  } catch (err: any) {
    return {
      status: 0,
      headersAt: Date.now() - startedAt,
      totalAt: Date.now() - startedAt,
      retryAfter: null,
      body: `aborted: ${err?.name ?? err?.message ?? err}`,
      json: null,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** What `agentFetch` does for a GET: answer, and if the host is waking, ask again. */
async function plansLikeAClient() {
  const attempts: Array<Awaited<ReturnType<typeof timedGet>>> = []
  let res = await timedGet(plansPath(), EDGE_LIMIT_MS)
  attempts.push(res)
  for (let i = 0; i < 2 && res.status !== 200; i += 1) {
    const waitMs = Math.min(15_000, Number(res.retryAfter ?? 15) * 1000 || 15_000)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    res = await timedGet(plansPath(), EDGE_LIMIT_MS)
    attempts.push(res)
  }
  return attempts
}

async function waitForTunnel(online: boolean): Promise<void> {
  const path = `/api/instances/${encodeURIComponent(machine.machineId)}`
  await waitFor(
    online ? 'the desktop tunnel' : 'the desktop tunnel to go',
    async () => {
      const res = await read(clients().cloud, path)
      return res.status < 300 && (res.data?.status === 'online') === online
    },
    120_000,
    1_000,
  )
}

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  cloud = await startCloud({ pgServerUrl: PG_URL, redisUrl: REDIS_URL })
  machine = await pairMachine(cloud.base, {
    instanceName: `wake-${Math.random().toString(36).slice(2, 6)}`,
    repoRoot: REPO_ROOT,
    dir: mkdtempSync(join(tmpdir(), 'sho538-desktop-')),
  })
  // What the app does when a hosted workspace is opened (part 2).
  await send(clients().cloud, 'POST', `/api/instances/${encodeURIComponent(machine.machineId)}/request-connect`)
  await waitForTunnel(true)
}, 300_000)

afterAll(async () => {
  await machine?.stop()
  await cloud?.stop()
})

describeIfInfra('a hosted workspace answers inside the edge budget (SHO-538)', () => {
  test('AC1 · a live host answers plans fast', async () => {
    const res = await timedGet(plansPath(), EDGE_LIMIT_MS)
    console.log(`[SHO-538] live host: ${res.status} in ${res.headersAt}ms`)
    expect(res.status).toBe(200)
    expect(res.headersAt).toBeLessThan(10_000)
  }, 180_000)

  test('AC2 · a host that is switched off answers inside the interactive window, not past the edge', async () => {
    await machine.kill()
    await waitForTunnel(false)

    const res = await timedGet(plansPath(), EDGE_LIMIT_MS)
    console.log(`[SHO-538] host off: ${res.status} in ${res.headersAt}ms — ${res.body.slice(0, 200)}`)

    // Two honest outcomes, one budget: a host the cloud just saw is
    // `connecting` (it may be waking) and one it has not seen for a while is
    // `offline`. Both are retryable and both answer inside the wake window —
    // that is the whole fix, so the code is not asserted, the timing is.
    expect(res.headersAt).toBeLessThan(INTERACTIVE_ANSWER_MS)
    expect(res.status).toBe(503)
    expect(['host_connecting', 'host_offline']).toContain(res.json?.error?.code)
    expect(res.json?.error?.retryable).toBe(true)
    if (res.json?.error?.code === 'host_connecting') expect(res.retryAfter).not.toBeNull()
  }, 180_000)

  test('AC3 · a host that is coming back answers inside the interactive window, then the retry gets plans', async () => {
    // The desktop is switched back on: its tunnel is down until it polls, which
    // is the state an idle close leaves behind too.
    await machine.restart()

    const attempts = await plansLikeAClient()
    const first = attempts[0]
    console.log(
      `[SHO-538] host waking: first ${first.status} in ${first.headersAt}ms` +
        (first.retryAfter ? ` (Retry-After ${first.retryAfter}s)` : '') +
        ` then ${attempts.slice(1).map((a) => `${a.status} in ${a.headersAt}ms`).join(', ')}`,
    )

    // The whole point: the first call answers, and it answers well inside 100s.
    expect(first.headersAt).toBeLessThan(INTERACTIVE_ANSWER_MS)
    expect(first.status === 200 || first.status === 503).toBe(true)
    if (first.status === 503) {
      expect(first.json?.error?.code).toBe('host_connecting')
      expect(first.json?.error?.retryable).toBe(true)
      expect(first.retryAfter).not.toBeNull()
    }

    // And a client that asks again gets the workspace, once the tunnel is back.
    const last = attempts[attempts.length - 1]
    expect(last.status).toBe(200)
    for (const attempt of attempts) expect(attempt.headersAt).toBeLessThan(EDGE_LIMIT_MS)
  }, 300_000)
})
