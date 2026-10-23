// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  type CapacityProbe,
  type FailedSpec,
  classifyE2eRun,
  collectFailedSpecs,
  degradedRetryNote,
  isEnvironmentFailure,
} from '../lib/e2e-classification'
import { readProbe, readReport } from '../e2e-classify'

const healthy: CapacityProbe = { diskOk: true, warmPoolOk: true, studioRevisionOk: true, healthOk: true }

const assertion: FailedSpec = {
  file: 'staging/chat.test.ts',
  title: 'creates a project',
  message: 'expect(received).toBe(expected)\n\nExpected: "Live"\nReceived: "Draft"',
}

const timeout: FailedSpec = {
  file: 'staging/agent-chat.test.ts',
  title: 'agent answers',
  message: 'TimeoutError: waitForAgentResponse: timed out after 120000ms',
}

describe('isEnvironmentFailure', () => {
  it('treats timeouts, connection aborts and 5xx as the environment', () => {
    expect(isEnvironmentFailure(timeout.message)).toBe(true)
    expect(isEnvironmentFailure('net::ERR_CONNECTION_RESET at https://studio.staging.shogo.ai')).toBe(true)
    expect(isEnvironmentFailure('api responded 502 Bad Gateway')).toBe(true)
    expect(isEnvironmentFailure('Test timeout of 120000ms exceeded.')).toBe(true)
  })

  it('treats a broken browser image on the runner as the environment', () => {
    expect(isEnvironmentFailure("browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1140/chrome-linux/chrome")).toBe(true)
    expect(isEnvironmentFailure('Host system is missing dependencies to run browsers.')).toBe(true)
  })

  it('does not mistake an assertion for the environment', () => {
    expect(isEnvironmentFailure(assertion.message)).toBe(false)
    expect(isEnvironmentFailure('')).toBe(false)
  })

  it('does not read a duration as an HTTP status', () => {
    expect(isEnvironmentFailure('element stayed hidden for 500ms')).toBe(false)
    expect(isEnvironmentFailure('waited 5030ms for the selector')).toBe(false)
  })
})

describe('classifyE2eRun', () => {
  it('is clean when nothing failed', () => {
    expect(classifyE2eRun({ failures: [], before: healthy, after: healthy })).toEqual({
      kind: 'clean',
      annotation: '',
      reasons: [],
      productSpecs: [],
    })
  })

  it('blames the environment when the preflight caught a disk breach', () => {
    const result = classifyE2eRun({
      failures: [assertion],
      before: { ...healthy, diskOk: false, diskReason: 'node 10.0.24.140 at 74% nodefs' },
      after: healthy,
    })
    expect(result.kind).toBe('environment')
    expect(result.annotation).toBe('environment: started on a degraded cluster: node 10.0.24.140 at 74% nodefs')
  })

  // The guard has teeth: the same failure set flips to `product:` the moment the
  // disk assertion is dropped from the probe. Without this, a saturated node
  // hides behind "a spec asserted the wrong value".
  it('flips to product when only the disk assertion is removed', () => {
    const withDiskBreach = classifyE2eRun({
      failures: [assertion],
      before: { ...healthy, diskOk: false, diskReason: 'node a at 74% nodefs' },
      after: healthy,
    })
    const withoutDiskAssertion = classifyE2eRun({ failures: [assertion], before: healthy, after: healthy })
    expect(withDiskBreach.kind).toBe('environment')
    expect(withoutDiskAssertion.kind).toBe('product')
  })

  it('blames the environment when the run degraded the cluster', () => {
    const result = classifyE2eRun({
      failures: [assertion],
      before: healthy,
      after: { ...healthy, warmPoolOk: false, warmPoolReason: '3 warm-pool ksvcs but 0 Ready' },
    })
    expect(result.kind).toBe('environment')
    expect(result.annotation).toBe('environment: cluster degraded during the run: 3 warm-pool ksvcs but 0 Ready')
  })

  it('records both probe breaches when the cluster was bad throughout', () => {
    const result = classifyE2eRun({
      failures: [timeout],
      before: { ...healthy, healthOk: false, healthReason: 'api /api/health returned 503' },
      after: { ...healthy, diskOk: false, diskReason: 'node b at 88% nodefs' },
    })
    expect(result.kind).toBe('environment')
    expect(result.reasons).toHaveLength(2)
    expect(result.reasons[0]).toContain('started on a degraded cluster')
    expect(result.reasons[1]).toContain('cluster degraded during the run')
  })

  it('blames the environment for all-timeout failures on a verified-healthy cluster', () => {
    const result = classifyE2eRun({ failures: [timeout, { ...timeout, title: 'second' }], before: healthy, after: healthy })
    expect(result.kind).toBe('environment')
    expect(result.annotation).toBe('environment: 2 timeout failures with a healthy cluster')
  })

  it('blames the product when any failure is an assertion', () => {
    const result = classifyE2eRun({ failures: [timeout, assertion], before: healthy, after: healthy })
    expect(result.kind).toBe('product')
    expect(result.annotation).toBe('product: 2 specs')
    expect(result.productSpecs).toEqual([
      'staging/agent-chat.test.ts › agent answers',
      'staging/chat.test.ts › creates a project',
    ])
  })

  it('treats a missing probe as unknown, not healthy', () => {
    // No probes at all + a timeout: we cannot prove the cluster was fine, but
    // the message shape is still environment-shaped, so it reports environment.
    expect(classifyE2eRun({ failures: [timeout] }).kind).toBe('environment')
    expect(classifyE2eRun({ failures: [assertion] }).kind).toBe('product')
  })

  // QA round 1 on SHO-136: a red run with no parseable report was `clean`, so a
  // job killed at its timeout said the cluster was fine. That is the exact
  // "lie about why it failed" this card exists to end.
  it('is unknown — never clean — when a red run reported nothing', () => {
    const result = classifyE2eRun({ failures: [], outcome: 'failure', before: healthy, after: healthy })
    expect(result.kind).toBe('unknown')
    expect(result.annotation).toBe('unknown: failure with no parseable report')
    expect(classifyE2eRun({ failures: [], outcome: 'cancelled' }).kind).toBe('unknown')
  })

  it('still reports a green run as clean', () => {
    expect(classifyE2eRun({ failures: [], outcome: 'success', before: healthy, after: healthy }).kind).toBe('clean')
  })

  it('prefers a measured capacity breach over "no parseable report"', () => {
    // Red, nothing parseable, and the post-run probe caught the real cause: the
    // measurement is more useful than "unknown", and both file a platform issue.
    const result = classifyE2eRun({
      failures: [],
      outcome: 'failure',
      before: healthy,
      after: { ...healthy, diskOk: false, diskReason: 'node b at 88% nodefs' },
    })
    expect(result.kind).toBe('environment')
    expect(result.annotation).toContain('node b at 88% nodefs')
  })
})

