// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-181 AC5 — stopping the API on purpose.
 *
 * Windows used to run `taskkill /PID … /T /F` with no warning: the API and every
 * runtime under it died mid-write, and the supervisor logged the forced kill as
 * `code=1` — the "the API crashed" line in the issue. These cases pin the new
 * order of operations: ask first, wait, and only kill when the wait runs out —
 * and that a deliberate stop is logged as one.
 */
import { describe, expect, it } from 'bun:test'
import { formatIntentionalStopLog, stopApiProcess } from '../api-stop'

function harness(options: { platform: string; accepts?: boolean; exits?: boolean }) {
  const calls: string[] = []
  let waitedFor = 0
  const result = stopApiProcess({
    platform: options.platform,
    reason: 'update',
    requestGracefulStop: async () => {
      calls.push('request')
      return options.accepts ?? true
    },
    signalTerm: () => {
      calls.push('term')
    },
    forceKill: () => {
      calls.push('kill')
    },
    waitForExit: async (timeoutMs) => {
      calls.push('wait')
      waitedFor = timeoutMs
      return options.exits ?? true
    },
    timeoutMs: 4_000,
    log: () => {},
  })
  return { calls, waitedFor: () => waitedFor, result }
}

describe('stopApiProcess', () => {
  it('on win32 asks the API to stop before killing anything', async () => {
    const h = harness({ platform: 'win32', accepts: true, exits: true })
    expect(await h.result).toEqual({ graceful: true, forced: false })
    expect(h.calls).toEqual(['request', 'wait'])
    expect(h.waitedFor()).toBe(4_000)
  })

  it('on win32 falls back to the forced kill only after the wait runs out', async () => {
    const h = harness({ platform: 'win32', accepts: true, exits: false })
    expect(await h.result).toEqual({ graceful: false, forced: true })
    expect(h.calls).toEqual(['request', 'wait', 'kill'])
  })

  it('on win32 still waits when the request was refused (the tree is the fallback)', async () => {
    const h = harness({ platform: 'win32', accepts: false, exits: false })
    expect(await h.result).toEqual({ graceful: false, forced: true })
    expect(h.calls).toEqual(['request', 'wait', 'kill'])
  })

  it('on posix signals the process group, then escalates', async () => {
    const graceful = harness({ platform: 'darwin', exits: true })
    expect(await graceful.result).toEqual({ graceful: true, forced: false })
    expect(graceful.calls).toEqual(['term', 'wait'])

    const stubborn = harness({ platform: 'linux', exits: false })
    expect(await stubborn.result).toEqual({ graceful: false, forced: true })
    expect(stubborn.calls).toEqual(['term', 'wait', 'kill'])
  })

  it('a deliberate stop is logged as one, never as `exited: code=1`', () => {
    const line = formatIntentionalStopLog('update', 0, null)
    expect(line).toBe('[Desktop] API server stopped on request (reason=update, code=0, signal=null)')
    expect(line).not.toContain('exited: code=')
    expect(formatIntentionalStopLog('quit', 1, null)).toContain('on request')
  })
})
