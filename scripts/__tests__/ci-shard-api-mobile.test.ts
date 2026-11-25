// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `Test (api + mobile)` used to be ONE unsharded ci.yml leg that took 9m30s–14m47s
 * on green runs against a 15m cap, so two merge-group runs were cancelled at the
 * cap and the queue dropped those PRs as if their code had failed (SHO-579). It
 * now runs as `api + mobile 1/2` and `api + mobile 2/2`.
 *
 * Two things have to hold for that to keep working, and neither is visible in a
 * green CI run:
 *
 *   1. The two shards must cover every test file of both packages exactly once —
 *      `--shard` is per package, so a file dropped from both halves would simply
 *      stop running.
 *   2. They must stay balanced. An unbalanced pair puts one leg back over the
 *      15m cap while the other idles, which is the bug this card fixed.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { findTestFiles, selectShard } from '../run-tests-isolated'

const ROOT = resolve(import.meta.dir, '../..')
const PACKAGES = ['apps/api', 'apps/mobile'] as const

/** The directories `run-tests-isolated.ts` scans for a package, as its `test` script passes them. */
function testRoots(pkg: string): string[] {
  const pj = JSON.parse(readFileSync(join(ROOT, pkg, 'package.json'), 'utf8'))
  const script: string = pj.scripts?.test ?? ''
  const flag = script.match(/--roots[= ](\S+)/)
  const dirs = flag
    ? flag[1].split(',')
    : // The runner's own default probe for a package that passes no `--roots`.
      ['src', 'tests', 'test', '__tests__']
  return dirs.map((dir) => join(ROOT, pkg, dir)).filter((dir) => existsSync(dir))
}

const bytes = (files: string[]): number => files.reduce((total, file) => total + statSync(file).size, 0)

function workflow(file: string): any {
  return parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')) as any
}

describe('the ci.yml test matrix shards api + mobile', () => {
  const job = workflow('ci.yml').jobs.test
  const legs: any[] = job.strategy.matrix.include
  const apiMobile = legs.filter((leg) => leg.packages === PACKAGES.join(','))

  test('api + mobile runs as two sharded legs, the way agent-runtime does', () => {
    expect(apiMobile.map((leg) => leg.name)).toEqual(['api + mobile 1/2', 'api + mobile 2/2'])
    expect(apiMobile.map((leg) => leg.shard)).toEqual(['1/2', '2/2'])
  })

  test('every leg either declares a shard or owns the e2e pass', () => {
    // An unsharded, non-e2e leg is the shape that timed out: it runs a whole
    // package pair in one 15-minute job.
    for (const leg of legs) {
      expect({ leg: leg.name, covered: leg.shard !== '' || leg.include_e2e === true }).toMatchObject({
        covered: true,
      })
    }
  })

  test('no step is left behind for a leg nobody declares', () => {
    const steps = job.steps.map((step: any) => step.name)
    expect(steps).not.toContain('Test unsharded packages')
    // The job's own budget: the matrix comment's rule is >= 4 min of headroom.
    expect(job['timeout-minutes']).toBe(15)
  })
})

describe('api + mobile 1/2 and 2/2 cover every test file exactly once', () => {
  for (const pkg of PACKAGES) {
    test(`${pkg}: the two halves are disjoint and together are the unsharded list`, () => {
      const all = testRoots(pkg).flatMap(findTestFiles)
      expect(all.length).toBeGreaterThan(0)

      const first = selectShard(all, { index: 1, total: 2 })
      const second = selectShard(all, { index: 2, total: 2 })

      expect(first.filter((file) => second.includes(file))).toEqual([])
      expect([...first, ...second].sort()).toEqual([...all].sort())
    })

    test(`${pkg}: each half is within 10% of its share of the suite, so neither leg eats the headroom`, () => {
      const all = testRoots(pkg).flatMap(findTestFiles)
      const share = bytes(all) / 2

      for (const index of [1, 2]) {
        const half = selectShard(all, { index, total: 2 })
        expect({ pkg, index, balanced: bytes(half) <= share * 1.1 }).toMatchObject({ balanced: true })
        expect(half.length).toBeGreaterThan(0)
      }
    })
  }
})