describe('degradedRetryNote', () => {
  it('never reports a green retry as clean', () => {
    expect(degradedRetryNote('environment')).toBe('degraded: first attempt was environment')
    expect(degradedRetryNote(undefined)).toBe('degraded: first attempt was unknown')
    expect(degradedRetryNote('')).toBe('degraded: first attempt was unknown')
    expect(degradedRetryNote('clean')).toBe('degraded: first attempt was unknown')
  })
})

describe('collectFailedSpecs', () => {
  const report = {
    suites: [
      {
        title: '',
        specs: [{ title: 'passes', ok: true, tests: [{ status: 'expected' }] }],
        suites: [
          {
            title: 'chat',
            file: 'staging/chat.test.ts',
            specs: [
              {
                title: 'creates a project',
                ok: false,
                tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: 'boom' } }] }],
              },
              { title: 'fails without a message', ok: false, tests: [{ status: 'unexpected', results: [] }] },
            ],
          },
        ],
      },
    ],
  }

  it('flattens nested suites down to the failures only', () => {
    expect(collectFailedSpecs(report)).toEqual([
      { file: 'staging/chat.test.ts', title: 'creates a project', message: 'boom' },
      { file: 'staging/chat.test.ts', title: 'fails without a message', message: 'failed without an error message' },
    ])
  })

  it('tolerates an empty or missing report', () => {
    expect(collectFailedSpecs(undefined)).toEqual([])
    expect(collectFailedSpecs({})).toEqual([])
  })

  // The other half of the round-1 hole: Playwright puts a browser that never
  // launched, or a globalSetup throw, in the report's top-level `errors`, not in
  // a spec. Dropping that array made such a run look clean.
  it('keeps a report-level error as a failure', () => {
    const launch = "browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1140/chrome-linux/chrome"
    const failures = collectFailedSpecs({
      suites: [],
      errors: [{ message: launch, location: { file: 'e2e/staging/fixtures.ts' } }],
    })
    expect(failures).toEqual([{ file: 'e2e/staging/fixtures.ts', title: 'top-level error', message: launch }])
    // The message is what makes it classify: a runner with no browser is the
    // platform, and the run is red.
    expect(classifyE2eRun({ failures, outcome: 'failure', before: healthy, after: healthy }).kind).toBe('environment')
  })

  it('labels an error with no location instead of throwing', () => {
    expect(collectFailedSpecs({ errors: [{}] })).toEqual([
      { file: '(report)', title: 'top-level error', message: 'report-level error without a message' },
    ])
  })
})

describe('probe + report IO', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sho136-'))

  it('reads a probe file the workflow wrote', () => {
    const path = join(dir, 'probe.json')
    writeFileSync(path, JSON.stringify({ diskOk: false, diskReason: 'node a at 74% nodefs' }))
    expect(readProbe(path)).toMatchObject({ diskOk: false, diskReason: 'node a at 74% nodefs', healthOk: true })
  })

  it('treats a missing or unreadable probe as unknown', () => {
    expect(readProbe(join(dir, 'nope.json'))).toBeUndefined()
    expect(readProbe(undefined)).toBeUndefined()
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{not json')
    expect(readProbe(broken)).toBeUndefined()
  })

  it('reads a report file and tolerates a missing one', () => {
    const path = join(dir, 'report.json')
    writeFileSync(path, JSON.stringify({ suites: [] }))
    expect(readReport(path)).toEqual([])
    expect(readReport(join(dir, 'missing.json'))).toEqual([])
  })
})
