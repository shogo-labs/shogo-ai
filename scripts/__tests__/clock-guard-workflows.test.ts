// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { parse } from 'yaml'
import { TEST_PACKAGES } from '../run-all-tests'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

function workflow(name: string): any {
  return parse(readFileSync(resolve(REPO_ROOT, '.github/workflows', name), 'utf-8')) as any
}

/** Every `--packages` list a workflow's matrix legs declare. */
function packageLists(job: any): string[][] {
  const matrix = job.strategy?.matrix
  const legs = [...(matrix?.include ?? []), ...(Array.isArray(matrix?.leg) ? matrix.leg : [])]
  return legs
    .map((leg: { packages?: string }) => (typeof leg.packages === 'string' ? leg.packages.split(',').map((p) => p.trim()) : null))
    .filter((list: string[] | null): list is string[] => list !== null)
}

describe('clock-guard workflows', () => {
  test('future-clock runs +7, +30 and +90 over the api/mobile and agent-runtime suites', () => {
    const clock = workflow('future-clock.yml')
    const job = clock.jobs.clock
    expect(job.strategy.matrix.offset_days).toEqual([7, 30, 90])

    const lists = packageLists(job)
    expect(lists).toContainEqual(['apps/api', 'apps/mobile'])
    expect(lists).toContainEqual(['packages/agent-runtime'])
    // A nightly is useless if it can't report; it must be allowed to open its issue.
    expect(job.permissions.issues).toBe('write')
  })

  test('every package a clock job names is a real test package', () => {
    // `run-all-tests.ts` exits 2 on an unknown `--packages` value, so a typo here
    // does not fail loudly at authoring time — it turns the job permanently red.
    const known = new Set<string>(TEST_PACKAGES)
    for (const file of ['future-clock.yml', 'main-health.yml']) {
      const doc = workflow(file)
      for (const [name, job] of Object.entries<any>(doc.jobs)) {
        for (const list of packageLists(job)) {
          for (const pkg of list) expect({ file, job: name, pkg, known: known.has(pkg) }).toMatchObject({ known: true })
        }
      }
    }
  })

  test('main-health runs hourly on main, has three unit legs, and owns one main-red issue', () => {
    const health = workflow('main-health.yml')
    const crons = health.on.schedule.map((entry: { cron: string }) => entry.cron)
    expect(crons).toEqual(['20 * * * *'])

    const job = health.jobs.test
    expect(job.strategy.matrix.include.map((leg: { name: string }) => leg.name)).toEqual([
      'api + mobile',
      'agent-runtime',
      'remaining',
    ])
    // No e2e and no rbac-postgres: this job exists to notice a suite that went red
    // with no commit, not to re-run the slow gates ci.yml already owns.
    expect(JSON.stringify(job)).not.toContain('--include-e2e')
    expect(JSON.stringify(job)).not.toContain('rbac-postgres')

    // force_fail is how the alert path is proven before Russell turns the schedule on.
    expect(health.on.workflow_dispatch.inputs.force_fail.type).toBe('boolean')

    const report = health.jobs.report
    expect(report.permissions.issues).toBe('write')
    expect(JSON.stringify(report)).toContain('main-red')
    // One issue, not one per leg: the report job owns every write.
    expect(job.permissions?.issues).toBeUndefined()
  })

  test('the main-red report reads per-job logs, not a whole-run log', () => {
    // `gh run view --log-failed` refuses while the run is in progress, and the report
    // step is part of that run — so it always returned "run is still in progress" and
    // the issue said "no test-level names found" (SHO-507 QA round 1, #2168).
    const health = workflow('main-health.yml')
    const report = health.jobs.report
    const script = report.steps.map((step: any) => step.run ?? '').join('\n')

    expect(script).not.toContain('--log-failed')
    expect(script).toContain('/actions/runs/${GITHUB_RUN_ID}/jobs')
    expect(script).toContain('/actions/jobs/')
    // Still parsed by the shared helper, so the issue keeps the same shape.
    expect(script).toContain('scripts/ci/failing-tests.sh')
  })

  test('the main-red report may read this run, and says so when it cannot', () => {
    // Reading the job list and the per-job logs mid-run is an Actions API read.
    // Without `actions: read` the call 403s, the `for` loop runs zero times under
    // `set -e`, and the issue falls back to "no test-level lines found" — a silent
    // failure that reads exactly like a real empty result (SHO-507 QA round 2).
    const health = workflow('main-health.yml')
    const report = health.jobs.report
    expect(report.permissions.actions).toBe('read')

    const script = report.steps.map((step: any) => step.run ?? '').join('\n')
    // The unreadable path must reach the issue body, not be swallowed by `|| true`.
    expect(script).toContain('could not read')
    expect(script).toContain('log_errors')
    // The test leg needs no extra scope: it only runs the suites.
    expect(health.jobs.test.permissions?.actions).toBeUndefined()
  })

  test('the report fetches job logs without the gh escape-sequence guard', () => {
    // A recent `gh` refuses to write a log containing terminal escape sequences to
    // a pipe ("pass --allow-escape-sequences to output it anyway"). Every runner log
    // has them, so `gh api .../jobs/<id>/logs` exited non-zero with an empty body and
    // the issue said only "could not read the log of job N" (SHO-507 QA round 3).
    // The report asks the API for the redirect and fetches the blob with curl.
    const health = workflow('main-health.yml')
    const script = health.jobs.report.steps.map((step: any) => step.run ?? '').join('\n')

    // Exactly one `gh api`: the job list. The log bodies never go through `gh`.
    expect(script.match(/\$\(gh api /g)?.length).toBe(1)
    expect(script).toContain('redirect_url')
    expect(script).toContain('curl -fsS')
    // The token goes to the API call only; the pre-signed blob needs no auth.
    expect(script).toContain('Authorization: Bearer ${GH_TOKEN}')
  })

  test('the clock probe loads the preload on the preload path', () => {
    // Without this, a +30d leg printed today's date and the log line contradicted
    // the guard above it (SHO-507 QA round 1, nit 3).
    const clock = workflow('future-clock.yml')
    const confirm = clock.jobs.clock.steps.find((step: any) => step.name === 'Confirm the clock the suite will see')
    expect(confirm).toBeDefined()
    expect(confirm.run).toContain('--preload ./scripts/test-clock-offset-preload.ts')
    expect(confirm.run).toContain('clock_mode')
  })
})
