// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Catalog-wide eval invariants, checked over every exported eval in
 * `test-cases-*.ts` (loaded directly — not via run-eval.ts):
 *
 * 1. Shape: every eval has an id, an input, and well-formed criteria.
 * 2. gh safety: every eval's exec/terminal_exec mock answers `gh` itself,
 *    so no eval can reach a real GitHub account even if the harness's
 *    credential isolation fails.
 * 3. connect coverage: every tool a `connect` mock advertises has a mock.
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync } from 'fs'
import { join } from 'path'
import type { AgentEval } from './types'
import { buildMockPayload, connectAdvertisedTools } from './tool-mocks'
import { compileInstallBody } from './tool-mocks-runtime'

function isEval(v: unknown): v is AgentEval {
  return !!v && typeof v === 'object' && 'id' in v && 'validationCriteria' in v
}

const files = readdirSync(import.meta.dir)
  .filter(f => /^test-cases-.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
  .sort()

const byFile = new Map<string, AgentEval[]>()
for (const f of files) {
  const mod = await import(join(import.meta.dir, f))
  const seen = new Set<AgentEval>()
  for (const value of Object.values(mod)) {
    for (const v of Array.isArray(value) ? value : [value]) if (isEval(v)) seen.add(v)
  }
  byFile.set(f, [...seen])
}
const allEvals = [...new Set([...byFile.values()].flat())]

const GH_COMMANDS = [
  'gh auth status',
  'gh pr list --state open',
  'cd repo && gh issue list --limit 5',
  'gh api user',
  'gh api repos/acme/web/issues',
  'GH_TOKEN=x gh repo list',
]

describe('eval catalog', () => {
  test('every test-cases file exports at least one eval', () => {
    expect(allEvals.length).toBeGreaterThan(300)
    const empty = [...byFile].filter(([, evs]) => evs.length === 0).map(([f]) => f)
    expect(empty).toEqual([])
  })

  test('every eval has id, input and well-formed validationCriteria', () => {
    const problems: string[] = []
    for (const ev of allEvals) {
      const where = ev.id || '(no id)'
      if (typeof ev.id !== 'string' || !ev.id) problems.push(`${where}: missing id`)
      if (typeof ev.input !== 'string' || !ev.input.trim()) problems.push(`${where}: missing input`)
      if (!Array.isArray(ev.validationCriteria) || ev.validationCriteria.length === 0) {
        problems.push(`${where}: no validationCriteria`)
        continue
      }
      for (const c of ev.validationCriteria) {
        if (!c.id) problems.push(`${where}: criterion without id`)
        if (typeof c.validate !== 'function') problems.push(`${where}/${c.id}: validate is not a function`)
        if (typeof c.points !== 'number' || !(c.points >= 0)) problems.push(`${where}/${c.id}: bad points`)
      }
    }
    expect(problems).toEqual([])
  })

  test('maxScore equals the sum of criterion points (the runner divides by maxScore)', () => {
    const off = allEvals
      .map(ev => ({ id: ev.id, max: ev.maxScore, sum: ev.validationCriteria.reduce((s, c) => s + c.points, 0) }))
      .filter(x => x.max !== x.sum)
    expect(off).toEqual([])
  })

  test('criterion ids are unique within each eval', () => {
    const dupes: string[] = []
    for (const ev of allEvals) {
      const ids = ev.validationCriteria.map(c => c.id)
      for (const id of new Set(ids)) if (ids.filter(x => x === id).length > 1) dupes.push(`${ev.id}/${id}`)
    }
    expect(dupes).toEqual([])
  })
})

describe('gh safety', () => {
  test('every eval mocks gh on exec and terminal_exec', async () => {
    const leaks: string[] = []
    for (const ev of allEvals) {
      const compiled = compileInstallBody({ mocks: buildMockPayload(ev.toolMocks), defaults: { delayMs: 0, jitterMs: 0 } })
      for (const tool of ['exec', 'terminal_exec']) {
        const fn = compiled.fns[tool]
        if (!fn) {
          leaks.push(`${ev.id}: no ${tool} mock`)
          continue
        }
        for (const command of GH_COMMANDS) {
          const res = await fn({ command })
          if (res === '__passthrough') leaks.push(`${ev.id}: ${tool} passes "${command}" to the real shell`)
        }
      }
    }
    expect(leaks).toEqual([])
  })
})

describe('connect coverage', () => {
  test('every tool a connect mock advertises has a mock in the payload', () => {
    const missing: string[] = []
    for (const ev of allEvals) {
      const payload = buildMockPayload(ev.toolMocks)
      for (const name of connectAdvertisedTools(payload)) if (!(name in payload)) missing.push(`${ev.id}: ${name}`)
    }
    expect(missing).toEqual([])
  })
})
