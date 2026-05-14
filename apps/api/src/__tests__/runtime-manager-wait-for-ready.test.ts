// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for `RuntimeManager.waitForReady()`.
 *
 * Before this fix, a Vite child that died mid-startup (port conflict
 * with a previous already-released-but-still-listening process, missing
 * native binding, missing dependency, ...) caused `waitForReady()` to
 * spin for the full 30s timeout and surface as
 *
 *     error: Timeout waiting for runtime <id> to start on port <p>
 *         at waitForReady (.../runtime/manager.ts:1254:15)
 *
 * with no indication of *why*. Worse, the 30s blackout blocked every
 * concurrent `start()` call via `startingPromises`, so chat requests
 * arriving during that window cascaded into a swarm of
 * `[ProjectChat] turn snapshot proxy error` log lines, eventually
 * SIGTERMing the (still-running) agent process. This test pins the
 * fix: `waitForReady()` short-circuits the wait as soon as the spawned
 * Vite child reports a non-null `exitCode`, throwing an error that
 * names the exit code instead of the misleading timeout.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { RuntimeManager } from '../lib/runtime/manager'

type FakeProc = { exitCode: number | null; signalCode?: NodeJS.Signals | null; killed?: boolean }

function callWaitForReady(
  rm: RuntimeManager,
  port: number,
  timeoutMs: number,
  proc?: FakeProc,
): Promise<void> {
  // `waitForReady` is private; reach in deliberately so callers don't
  // have to spin a real Vite child. This is the same pattern other
  // private-method regression tests in apps/api/src/__tests__ use.
  return (rm as unknown as {
    waitForReady: (projectId: string, port: number, timeoutMs: number, process?: FakeProc) => Promise<void>
  }).waitForReady('proj-test', port, timeoutMs, proc)
}

const ORIGINAL_FETCH = globalThis.fetch

describe('RuntimeManager.waitForReady (private)', () => {
  let rm: RuntimeManager

  beforeEach(() => {
    rm = new RuntimeManager()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  test('returns immediately when the server responds (any status)', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch
    await callWaitForReady(rm, 41234, 5000)
  })

  test('returns when the server is slow but eventually responds', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls < 3) throw new Error('ECONNREFUSED')
      return new Response('', { status: 500 })
    }) as typeof fetch
    await callWaitForReady(rm, 41234, 5000)
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test('throws a descriptive error when the Vite child dies mid-wait', async () => {
    // Server is unreachable for the whole call; the wait should NOT spin
    // for the full timeout — it should bail the next iteration after
    // exitCode flips off `null`.
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const proc: FakeProc = { exitCode: null }
    const startedAt = Date.now()
    // Flip exitCode after a beat so the loop sees a healthy process for
    // its first iteration and a dead one for its second.
    setTimeout(() => {
      proc.exitCode = 127
      proc.signalCode = null
    }, 600)
    await expect(callWaitForReady(rm, 41234, 30_000, proc)).rejects.toThrow(
      /Vite process for runtime proj-test exited \(code=127\) before becoming ready on port 41234/,
    )
    const elapsed = Date.now() - startedAt
    // The legacy bug would block for the full 30s. We give a generous
    // ceiling here (5s) to avoid CI flakes while still catching a
    // regression that goes back to the original behaviour.
    expect(elapsed).toBeLessThan(5_000)
  })

  test('detects SIGKILL-style deaths where exitCode stays null', async () => {
    // Reproduces the production scenario from the dev log: a second
    // RuntimeManager constructor ran cleanupStaleProcesses(), found the
    // first manager's Vite PID via lsof, and SIGKILLed it. Node sets
    // `signalCode='SIGKILL'` and leaves `exitCode=null`, which the
    // legacy `exitCode !== null` check missed entirely, causing the
    // wait to fall through to the generic 30s timeout.
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const proc: FakeProc = { exitCode: null }
    setTimeout(() => {
      proc.signalCode = 'SIGKILL'
    }, 600)
    const startedAt = Date.now()
    await expect(callWaitForReady(rm, 41234, 30_000, proc)).rejects.toThrow(
      /Vite process for runtime proj-test exited \(code=null, signal=SIGKILL\) before becoming ready on port 41234/,
    )
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(5_000)
  })

  test('detects deaths where `killed=true` flips without exitCode/signalCode', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const proc: FakeProc = { exitCode: null }
    setTimeout(() => {
      proc.killed = true
    }, 600)
    await expect(callWaitForReady(rm, 41234, 30_000, proc)).rejects.toThrow(
      /Vite process for runtime proj-test exited \(code=null\) before becoming ready on port 41234/,
    )
  })

  test('includes signalCode in the error when present alongside exitCode', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const proc: FakeProc = { exitCode: null }
    setTimeout(() => {
      proc.exitCode = 143
      proc.signalCode = 'SIGTERM'
    }, 600)
    await expect(callWaitForReady(rm, 41234, 30_000, proc)).rejects.toThrow(
      /signal=SIGTERM/,
    )
  })

  test('falls back to the generic timeout error when no process is supplied', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    await expect(callWaitForReady(rm, 41234, 1_200)).rejects.toThrow(
      /Timeout waiting for runtime proj-test to start on port 41234/,
    )
  })

  test('catches a death that occurs during the final sleep tick', async () => {
    // Drives the post-loop "one last check" path: fetch fails forever,
    // the timeout fires, but the child died milliseconds before so the
    // error should still report the exit code instead of the generic
    // timeout text.
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const proc: FakeProc = { exitCode: null }
    setTimeout(() => {
      proc.exitCode = 1
    }, 1_000)
    await expect(callWaitForReady(rm, 41234, 1_200, proc)).rejects.toThrow(
      /Vite process for runtime proj-test exited \(code=1\)/,
    )
  })
})
