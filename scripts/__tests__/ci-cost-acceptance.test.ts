// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-104 acceptance: the CI cost/throughput contract as it ships in the
 * workflow files themselves.
 *
 * Every other guard on this card tests a helper (the classifier, `decide()`).
 * Nothing tested the YAML those helpers are wired into, so a future edit could
 * re-add the E2E matrix to `merge_group`, grow a job back out of the prelude, or
 * drop a `retention-days` and silently restore ~$100 / 2 days and 558 GB with
 * every unit test still green.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const WORKFLOWS = join(import.meta.dir, '../../.github/workflows')
const read = (file: string) => readFileSync(join(WORKFLOWS, file), 'utf-8')
/** YAML with full-line comments dropped, so prose cannot trip a structural check. */
const code = (file: string) =>
  read(file)
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
const ALL = readdirSync(WORKFLOWS)
  .filter((f) => f.endsWith('.yml'))
  .sort()

/** Source of one top-level job, from `  <name>:` up to the next job. */
function job(yaml: string, name: string): string {
  const lines = yaml.split('\n')
  const start = lines.indexOf(`  ${name}:`)
  if (start === -1) throw new Error(`no job '${name}'`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^ {2}[A-Za-z0-9_-]+:/.test(l))
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n')
}

/** `retention-days` of the upload-artifact step that publishes `artifact`. */
function retentionDays(yaml: string, artifact: string): number | null {
  const lines = yaml.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('uses: actions/upload-artifact')) continue
    for (let j = i + 1; j < Math.min(i + 14, lines.length); j++) {
      if (/^\s*-\s(name|uses):/.test(lines[j]) || lines[j].includes('uses: actions/')) break
      const name = lines[j].trim()
      const matches = artifact.endsWith('*') ? name.startsWith(`name: ${artifact.slice(0, -1)}`) : name === `name: ${artifact}`
      if (!matches) continue
      for (let k = j + 1; k < Math.min(j + 8, lines.length); k++) {
        const m = lines[k].match(/^\s*retention-days:\s*(\d+)\s*$/)
        if (m) return Number(m[1])
        if (lines[k].includes('uses: actions/')) break
      }
      return null
    }
  }
  return null
}

describe('SHO-104 · the E2E matrix cannot come back on merge_queue or push', () => {
  const ci = read('ci.yml')

  it('runs only on a pull request that touches app code', () => {
    const e2e = job(ci, 'e2e-local')
    expect(e2e).toContain("if: github.event_name == 'pull_request' && needs.prelude.outputs.app == 'true'")
    expect(e2e).toContain('needs: prelude')
  })

  it('stays out of the required aggregator, whose name and needs are what branch protection expects', () => {
    const agg = job(ci, 'ci')
    expect(agg).toContain('name: Lint, Typecheck, Test')
    const needs = agg
      .match(/needs: \[(.*?)\]/)![1]
      .split(',')
      .map((s) => s.trim())
    expect(needs).toEqual([
      'prelude',
      'typecheck',
      'typecheck-mobile',
      'test',
      'rbac-postgres',
      'test-windows',
      'workflow-lint',
      'metal-agent-bundle',
    ])
    expect(needs).not.toContain('e2e-local')
  })

  it('decides app-code from the merged prelude, and nothing still reads the two retired jobs', () => {
    const prelude = job(ci, 'prelude')
    expect(prelude).toContain('verified: ${{ steps.check.outputs.verified }}')
    expect(prelude).toContain('windows: ${{ steps.filter.outputs.relevant }}')
    expect(prelude).toContain('app: ${{ steps.app.outputs.app }}')
    expect(prelude).toContain('fetch-depth: 0')

    for (const file of ALL) {
      expect({ file, stale: /queue-verified|windows-changes/.test(code(file)) }).toEqual({ file, stale: false })
    }
  })

  it('treats ci.yml itself as app code, so a CI edit still proves the suite runs', () => {
    // The deny-list lives in the script the prelude runs; `.github/*` is only a
    // blanket skip after ci.yml is matched.
    const classifier = readFileSync(join(import.meta.dir, '../ci/app-code-changed.sh'), 'utf-8')
    const ciCase = classifier.indexOf('.github/workflows/ci.yml) app=true')
    expect(ciCase).toBeGreaterThan(-1)
    expect(ciCase).toBeLessThan(classifier.indexOf('.github/*) continue'))
  })
})

