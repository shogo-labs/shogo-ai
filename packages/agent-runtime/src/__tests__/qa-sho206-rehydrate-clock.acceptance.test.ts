// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance for SHO-206, guest side: `POST /pool/rehydrate` is the only
 * place the host's clock reaches a restored guest, and it must stay invisible
 * to a host that does not send one.
 *
 * This drives the *real* route — the server's exported `fetch`, the same
 * handler `Bun.serve` uses in a metal guest — because the dev's unit tests call
 * `syncGuestClock` directly and would not notice the route dropping the body,
 * reading the wrong field, or 500ing instead of reporting a clock it cannot set.
 *
 * Every skew sent here is inside the 2 s tolerance unless the process provably
 * cannot set the clock, so this test never moves the clock of the machine it
 * runs on (a Linux CI container may be root and would otherwise succeed).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clockSetBlockedReason } from '../guest-clock'

/** Workspace dirs, so importing the server does not try to seed /app. */
const dir = mkdtempSync(join(tmpdir(), 'qa-sho206-rehydrate-'))
let server: { fetch: (req: Request, srv?: any) => Promise<Response> }

beforeAll(async () => {
  process.env.WORKSPACE_DIR = join(dir, 'workspace')
  process.env.AGENT_DIR = join(dir, 'agent')
  // The server refuses to load without one; it only names the preview manager
  // this temp workspace gets, so nothing outside `dir` is touched.
  process.env.PROJECT_ID = process.env.PROJECT_ID ?? 'qa-sho206'
  server = (await import('../server')).default as any
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function rehydrate(body?: unknown): Promise<Response> {
  return server.fetch(
    new Request('http://127.0.0.1/pool/rehydrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {},
  )
}

describe('SHO-206 · POST /pool/rehydrate clock step', () => {
  /** The response an old host knows: `{ ok, projects }` and nothing else. */
  function expectTodaysShape(body: any) {
    expect(Object.keys(body).sort()).toEqual(['ok', 'projects'])
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.projects)).toBe(true)
  }

  test('AC3: a host that sends no hostNowMs gets exactly today’s response', async () => {
    const noBody = await rehydrate()
    expect(noBody.status).toBe(200)
    // No `clock` key at all: an old host must not see a new field it never asked
    // for, and the route must not report a skew it never measured.
    expectTodaysShape(await noBody.json())
    expectTodaysShape(await (await rehydrate({})).json())
  })

  test('AC3: a garbage hostNowMs is ignored, not coerced into a clock change', async () => {
    for (const value of [null, 'now', 0, -1, {}, []]) {
      const res = await rehydrate({ hostNowMs: value })
      expect(res.status).toBe(200)
      expectTodaysShape(await res.json())
    }
  })

  test('the host’s clock reaches the guest and is measured, not assumed', async () => {
    // Inside the 2 s tolerance: the guest leaves its own clock alone, but the
    // measured skew proves the body was read and the result is reported.
    const hostNowMs = Date.now() - 1500
    const res = await rehydrate({ hostNowMs })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.clock).toBeDefined()
    expect(body.clock.corrected).toBe(false)
    expect(body.clock.skewMs).toBeGreaterThanOrEqual(1000)
    expect(body.clock.skewMs).toBeLessThanOrEqual(2500)
    expect(body.clock.error).toBeUndefined()
  })

  test('a clock it cannot set is reported, never silently skipped', async () => {
    // A skew this size would really move the machine's clock on a privileged
    // runner, which a test must never do — so on one, prove the reporting
    // contract with a skew the route leaves alone instead. Both branches send
    // a `hostNowMs`, so both prove the body reaches the clock step.
    const blocked = clockSetBlockedReason()
    if (!blocked) {
      const res = await rehydrate({ hostNowMs: Date.now() - 1000 })
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.clock.corrected).toBe(false)
      expect(body.clock.error).toBeUndefined()
      expect(Math.abs(body.clock.skewMs)).toBeLessThanOrEqual(2500)
      return
    }
    const res = await rehydrate({ hostNowMs: Date.now() - 4 * 3600_000 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.clock.corrected).toBe(false)
    expect(body.clock.skewMs).toBeGreaterThan(3 * 3600_000)
    // The reason travels back to the host and into the guest log, so a staging
    // guest that cannot set its clock says so instead of serving wrong time.
    expect(body.clock.error).toMatch(/cannot set the clock/)
  })

  test('the sidecars are still rehydrated whatever the clock does', async () => {
    const res = await rehydrate({ hostNowMs: Date.now() })
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.projects)).toBe(true)
  })
})
