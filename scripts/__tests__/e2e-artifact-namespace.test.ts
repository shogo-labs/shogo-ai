// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-136 pre-merge review: the retry could never run.
 *
 * `deploy-staging.yml` calls `e2e-hosted.yml` twice inside ONE workflow run —
 * `e2e-critical`, then `e2e-critical-retry`. Artifact names are scoped to the
 * run, not to the job, and `actions/upload-artifact@v4` *fails the step* (it
 * does not warn) when the name already exists. With fixed names the retry's
 * preflight upload died, and `playwright: needs: [preflight]` then skipped the
 * suite — so the safety-net retry never reached Playwright at all, and its
 * `classify` job could download the first attempt's artifacts and describe the
 * wrong run.
 *
 * The guard renders every artifact name for both calls at once and asserts the
 * namespaces are disjoint, that every `classify` download resolves to an
 * artifact its own attempt uploaded (never the other attempt's), that a re-run
 * cannot collide with the previous attempt either, and that the two deploy
 * calls actually pass `attempt` through. A new fixed-name artifact reds this
 * file.
 *
 * The workflows are read as text — no YAML dependency, same approach as
 * `deploy-secret-parity.test.ts` and `api-image-contract.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const HOSTED = '.github/workflows/e2e-hosted.yml'
const DEPLOY = '.github/workflows/deploy-staging.yml'

export type ArtifactStep = {
  /** Job key the step lives under, e.g. `preflight`. */
  job: string
  kind: 'upload' | 'download'
  /** Step label from the `- name:` line, for readable failures. */
  step: string
  /** Raw `name:` value, `${{ … }}` expressions intact. */
  name: string
  /** 1-based line of the `uses:` call. */
  line: number
}

/** Indentation width of a line, or Infinity for a blank one. */
function indentOf(line: string): number {
  if (line.trim() === '') return Infinity
  return line.length - line.trimStart().length
}

/** The lines of one `jobs:` entry, up to the next job at the same indent. */
export function jobBlock(content: string, job: string): string[] {
  const lines = content.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^  ${job}:\\s*$`).test(l))
  if (start < 0) throw new Error(`job \`${job}\` not found`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end)
}

/** Every `actions/upload-artifact` / `download-artifact` step, with its name. */
export function parseArtifactSteps(content: string): ArtifactStep[] {
  const lines = content.split('\n')
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  const steps: ArtifactStep[] = []
  let job = '<unknown job>'

  lines.forEach((line, i) => {
    if (i > jobsAt && /^  [A-Za-z0-9_-]+:\s*$/.test(line)) job = line.trim().replace(/:$/, '')

    const call = line.match(/^(\s*)(?:- )?uses:\s*actions\/(upload|download)-artifact@/)
    if (!call) return
    const keyIndent = call[1].length + (line.includes('- uses:') ? 2 : 0)
    const kind = call[2] as ArtifactStep['kind']

    // The `with:` children are the only keys indented past `uses:`; the step's
    // own `- name:` label sits *before* the call, so a forward scan cannot
    // mistake it for the artifact name. A step written as `- uses:` keeps its
    // sibling keys at the same column as `uses:` itself, so only a dedent below
    // that column or the next `- ` list item ends the step.
    let name = ''
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && (indentOf(lines[j]) < keyIndent || /^\s*- /.test(lines[j]))) break
      const named = lines[j].match(/^\s+name:\s*(.+?)\s*$/)
      if (named) {
        name = named[1].replace(/^['"]|['"]$/g, '')
        break
      }
    }

    let step = ''
    for (let j = i - 1; j >= 0; j--) {
      if (/^\s*- /.test(lines[j])) {
        step = lines[j].match(/^\s*- name:\s*(.+?)\s*$/)?.[1] ?? ''
        break
      }
    }

    steps.push({ job, kind, step, name, line: i + 1 })
  })

  return steps
}

export type RenderContext = {
  /** `inputs.attempt` — `first` or `retry`. */
  attempt: string
  /** `github.run_attempt`. */
  runAttempt: string
  target?: string
  suite?: string
  runId?: string
  sha?: string
}

/**
 * Resolve the `${{ … }}` expressions an artifact name is allowed to use.
 * An expression this does not understand throws: a name must never resolve by
 * accident, and the caller has to decide what a new one means.
 */
export function renderName(name: string, ctx: RenderContext): string {
  return name.replace(/\$\{\{(.+?)\}\}/g, (_, expr: string) => {
    for (const part of expr.split('||')) {
      const token = part.trim()
      if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1)
      const resolved = resolveToken(token, ctx)
      if (resolved) return resolved
    }
    throw new Error(`artifact name expression resolved empty: \${{${expr}}}`)
  })
}

