// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-506 acceptance — the cloud agent's own call must survive the wake.
 *
 * `board_list` (and every `work_item_*`, team-chat read and schedule read) reaches
 * a desktop-hosted workspace through `agentBoardsRequest` → `personalFetch`, and
 * the API holds that request while it wakes the desktop: up to
 * `WAKE_MAX_WAIT_MS` = 75s. The reported failure was exactly this call — a
 * `board_list` at 02:40:21Z against Samsara, whose heartbeat was 40s old, which
 * needed a 35s wait.
 *
 * So the client timeout on this path has to outlast the wake, or the fix only
 * changes which error the model sees: a 20s abort instead of `device_offline`
 * (SHO-506 AC1 + AC3).
 *
 *   bun --no-env-file test packages/agent-runtime/src/__tests__/qa-sho506-caller-timeout.acceptance.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

process.env.SHOGO_API_URL = 'https://api.test'

/** The API's wake window; must match `WAKE_MAX_WAIT_MS` in `apps/api/src/routes/instances`. */
const WAKE_MAX_WAIT_MS = 75_000

const timeouts: number[] = []
const realTimeout = AbortSignal.timeout.bind(AbortSignal)
;(AbortSignal as any).timeout = (ms: number) => {
  timeouts.push(ms)
  return realTimeout(ms)
}

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

global.fetch = (async () => ok()) as any

const {
  agentBoardsRequest,
  listTeamChannels,
  listSchedules,
  listTriggers,
  HOST_WAKE_TOLERANT_TIMEOUT_MS,
} = await import('../internal-api')

/** The longest wait any single call may use on a path that can be forwarded to a host. */
function longest(): number {
  return timeouts.reduce((a, b) => Math.max(a, b), 0)
}

beforeEach(() => {
  timeouts.length = 0
})
afterEach(() => {
  timeouts.length = 0
})

describe('the agent-runtime outlasts the desktop wake (SHO-506 AC3)', () => {
  test('the tolerant timeout is longer than the 75s wake window', () => {
    expect(HOST_WAKE_TOLERANT_TIMEOUT_MS).toBeGreaterThan(WAKE_MAX_WAIT_MS)
  })

  test('board_list / work_item_* — the call that reported device_offline — waits out the wake', async () => {
    await agentBoardsRequest('ws-samsara', 'GET', '/boards')
    expect(timeouts.length).toBeGreaterThan(0)
    expect(longest()).toBeGreaterThanOrEqual(WAKE_MAX_WAIT_MS)
  })

  test('a work-item read waits out the wake', async () => {
    await agentBoardsRequest('ws-samsara', 'GET', '/work-items/SAM-1')
    expect(longest()).toBeGreaterThanOrEqual(WAKE_MAX_WAIT_MS)
  })

  test('team-chat reads wait out the wake', async () => {
    await listTeamChannels('ws-samsara')
    expect(longest()).toBeGreaterThanOrEqual(WAKE_MAX_WAIT_MS)
  })

  test('schedule and trigger reads wait out the wake', async () => {
    await listSchedules('ws-samsara')
    await listTriggers('ws-samsara')
    expect(longest()).toBeGreaterThanOrEqual(WAKE_MAX_WAIT_MS)
  })
})
