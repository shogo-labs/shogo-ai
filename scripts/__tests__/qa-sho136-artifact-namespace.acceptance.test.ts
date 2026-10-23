// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// QA acceptance test for SHO-136 round 3: the retry must reach Playwright.
//
// `e2e-artifact-namespace.test.ts` pins the *name templates* — it renders
// `${{ env.ARTIFACT_SUFFIX }}` from its own formula, so it stays green if the
// workflow's `ARTIFACT_SUFFIX` is changed to something that never reads
// `inputs.attempt` (e.g. hardcoded `first-…`). That is exactly the defect: both
// calls would share one namespace again, the retry's preflight upload would
// fail on a duplicate name, and `playwright: needs: [preflight]` would be
// skipped — the retry never running, silently.
//
// This test therefore resolves the suffix from the workflow file itself, and
// takes the attempt values from the `attempt:` lines deploy-staging.yml
// actually passes, so the two files are checked against each other rather than
// against a copy of their intent. It also fails if any artifact name stops
// carrying the suffix.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const HOSTED_PATH = '.github/workflows/e2e-hosted.yml'
const DEPLOY_PATH = '.github/workflows/deploy-staging.yml'
const hosted = readFileSync(join(REPO_ROOT, HOSTED_PATH), 'utf8')
const deploy = readFileSync(join(REPO_ROOT, DEPLOY_PATH), 'utf8')

/** Lines of one `jobs:` entry in deploy-staging.yml, up to the next job. */
function deployJob(job: string): string[] {
  const lines = deploy.split('\n')
  const start = lines.findIndex((l) => l === `  ${job}:`)
  if (start < 0) throw new Error(`job \`${job}\` not found in ${DEPLOY_PATH}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end)
}

/** The `attempt:` value that deploy-staging.yml passes to a call job. */
function passedAttempt(job: string): string {
  const hit = deployJob(job)
    .map((l) => l.match(/^ {6}attempt:\s*(\S+)\s*$/)?.[1])
    .find(Boolean)
  if (!hit) throw new Error(`job \`${job}\` passes no \`attempt:\``)
  return hit
}

/** The `ARTIFACT_SUFFIX:` expression as written in the reusable workflow. */
const SUFFIX_EXPR = (() => {
  const hit = hosted.match(/^ {2}ARTIFACT_SUFFIX:\s*(.+?)\s*$/m)
  if (!hit) throw new Error(`no \`ARTIFACT_SUFFIX:\` in ${HOSTED_PATH}`)
  return hit[1]
})()

/** Evaluate the `${{ a || b }}` subset these workflows use, from the file text. */
function evaluate(expr: string, vars: Record<string, string>): string {
  for (const part of expr.split('||')) {
    const token = part.trim()
    if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1)
    const value = vars[token]
    if (value) return value
  }
  throw new Error(`expression resolved empty from the workflow: \${{${expr}}}`)
}

const BASE_VARS: Record<string, string> = {
  'github.run_attempt': '1',
  'github.run_id': '424242',
  'github.sha': 'deadbeef',
  'inputs.target': 'staging',
  'inputs.suite': 'critical',
}

/** Render a `${{ … }}` template from the file, for one attempt of one run. */
function renderTemplate(template: string, attempt: string, runAttempt = '1'): string {
  return template.replace(/\$\{\{(.+?)\}\}/g, (_, expr: string) => {
    // `env.ARTIFACT_SUFFIX` is itself an expression in the file, so it is
    // resolved from that text rather than from a copy of its formula.
    if (expr.split('||').map((p) => p.trim()).includes('env.ARTIFACT_SUFFIX')) {
      return suffixFor(attempt, runAttempt)
    }
    return evaluate(expr, { ...BASE_VARS, 'github.run_attempt': runAttempt, 'inputs.attempt': attempt })
  })
}

/** The suffix a given call gets, resolved from the file (never assumed). */
function suffixFor(attempt: string, runAttempt = '1'): string {
  return renderTemplate(SUFFIX_EXPR, attempt, runAttempt)
}

