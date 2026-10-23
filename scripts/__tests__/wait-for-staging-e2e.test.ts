// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import {
  REGISTRATION_GRACE_MS,
  STATUS_CONTEXT,
  decide,
  recoveryLine,
  runIdFromUrl,
  type WorkflowRun,
} from '../ci/wait-for-staging-e2e'

const later = REGISTRATION_GRACE_MS + 1
const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1,
  head_branch: 'main',
  event: 'push',
  status: 'in_progress',
  conclusion: null,
  ...overrides,
})
const status = (state: string) => ({ context: STATUS_CONTEXT, state })

describe('staging e2e gate decide()', () => {
  it('passes only on a green e2e/staging-critical status', () => {
    expect(decide({ statuses: [status('success')], mainDeployRuns: [], elapsedMs: 0 }).kind).toBe('pass')
    expect(
      decide({ statuses: [{ context: 'ci', state: 'success' }], mainDeployRuns: [], elapsedMs: later }).kind,
    ).toBe('fail')
  })

  it('fails on a red status even while other runs are active', () => {
    for (const s of ['failure', 'error']) {
      expect(decide({ statuses: [status(s)], mainDeployRuns: [run()], elapsedMs: 0 }).kind).toBe('fail')
    }
  })

  it('waits while pending or while the staging deploy for this SHA is running', () => {
    expect(decide({ statuses: [status('pending')], mainDeployRuns: [], elapsedMs: later }).kind).toBe('wait')
    expect(decide({ statuses: [], mainDeployRuns: [run({ status: 'queued' })], elapsedMs: later }).kind).toBe('wait')
  })

  it('gives a concurrently pushed main run time to register, then fails fast', () => {
    expect(decide({ statuses: [], mainDeployRuns: [], elapsedMs: 0 }).kind).toBe('wait')
    const d = decide({ statuses: [], mainDeployRuns: [], elapsedMs: later })
    expect(d.kind).toBe('fail')
    expect(d.message).toContain('no main-branch staging deploy')
  })

  it('fails when the staging deploy finished without publishing the status', () => {
    const d = decide({
      statuses: [],
      mainDeployRuns: [run({ status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/42' })],
      elapsedMs: later,
    })
    expect(d.kind).toBe('fail')
    expect(d.message).toContain('without publishing')
    expect(d.message).toContain('gh run rerun 1 --failed')
    expect(d.message).toContain("then re-run this release's tag run")
  })

  it('fails immediately on a finished staging run instead of spending the registration grace', () => {
    const d = decide({
      statuses: [],
      mainDeployRuns: [run({ status: 'completed', conclusion: 'failure' })],
      elapsedMs: 0,
    })
    expect(d.kind).toBe('fail')
    expect(d.message).toContain('without publishing')
  })

  it('names the staging run id and the recovery in the pending-but-dead branch', () => {
    const d = decide({
      statuses: [{ context: STATUS_CONTEXT, state: 'pending', target_url: 'https://github.com/o/r/actions/runs/777' }],
      mainDeployRuns: [run({ id: 777, status: 'completed', conclusion: 'cancelled' })],
      statusRun: run({ id: 777, status: 'completed', conclusion: 'cancelled' }),
      elapsedMs: later,
    })
    expect(d.kind).toBe('fail')
    expect(d.message).toContain('still pending')
    expect(d.message).toContain('777')
    expect(d.message).toContain('gh run rerun 777 --failed')
  })

  it('keeps waiting on a pending status whose run is still going or unreadable', () => {
    const pendingStatus = { context: STATUS_CONTEXT, state: 'pending', target_url: 'https://github.com/o/r/actions/runs/9' }
    expect(
      decide({
        statuses: [pendingStatus],
        mainDeployRuns: [],
        statusRun: run({ id: 9, status: 'in_progress' }),
        elapsedMs: later,
      }).kind,
    ).toBe('wait')
    expect(decide({ statuses: [pendingStatus], mainDeployRuns: [], statusRun: null, elapsedMs: later }).kind).toBe(
      'wait',
    )
  })

  it('reads the run id out of a status target_url and builds the same recovery line', () => {
    expect(runIdFromUrl('https://github.com/shogo-labs/shogo-ai/actions/runs/39573508746')).toBe(39573508746)
    expect(runIdFromUrl('https://github.com/shogo-labs/shogo-ai/actions/runs/39573508746/job/119135044418')).toBe(
      39573508746,
    )
    expect(runIdFromUrl(undefined)).toBeNull()
    expect(runIdFromUrl('https://example.test/no-run')).toBeNull()
    expect(recoveryLine(42)).toBe("Recovery: run `gh run rerun 42 --failed` to re-run the staging run, then re-run this release's tag run.")
  })
})
