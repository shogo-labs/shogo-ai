// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for SHO-127: a production release can lose a race with
 * its own staging rollout.
 *
 * `promote-images` reads `staging-<sha>`, but that tag set is written by the
 * staging *rollout*, minutes after the commit's builds — the repos a rollout
 * carries forward only get their tag then. On v2.3.7 (run 39567961829) a tag
 * push landed mid-rollout, promote found `shogo-docs`/`shogo-runtime` missing,
 * failed, and the tags appeared 1.5 s later.
 *
 * The fix is `scripts/ci/wait-for-staging-images.ts`: wait while this commit's
 * staging rollout is still running, fail only when it finished incomplete.
 * `decide()` is pure — the registry probe and the runs API are not exercised
 * here, so these assertions are the incident itself, not a network call.
 */

import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_TIMEOUT_MS,
  REGISTRATION_GRACE_MS,
  REPOS,
  decide,
  imageRef,
  type WorkflowRun,
} from '../ci/wait-for-staging-images'

const SHA = '9ed183395fcca9b6f1bbfe542f59d80229279de2'
const INCIDENT_MISSING = ['shogo-docs', 'shogo-runtime']

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 39567209766,
  head_branch: 'main',
  event: 'push',
  status: 'in_progress',
  conclusion: null,
  html_url: 'https://github.com/shogo-labs/shogo-ai/actions/runs/39567209766',
  ...over,
})

describe('decide()', () => {
  it('passes once every promoted repo has staging-<sha>', () => {
    const d = decide({ missing: [], stagingRuns: [], sha: SHA, elapsedMs: 0 })
    expect(d.kind).toBe('pass')
    expect(d.message).toContain(`staging-${SHA}`)
  })

  it('waits on the running rollout instead of failing — the v2.3.7 incident at 08:16:35', () => {
    const d = decide({ missing: INCIDENT_MISSING, stagingRuns: [run()], sha: SHA, elapsedMs: 40_000 })
    expect(d.kind).toBe('wait')
    // A hard fail here is what broke the release 1.5 s before the tags existed.
    expect(d.message).toContain('shogo-docs')
    expect(d.message).toContain('shogo-runtime')
    expect(d.message).toContain('39567209766')
  })

  it('waits for the rollout to register during the grace window', () => {
    const d = decide({ missing: INCIDENT_MISSING, stagingRuns: [], sha: SHA, elapsedMs: REGISTRATION_GRACE_MS - 1 })
    expect(d.kind).toBe('wait')
    expect(d.message).toContain('shogo-docs')
  })

  it('fails when the rollout finished without the tags, naming the repos and the run URL', () => {
    const finished = run({ status: 'completed', conclusion: 'success' })
    const d = decide({ missing: INCIDENT_MISSING, stagingRuns: [finished], sha: SHA, elapsedMs: 13 * 60_000 })
    expect(d.kind).toBe('fail')
    expect(d.message).toContain('shogo-docs')
    expect(d.message).toContain('shogo-runtime')
    expect(d.message).toContain('39567209766')
    expect(d.message).toContain(finished.html_url!)
    expect(d.message).toContain('force_rebuild_production=true')
  })

  it('fails when no staging rollout ever started for this commit and the grace window is gone', () => {
    const d = decide({ missing: INCIDENT_MISSING, stagingRuns: [], sha: SHA, elapsedMs: REGISTRATION_GRACE_MS })
    expect(d.kind).toBe('fail')
    expect(d.message).toContain('shogo-docs')
    expect(d.message).toContain('never rolled out to staging')
    expect(d.message).toContain('force_rebuild_production=true')
  })

  it('does not point at the old "deploy this commit to staging first" remediation', () => {
    for (const stagingRuns of [[run({ status: 'completed', conclusion: 'success' })], []]) {
      const d = decide({ missing: INCIDENT_MISSING, stagingRuns, sha: SHA, elapsedMs: 60 * 60_000 })
      expect(d.message).not.toContain('Deploy this commit to staging first')
    }
  })
})

describe('gate constants', () => {
  it('covers the four promoted repos', () => {
    expect([...REPOS]).toEqual(['shogo-api', 'shogo-web', 'shogo-docs', 'shogo-runtime'])
  })

  it('defaults to a 60 min wait so a long rollout is not cut short', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60 * 60 * 1000)
  })

  it('probes the registry path promote-images re-tags', () => {
    expect(imageRef('iad.ocir.io/ns', 'shogo-docs', SHA)).toBe(`iad.ocir.io/ns/shogo/shogo-docs:staging-${SHA}`)
  })
})
