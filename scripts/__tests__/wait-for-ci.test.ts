// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import { HARD_FAILURES, REQUIRED_JOB, decide, type RunState } from '../ci/wait-for-ci'

const run = (overrides: Partial<RunState> = {}): RunState => ({
  id: 1,
  status: 'in_progress',
  conclusion: null,
  required: null,
  ...overrides,
})

describe('deploy CI gate decide()', () => {
  it('gates on the required aggregator, not the run conclusion', () => {
    expect(REQUIRED_JOB).toBe('Lint, Typecheck, Test')
    // Local E2E is not in the aggregator's needs, so a cancelled superseded
    // run can be red while the required job is green.
    const d = decide({ queue: null, push: run({ status: 'completed', conclusion: 'cancelled', required: 'success' }) })
    expect(d.kind).toBe('pass')
  })

  it('passes on a still-running merge-queue run as soon as its required job is green', () => {
    // This is the regression: GitHub starts the deploy's CI Gate at the same
    // time as CI, so a commit can land on main while its merge_group run is
    // still finishing. It used to be looked at once, at t=0, with
    // status=completed — so a green run arriving a minute later was never seen.
    const d = decide({ queue: run({ id: 7, status: 'in_progress', required: 'success' }), push: run({ status: 'queued' }) })
    expect(d.kind).toBe('pass')
    expect(d.message).toContain('merge-queue CI run 7')
  })

  it('waits while the merge-queue run is still working and no push run has reported', () => {
    const d = decide({ queue: run({ id: 7, status: 'in_progress', required: null }), push: null })
    expect(d.kind).toBe('wait')
    expect(d.message).toContain('merge-queue run 7')
    expect(d.message).toContain('not reported yet')
  })

  it('waits when nothing has registered for the SHA yet', () => {
    const d = decide({ queue: null, push: null })
    expect(d.kind).toBe('wait')
    expect(d.message).toContain('no CI run for this commit yet')
  })

  it('fails fast when the merge-queue run reported a hard failure', () => {
    for (const required of HARD_FAILURES) {
      const d = decide({ queue: run({ id: 7, status: 'completed', conclusion: 'failure', required }), push: null })
      expect(d.kind).toBe('fail')
      expect(d.message).toContain(`merge-queue CI run 7`)
    }
  })

  it('does not fail on a cancelled merge-queue run; it waits for the push run', () => {
    const d = decide({
      queue: run({ id: 7, status: 'completed', conclusion: 'cancelled', required: 'cancelled' }),
      push: run({ id: 9, status: 'in_progress' }),
    })
    expect(d.kind).toBe('wait')
    expect(d.message).toContain('CI run 9')
  })

  it('fails when the push run finished without the required job passing', () => {
    const d = decide({ queue: null, push: run({ id: 9, status: 'completed', conclusion: 'failure', required: 'failure' }) })
    expect(d.kind).toBe('fail')
    expect(d.message).toContain('conclusion=failure')

    const missing = decide({ queue: null, push: run({ id: 9, status: 'completed', conclusion: 'cancelled', required: null }) })
    expect(missing.kind).toBe('fail')
    expect(missing.message).toContain('required job: missing')
  })

  it('passes a green run even when the aggregate job itself was skipped', () => {
    // A queue-verified push skips every test job; the aggregator still runs
    // (`if: always()`) and reports success, so the run conclusion is success.
    const d = decide({ queue: null, push: run({ id: 9, status: 'completed', conclusion: 'success', required: 'skipped' }) })
    expect(d.kind).toBe('pass')
  })

  it('prefers a green source over a red one', () => {
    const d = decide({
      queue: run({ id: 7, status: 'completed', conclusion: 'failure', required: 'failure' }),
      push: run({ id: 9, status: 'completed', conclusion: 'success', required: 'success' }),
    })
    expect(d.kind).toBe('pass')
    expect(d.message).toContain('CI run 9')
  })
})