describe('SHO-104 · perf smoke: Windows on PRs, macOS after the merge', () => {
  const perf = read('desktop-perf-smoke.yml')

  /** Evaluate the workflow's own `os:` expression for one event name. */
  const matrixFor = (event: string): string[] => {
    const expression = perf.match(/^ {8}os: \$\{\{ (fromJSON\(.*\)) \}\}$/m)![1]
    const inner = expression.slice('fromJSON('.length, -1)
    return JSON.parse(new Function('github', `return (${inner})`)({ event_name: event }) as string)
  }

  it('runs the Windows leg on a PR and the macOS leg on a main push', () => {
    expect(matrixFor('pull_request')).toEqual(['windows-latest'])
    expect(matrixFor('push')).toEqual(['macos-latest'])
    expect(matrixFor('workflow_dispatch')).toEqual(['windows-latest', 'macos-latest'])
  })

  it('covers the same paths on push as on PR', () => {
    const paths = (trigger: string) => {
      const block = perf.match(new RegExp(`^ {2}${trigger}:\\n((?: {4}.*\\n| {6}.*\\n)+)`, 'm'))![1]
      return [...block.matchAll(/^ {6}- "(.+)"$/gm)].map((m) => m[1])
    }
    expect(paths('push').length).toBeGreaterThan(0)
    expect(paths('push')).toEqual(paths('pull_request'))
  })

  it('never cancels a main run', () => {
    expect(perf).toContain('group: perf-smoke-${{ github.head_ref || github.ref }}')
    expect(perf).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}")
    expect(perf).toContain('branches: [main]')
  })
})

describe('SHO-104 · the deploy gate runs the tested script with the API scope it needs', () => {
  const gate = job(read('deploy.yml'), 'ci-gate')

  it('invokes scripts/ci/wait-for-ci.ts against this commit', () => {
    expect(gate).toContain('run: bun scripts/ci/wait-for-ci.ts')
    expect(gate).toContain('sparse-checkout: scripts/ci')
    expect(gate).toContain('SHA: ${{ github.sha }}')
    expect(gate).toContain('REPOSITORY: ${{ github.repository }}')
    // Without actions:read the gate 403s on the runs/jobs endpoints.
    expect(gate).toContain('actions: read')
  })

  it('outlives the gate, so the gate reports its own timeout instead of the job being killed', () => {
    const jobMinutes = Number(gate.match(/timeout-minutes: (\d+)/)![1])
    expect(jobMinutes * 60_000).toBeGreaterThan(30 * 60 * 1000)
  })
})

describe('SHO-104 · artifacts an app release re-reads expire in 7 days', () => {
  const listed: [string, string][] = [
    ['desktop-release-macos.yml', 'web-dist-macos'],
    ['desktop-release-macos.yml', 'desktop-darwin-${{ matrix.arch }}'],
    ['desktop-release-windows.yml', 'web-dist-windows'],
    ['desktop-release-windows.yml', 'desktop-win32-x64'],
    ['android.yml', 'app-release.aab'],
    ['publish-agent-runtime.yml', 'shogo-agent-runtime-${{ steps.version.outputs.version }}'],
    ['e2e-hosted.yml', 'playwright-report-*'],
  ]

  for (const [file, artifact] of listed) {
    it(`${artifact} (${file}) is retention-days <= 7`, () => {
      const days = retentionDays(read(file), artifact)
      expect(days).not.toBeNull()
      expect(days!).toBeLessThanOrEqual(7)
    })
  }

  it('no workflow downloads one of them from another run', () => {
    for (const file of ALL) {
      const yaml = read(file)
      for (const match of yaml.matchAll(/uses: actions\/download-artifact[\s\S]{0,400}?(?=\n\s*- name:|\n {2}[a-z0-9-]+:)/g)) {
        expect({ file, crossRun: /run-id:.*github-token:|github-token:.*run-id:/.test(match[0]) }).toEqual({
          file,
          crossRun: false,
        })
      }
    }
  })
})
