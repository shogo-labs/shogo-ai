// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction (P1): the agent chased a single unreachable goal with many
 * DIFFERENT tool calls (different commands, different error messages), so the
 * identical-call / identical-output / cycle heuristics never fired. It thrashed
 * indefinitely with no progress.
 *
 * These tests pin the fixed behavior: a run of consecutive failing/unproductive
 * calls toward one goal is flagged as a `no_progress` loop, while varied work
 * that actually makes progress is not.
 */
import { describe, test, expect } from 'bun:test'
import { LoopDetector } from '../loop-detector'

describe('LoopDetector — no-progress / same-goal heuristic', () => {
  test('varied tool calls that ALL fail on one goal are flagged as a loop', () => {
    const d = new LoopDetector()

    // Six genuinely different attempts at the same unreachable endpoint. Every
    // command differs and every error differs, so identical-call / identical-
    // output / cycle detection cannot fire — only a no-progress heuristic can.
    const attempts = [
      { command: 'curl http://metrics.internal:9000/api/signups', stderr: 'Could not resolve host: metrics.internal' },
      { command: 'curl -v http://metrics.internal:9000/api/signups', stderr: 'Connection timed out after 3000 ms' },
      { command: 'curl http://metrics.internal:9001/api/signups', stderr: 'Failed to connect to metrics.internal port 9001' },
      { command: 'ping -c1 metrics.internal', stderr: 'ping: cannot resolve metrics.internal: Unknown host' },
      { command: 'node fetch-signups.js', stderr: 'FetchError: request to http://metrics.internal:9000 failed, reason: ENOTFOUND' },
      { command: 'curl https://metrics.internal/api/signups', stderr: 'SSL certificate problem: unable to get issuer certificate' },
    ]

    let last
    for (const a of attempts) {
      last = d.recordAndCheck('exec', { command: a.command }, { exitCode: 1, stdout: '', stderr: a.stderr })
    }

    expect(last?.loopDetected).toBe(true)
    expect(last?.reason).toBe('no_progress')
  })

  test('varied calls that make progress (interleaved successes) are NOT flagged', () => {
    const d = new LoopDetector()

    // edit → test(fail) → edit → test(pass) → edit → test(pass): outputs vary
    // and successes reset any no-progress streak. This must stay GREEN.
    const steps: Array<{ name: string; input: Record<string, any>; output: any }> = [
      { name: 'edit_file', input: { path: 'a.ts', patch: 'v1' }, output: { ok: true } },
      { name: 'exec', input: { command: 'bun test a' }, output: { exitCode: 1, stderr: '1 failing' } },
      { name: 'edit_file', input: { path: 'a.ts', patch: 'v2' }, output: { ok: true } },
      { name: 'exec', input: { command: 'bun test a' }, output: { exitCode: 0, stdout: '1 pass' } },
      { name: 'edit_file', input: { path: 'b.ts', patch: 'v1' }, output: { ok: true } },
      { name: 'exec', input: { command: 'bun test b' }, output: { exitCode: 0, stdout: '1 pass' } },
    ]

    let last
    for (const s of steps) last = d.recordAndCheck(s.name, s.input, s.output)

    expect(last?.loopDetected).toBe(false)
  })

  test('regression guard: the existing identical-call detector still fires', () => {
    const d = new LoopDetector()
    let last
    for (let i = 0; i < 4; i++) {
      last = d.recordAndCheck('exec', { command: 'curl http://x' }, { exitCode: 1, stderr: 'refused' })
    }
    expect(last?.loopDetected).toBe(true)
    // The 4 identical calls trip identical_calls before no_progress is evaluated.
    expect(last?.reason).toBe('identical_calls')
  })
})
