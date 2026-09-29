// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import {
  REGISTRATION_GRACE_MS,
  STATUS_CONTEXT,
  decide,
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
      mainDeployRuns: [run({ status: 'completed', conclusion: 'failure' })],
      elapsedMs: later,
    })
    expect(d.kind).toBe('fail')
    expect(d.message).toContain('without publishing')
  })
})
