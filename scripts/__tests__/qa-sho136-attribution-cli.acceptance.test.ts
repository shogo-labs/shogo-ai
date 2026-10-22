// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Acceptance tests for the SHO-136 attribution contract as the workflow uses it.
//
// The unit tests in `e2e-classification.test.ts` cover the pure helpers; these
// drive `scripts/e2e-classify.ts` exactly the way `.github/workflows/e2e-hosted.yml`
// does — as a process, with a `$GITHUB_OUTPUT` file — because the QA round 1
// defect was in that wiring: `--outcome` was accepted and then never reached the
// classification, so a job killed at its timeout filed no report, produced no
// failures, and reported itself `clean`. A guard that says the cluster was fine
// when it never looked is worse than no guard, so the contract is pinned here:
//
//   * a red run with nothing parseable is `unknown` and `platform=true`;
//   * a broken runner image (Playwright's top-level `errors`) is never `product`;
//   * a measured capacity breach outranks "we could not read the report";
//   * a green run is still `clean` and `platform=false`;
//   * a green retry after a red first attempt stays `degraded`.
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const CLI = join(REPO_ROOT, 'scripts', 'e2e-classify.ts')

interface CliRun {
  classification: string
  annotation: string
  degraded: string
  platform: string
  stdout: string
}

function fixture(name: string, contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sho136-cli-'))
  const path = join(dir, name)
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
  return path
}

const HEALTHY = { diskOk: true, warmPoolOk: true, studioRevisionOk: true, healthOk: true }

function classify(args: string[]): CliRun {
  const dir = mkdtempSync(join(tmpdir(), 'sho136-out-'))
  const outputPath = join(dir, 'github_output')
  writeFileSync(outputPath, '')
  const proc = Bun.spawnSync({
    cmd: ['bun', CLI, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = proc.stdout.toString()
  expect(proc.exitCode).toBe(0)
  const parsed: Record<string, string> = {}
  for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) parsed[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return {
    classification: parsed.classification ?? '',
    annotation: parsed.annotation ?? '',
    degraded: parsed.degraded ?? '',
    platform: parsed.platform ?? '',
    stdout,
  }
}

describe('SHO-136 attribution CLI', () => {
  it('a red run with no parseable report is unknown, and files a platform issue', () => {
    const healthy = fixture('healthy.json', HEALTHY)
    const run = classify([
      '--report', join(tmpdir(), 'does-not-exist', 'e2e-report.json'),
      '--before', healthy,
      '--outcome', 'failure',
    ])
    expect(run.classification).toBe('unknown')
    expect(run.annotation).toBe('unknown: failure with no parseable report')
    expect(run.platform).toBe('true')
  })

  it('a job killed at its timeout (cancelled) is unknown, never clean', () => {
    const healthy = fixture('healthy.json', HEALTHY)
    const run = classify([
      '--report', join(tmpdir(), 'does-not-exist', 'e2e-report.json'),
      '--before', healthy,
      '--outcome', 'cancelled',
    ])
    expect(run.classification).toBe('unknown')
    expect(run.platform).toBe('true')
  })

  it('an unparseable report is unknown rather than clean', () => {
    const healthy = fixture('healthy.json', HEALTHY)
    const broken = fixture('e2e-report.json', '{"suites": [')
    const run = classify(['--report', broken, '--before', healthy, '--outcome', 'failure'])
    expect(run.classification).toBe('unknown')
    expect(run.platform).toBe('true')
  })

  it('a broken runner image is environment-shaped, never a product red', () => {
    const healthy = fixture('healthy.json', HEALTHY)
    const report = fixture('e2e-report.json', {
      errors: [
        {
          message:
            "browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1148/chrome-linux/chrome",
        },
      ],
      suites: [],
    })
    const run = classify(['--report', report, '--before', healthy, '--outcome', 'failure'])
    expect(run.classification).toBe('environment')
    expect(run.platform).toBe('true')
  })

  it('a measured capacity breach outranks "no parseable report"', () => {
    const breach = fixture('breach.json', {
      ...HEALTHY,
      diskOk: false,
      diskReason: 'node 10.0.24.140 at 74% nodefs (threshold 70%)',
    })
    const run = classify([
      '--report', join(tmpdir(), 'does-not-exist', 'e2e-report.json'),
      '--before', breach,
      '--outcome', 'failure',
    ])
    expect(run.classification).toBe('environment')
    expect(run.annotation).toContain('74% nodefs')
    expect(run.platform).toBe('true')
  })

  it('a green run is clean and needs no platform issue', () => {
    const healthy = fixture('healthy.json', HEALTHY)
    const report = fixture('e2e-report.json', {
      suites: [{ file: 'staging/chat.test.ts', specs: [{ title: 'answers', ok: true, tests: [{ status: 'passed' }] }] }],
    })
    const run = classify(['--report', report, '--before', healthy, '--after', healthy, '--outcome', 'success'])
    expect(run.classification).toBe('clean')
    expect(run.platform).toBe('false')
    expect(run.annotation).toBe('')
  })

  it('an assertion failure is the product, and carries the spec title', () => {
    const healthy = fixture('healthy.json', HEALTHY)
    const report = fixture('e2e-report.json', {
      suites: [
        {
          file: 'staging/publish.test.ts',
          specs: [
            {
              title: 'portal shows the project title',
              ok: false,
              tests: [
                { status: 'failed', results: [{ status: 'failed', error: { message: 'expect(received).toBe(expected)\nExpected: "Acme"\nReceived: ""' } }] },
              ],
            },
          ],
        },
      ],
    })
    const run = classify(['--report', report, '--before', healthy, '--outcome', 'failure'])
    expect(run.classification).toBe('product')
    expect(run.platform).toBe('false')
    expect(run.stdout).toContain('staging/publish.test.ts › portal shows the project title')
  })

  it('a green retry after a red first attempt is reported degraded, not clean', () => {
    const healthy = fixture('healthy.json', HEALTHY)
    const report = fixture('e2e-report.json', { suites: [] })
    const run = classify([
      '--report', report,
      '--before', healthy,
      '--outcome', 'success',
      '--previous', 'environment',
    ])
    expect(run.classification).toBe('clean')
    expect(run.degraded).toBe('degraded: first attempt was environment')
  })

  it('a retry whose first attempt published nothing is still degraded (unknown)', () => {
    const healthy = fixture('healthy.json', HEALTHY)
    const report = fixture('e2e-report.json', { suites: [] })
    const run = classify([
      '--report', report,
      '--before', healthy,
      '--outcome', 'success',
      '--previous', 'unknown',
    ])
    expect(run.degraded).toBe('degraded: first attempt was unknown')
  })
})