/** Every artifact `name:` in e2e-hosted.yml, expressions intact. */
const ARTIFACT_NAMES: { kind: string; name: string }[] = (() => {
  const lines = hosted.split('\n')
  const found: { kind: string; name: string }[] = []
  lines.forEach((line, i) => {
    const call = line.match(/uses:\s*actions\/(upload|download)-artifact@/)
    if (!call) return
    const indent = line.length - line.trimStart().length
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && lines[j].length - lines[j].trimStart().length < indent) break
      const named = lines[j].match(/^\s+name:\s*(.+?)\s*$/)
      if (named) {
        found.push({ kind: call[1], name: named[1].replace(/^['"]|['"]$/g, '') })
        return
      }
    }
  })
  return found
})()

/** Render one artifact name the way the run would, for one attempt. */
function renderName(name: string, attempt: string, runAttempt = '1'): string {
  return renderTemplate(name, attempt, runAttempt)
}

describe('SHO-136 round 3 — the retry gets its own artifact namespace', () => {
  it('parses the artifact steps and the suffix it is about to assert on', () => {
    expect(ARTIFACT_NAMES.filter((a) => a.kind === 'upload').length).toBeGreaterThanOrEqual(5)
    expect(ARTIFACT_NAMES.filter((a) => a.kind === 'download').length).toBeGreaterThanOrEqual(3)
    expect(SUFFIX_EXPR).toContain('inputs.attempt')
  })

  it('derives the suffix from `inputs.attempt`, so the retry can never inherit the first attempt’s names', () => {
    // Hardcoding the suffix (`first-${{ github.run_attempt }}`) leaves every
    // name template untouched and is invisible to a name-only assertion, but
    // it gives both calls one namespace — the retry's preflight then dies on a
    // duplicate artifact name and Playwright is skipped.
    expect(suffixFor('first')).not.toBe(suffixFor('retry'))
    expect(suffixFor('first')).toContain('first')
    expect(suffixFor('retry')).toContain('retry')
  })

  it('gives every artifact name the suffix — no fixed name can go stale', () => {
    for (const artifact of ARTIFACT_NAMES) {
      expect(artifact.name).toContain('env.ARTIFACT_SUFFIX')
    }
  })

  it('never lets the two deploy calls collide, using the values deploy-staging.yml passes', () => {
    const firstAttempt = passedAttempt('e2e-critical')
    const retryAttempt = passedAttempt('e2e-critical-retry')
    expect(firstAttempt).not.toBe(retryAttempt)

    const first = ARTIFACT_NAMES.map((a) => renderName(a.name, firstAttempt))
    const retry = ARTIFACT_NAMES.map((a) => renderName(a.name, retryAttempt))
    expect(first.filter((n) => retry.includes(n))).toEqual([])

    // Within one attempt the uploads must still be unique among themselves —
    // a download legitimately shares its name with the upload it fetches.
    const uploadsOf = (attempt: string) =>
      ARTIFACT_NAMES.filter((a) => a.kind === 'upload').map((a) => renderName(a.name, attempt))
    for (const attempt of [firstAttempt, retryAttempt]) {
      const names = uploadsOf(attempt)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('keeps a re-run of deploy-staging out of the previous attempt’s namespace', () => {
    const names = (attempt: string, runAttempt: string) =>
      ARTIFACT_NAMES.map((a) => renderName(a.name, attempt, runAttempt))
    expect(names('first', '1').filter((n) => names('first', '2').includes(n))).toEqual([])
    expect(names('retry', '1').filter((n) => names('retry', '2').includes(n))).toEqual([])
  })

  it('invokes the same reusable workflow from both calls, so the retry is the same suite', () => {
    for (const job of ['e2e-critical', 'e2e-critical-retry']) {
      expect(deployJob(job).join('\n')).toContain('uses: ./.github/workflows/e2e-hosted.yml')
    }
  })
})
