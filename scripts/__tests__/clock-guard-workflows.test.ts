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
})