function resolveToken(token: string, ctx: RenderContext): string {
  const known: Record<string, string | undefined> = {
    'github.run_attempt': ctx.runAttempt,
    'github.run_id': ctx.runId ?? '424242',
    'github.sha': ctx.sha ?? 'deadbeef',
    'inputs.target': ctx.target ?? 'staging',
    'inputs.suite': ctx.suite ?? 'critical',
    'inputs.attempt': ctx.attempt,
    'env.ARTIFACT_SUFFIX': ctx.attempt ? `${ctx.attempt}-${ctx.runAttempt}` : undefined,
  }
  if (!(token in known)) throw new Error(`unhandled expression in artifact name: ${token}`)
  return known[token] ?? ''
}

const hostedSteps = parseArtifactSteps(read(HOSTED))
const uploads = hostedSteps.filter((s) => s.kind === 'upload')
const downloads = hostedSteps.filter((s) => s.kind === 'download')

const FIRST: RenderContext = { attempt: 'first', runAttempt: '1' }
const RETRY: RenderContext = { attempt: 'retry', runAttempt: '1' }

describe('e2e-hosted artifact namespaces', () => {
  it('parses every artifact step (so the assertions below are never vacuous)', () => {
    expect(uploads.length).toBeGreaterThanOrEqual(5)
    expect(downloads.length).toBeGreaterThanOrEqual(3)
    expect(uploads.every((s) => s.name !== '')).toBe(true)
    expect(downloads.every((s) => s.name !== '')).toBe(true)
  })

  it('gives the retry its own artifact names, so its preflight survives and Playwright is not skipped', () => {
    // `playwright` needs `preflight`: a duplicate-name upload failure in
    // preflight is exactly what kept the retry's suite from ever starting.
    expect(jobBlock(read(HOSTED), 'playwright').join('\n')).toMatch(/needs:\s*\[preflight\]/)

    const first = uploads.map((s) => renderName(s.name, FIRST))
    const retry = uploads.map((s) => renderName(s.name, RETRY))
    const collided = first.filter((n) => retry.includes(n))
    expect(collided).toEqual([])
    expect(new Set([...first, ...retry]).size).toBe(first.length + retry.length)
  })

  it('names nothing by a constant: every artifact carries the attempt suffix', () => {
    for (const step of uploads) {
      expect(renderName(step.name, FIRST)).not.toBe(renderName(step.name, RETRY))
    }
  })

  it('lets classify download its own attempt — never the other attempt’s artifacts', () => {
    for (const ctx of [FIRST, RETRY]) {
      const uploaded = new Set(uploads.map((s) => renderName(s.name, ctx)))
      for (const step of downloads) {
        // `continue-on-error: true` means a miss is silent: classify would read
        // the other attempt's probe/report and describe the wrong run.
        expect(uploaded.has(renderName(step.name, ctx))).toBe(true)
      }
    }
  })

  it('keeps a re-run of the whole workflow out of the previous attempt’s namespace', () => {
    const attempt1 = uploads.map((s) => renderName(s.name, { ...FIRST, runAttempt: '1' }))
    const attempt2 = uploads.map((s) => renderName(s.name, { ...FIRST, runAttempt: '2' }))
    expect(attempt1.filter((n) => attempt2.includes(n))).toEqual([])

    const retry1 = uploads.map((s) => renderName(s.name, { ...RETRY, runAttempt: '1' }))
    const retry2 = uploads.map((s) => renderName(s.name, { ...RETRY, runAttempt: '2' }))
    expect(retry1.filter((n) => retry2.includes(n))).toEqual([])
  })
})

describe('deploy-staging retry wiring', () => {
  const deploy = read(DEPLOY)

  it('gives the first attempt and the retry distinct attempt labels', () => {
    expect(jobBlock(deploy, 'e2e-critical').join('\n')).toMatch(/^\s*attempt:\s*first\s*$/m)
    expect(jobBlock(deploy, 'e2e-critical-retry').join('\n')).toMatch(/^\s*attempt:\s*retry\s*$/m)
  })

  it('runs the retry only after the first attempt failed, on the same workflow call', () => {
    const retry = jobBlock(deploy, 'e2e-critical-retry').join('\n')
    expect(retry).toMatch(/needs:\s*\[e2e-critical\]/)
    expect(retry).toMatch(/if:\s*failure\(\)/)
    expect(retry).toMatch(/uses:\s*\.\/\.github\/workflows\/e2e-hosted\.yml/)
    expect(retry).toMatch(/previous_classification:/)
  })

  it('declares `attempt` as a workflow_call input, defaulting to `first`', () => {
    const hosted = read(HOSTED)
    const callAt = hosted.indexOf('workflow_call:')
    const callBlock = hosted.slice(callAt, hosted.indexOf('\n    outputs:', callAt))
    expect(callAt).toBeGreaterThan(0)
    expect(callBlock).toMatch(/^\s*attempt:\s*$/m)
    expect(callBlock).toMatch(/default:\s*'first'/)
  })
})
