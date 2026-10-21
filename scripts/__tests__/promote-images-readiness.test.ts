// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guard for the SHO-127 class: an ordering a comment asserts but nothing
 * enforces. `promote-images` read `staging-<sha>` while the staging rollout
 * that writes it was still running, and v2.3.7 failed 1.5 s before the tags
 * existed. The fix is a real gate (`scripts/ci/wait-for-staging-images.ts`)
 * ahead of the re-tag loop; this test fails if the workflow loses it, moves it
 * after the loop, or shrinks the job's timeout below the gate's own wait.
 *
 * No YAML dependency: deploy.yml is read as text, like
 * `deploy-secret-parity.test.ts` and `api-image-contract.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { DEFAULT_TIMEOUT_MS } from '../ci/wait-for-staging-images'

const root = resolve(import.meta.dir, '../..')
const WORKFLOW = '.github/workflows/deploy.yml'
const GATE_SCRIPT = 'scripts/ci/wait-for-staging-images.ts'
const RETAG_STEP = /name:\s*Re-tag staging-/

/** The `  <job>:` block of a workflow, up to the next key at job indentation. */
export function jobBlock(content: string, job: string): string[] | null {
  const lines = content.split('\n')
  const jobsStart = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsStart < 0) return null
  const start = lines.findIndex((l, i) => i > jobsStart && new RegExp(`^  ${job}:\\s*$`).test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) || /^  \S/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end)
}

export function readinessProblems(block: string[] | null): string[] {
  if (block === null) return [`${WORKFLOW} has no \`promote-images\` job`]
  const text = block.join('\n')
  const problems: string[] = []

  const gate = block.findIndex((l) => l.includes(GATE_SCRIPT))
  const retag = block.findIndex((l) => RETAG_STEP.test(l))
  if (gate < 0) {
    problems.push(`promote-images does not run ${GATE_SCRIPT} — it reads staging-<sha> without waiting for the staging rollout that writes it`)
  } else if (retag >= 0 && gate > retag) {
    problems.push(`${GATE_SCRIPT} runs after the re-tag loop, so the tag set is still read before it exists`)
  }

  if (!/^\s+permissions:\s*$/m.test(text) || !/^\s+actions:\s*read\s*$/m.test(text)) {
    problems.push('promote-images does not grant `permissions: actions: read` (the gate queries the staging runs API)')
  }

  if (!/sparse-checkout:\s*scripts\/ci/.test(text)) {
    problems.push('promote-images does not check out `scripts/ci`, so the gate script is not on disk')
  }

  const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(text)?.[1] ?? NaN)
  if (!Number.isFinite(timeout)) {
    problems.push('promote-images has no timeout-minutes')
  } else if (timeout * 60_000 < DEFAULT_TIMEOUT_MS) {
    problems.push(
      `promote-images timeout-minutes: ${timeout} is shorter than the gate's own ${DEFAULT_TIMEOUT_MS / 60_000} min wait, so the job would be killed before the gate can report`,
    )
  }

  if (/deploy this commit to staging first/i.test(text)) {
    problems.push('promote-images still tells the reader to deploy to staging first — that is not what breaks')
  }

  return problems
}

describe('promote-images waits for the staging tag set', () => {
  const block = jobBlock(readFileSync(join(root, WORKFLOW), 'utf8'), 'promote-images')

  it('finds the job', () => {
    expect(block).not.toBeNull()
  })

  it('has no readiness problems (gate before the re-tag loop, permissions, timeout)', () => {
    expect(readinessProblems(block)).toEqual([])
  })

  it('gates before it lists the missing images', () => {
    const text = (block ?? []).join('\n')
    expect(text.indexOf(GATE_SCRIPT)).toBeLessThan(text.indexOf('MISSING=""'))
  })
})

// Fixtures: prove the guard catches the shape it exists for, and that a
// silent no-match cannot pass as ready.
const workflow = (body: string) =>
  ['name: ci', 'on:', '  push:', 'jobs:', '  promote-images:', '    runs-on: ubuntu-latest', '    steps:', body].join('\n')

const GOOD_STEPS = [
  '      - uses: actions/checkout@v6',
  '        with:',
  '          sparse-checkout: scripts/ci',
  '      - name: Wait for the staging tag set',
  `        run: bun ${GATE_SCRIPT}`,
  '      - name: Re-tag staging-${{ github.sha }} as production-${{ github.sha }}',
  '        run: |',
  '          MISSING=""',
].join('\n')

const withHeader = (body: string) => workflow(['    timeout-minutes: 75', '    permissions:', '      actions: read', body].join('\n'))

describe('promote-images readiness (fixtures)', () => {
  const problemsFor = (text: string) => readinessProblems(jobBlock(text, 'promote-images'))

  it('accepts a job that gates before the re-tag loop', () => {
    expect(problemsFor(withHeader(GOOD_STEPS))).toEqual([])
  })

  it('rejects the pre-fix shape: no gate at all', () => {
    const body = GOOD_STEPS.replace(/ {6}- name: Wait for the staging tag set\n.*\n/, '')
    expect(problemsFor(withHeader(body))).toContainEqual(expect.stringContaining('does not run'))
  })

  it('rejects a gate placed after the re-tag loop', () => {
    const steps = GOOD_STEPS.split('\n')
    const text = withHeader([...steps.slice(5), ...steps.slice(0, 5)].join('\n'))
    expect(problemsFor(text)).toContainEqual(expect.stringContaining('runs after the re-tag loop'))
  })

  it('rejects a timeout shorter than the gate wait', () => {
    expect(problemsFor(withHeader(GOOD_STEPS).replace('timeout-minutes: 75', 'timeout-minutes: 10'))).toContainEqual(
      expect.stringContaining('shorter than the gate'),
    )
  })

  it('rejects a job without actions: read', () => {
    expect(problemsFor(withHeader(GOOD_STEPS).replace('      actions: read\n', ''))).toContainEqual(
      expect.stringContaining('actions: read'),
    )
  })

  it('rejects the stale remediation text', () => {
    const text = withHeader(`${GOOD_STEPS}\n          echo "Deploy this commit to staging first"`)
    expect(problemsFor(text)).toContainEqual(expect.stringContaining('deploy to staging first'))
  })

  it('refuses to treat a missing job as ready', () => {
    expect(readinessProblems(jobBlock('name: ci\non: push\njobs:\n  other:\n    steps: []\n', 'promote-images'))).toEqual([
      `${WORKFLOW} has no \`promote-images\` job`,
    ])
  })
})
