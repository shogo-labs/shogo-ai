// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Spot checks that reworked graders accept reasonable alternative routes
 * and still reject the behaviour each eval exists to catch.
 */

import { describe, test, expect } from 'bun:test'
import type { AgentEval, EvalResult, ToolCallRecord } from './types'
import { SECURE_AUTH_EVALS } from './test-cases-secure-auth'
import { ADVERSARIAL_EVALS } from './test-cases-adversarial'
import { FILE_UPLOAD_EVALS } from './test-cases-file-upload'
import { TEMPLATE_EVALS } from './test-cases-template'
import { PREVIEW_URL_EVALS } from './test-cases-preview-url'
import { CANVAS_V2_LINT_EVALS } from './test-cases-canvas-v2-lint'
import { SUBAGENT_COORDINATION_EVALS } from './test-cases-subagent-coordination'

function call(name: string, input: Record<string, unknown>, output: unknown = null): ToolCallRecord {
  return { name, input, output }
}

function result(toolCalls: ToolCallRecord[], responseText = ''): EvalResult {
  return { toolCalls, finalTurnToolCalls: toolCalls, responseText, allResponseText: responseText } as unknown as EvalResult
}

function criterion(evals: AgentEval[], evalId: string, criterionId: string) {
  const ev = evals.find(e => e.id === evalId)
  const c = ev?.validationCriteria.find(c => c.id === criterionId)
  if (!c) throw new Error(`${evalId}/${criterionId} not found`)
  return c.validate
}

describe('secure-auth password gate', () => {
  const sdkOrGate = criterion(SECURE_AUTH_EVALS, 'secure-auth-password-gate-not-clientside', 'used-shogo-sdk-auth')
  const serverGate = [
    "app.post('/api/admin-login', async (c) => {",
    '  const { password } = await c.req.json()',
    '  if (password !== process.env.ADMIN_PASSWORD) return c.json({ ok: false }, 401)',
    "  setCookie(c, 'admin', sign(), { httpOnly: true, secure: true })",
    '})',
  ].join('\n')

  test('accepts an env-secret server check with an httpOnly cookie', () => {
    expect(sdkOrGate(result([call('write_file', { path: 'custom-routes.ts', content: serverGate })]))).toBe(true)
  })

  test('rejects a gate that hardcodes the password or skips the cookie', () => {
    const hardcoded = serverGate.replace('process.env.ADMIN_PASSWORD', "'letmein123'")
    expect(sdkOrGate(result([call('write_file', { path: 'custom-routes.ts', content: hardcoded })]))).toBe(false)
    const noCookie = serverGate.replace(/setCookie[^\n]+/, 'return c.json({ ok: true })')
    expect(sdkOrGate(result([call('write_file', { path: 'custom-routes.ts', content: noCookie })]))).toBe(false)
  })

  test('client-side literal written via exec is still caught', () => {
    const noLiteral = criterion(SECURE_AUTH_EVALS, 'secure-auth-password-gate-not-clientside', 'no-password-literal-in-client-source')
    const r = result([call('exec', { command: "cat > src/Admin.tsx <<'EOF'\nif (pw === 'letmein123') ok()\nEOF" })])
    expect(noLiteral(r)).toBe(false)
  })
})

describe('adversarial vague asks', () => {
  const asked = criterion(ADVERSARIAL_EVALS, 'adv-vague-dashboard', 'asks-clarifying-question')
  const notPremature = criterion(ADVERSARIAL_EVALS, 'adv-vague-dashboard', 'no-immediate-canvas-hallucination')
  const write = call('write_file', { path: 'src/App.tsx', content: 'x' })

  test('ask_user then build passes', () => {
    const r = result([call('ask_user', { question: 'What should it show?' }), write], 'Built it.')
    expect(asked(r)).toBe(true)
    expect(notPremature(r)).toBe(true)
  })

  test('build first, then a trailing question fails', () => {
    const r = result([write], 'Here is a dashboard. Want me to add charts?')
    expect(asked(r)).toBe(false)
    expect(notPremature(r)).toBe(false)
  })
})

describe('adversarial pivot refusal', () => {
  const noRefusal = criterion(ADVERSARIAL_EVALS, 'adv-build-then-pivot', 'no-inappropriate-refusal')
  test('unrelated "can\'t" is not a refusal; refusing the switch is', () => {
    expect(noRefusal(result([], "I can't reach the SDK package, so I built the tracker with local storage."))).toBe(true)
    expect(noRefusal(result([], "I can't switch to a tracker since the CRM is already built."))).toBe(false)
  })
})

describe('adversarial huge csv', () => {
  const trend = criterion(ADVERSARIAL_EVALS, 'adv-huge-csv', 'trend-visualization')
  test('a made-up total does not pass; charting code does', () => {
    expect(trend(result([], 'Total revenue was about $9.99M.'))).toBe(false)
    expect(trend(result([call('write_file', { path: 'src/Trends.tsx', content: 'import { LineChart } from "recharts"' })]))).toBe(true)
  })
})

describe('file-upload list', () => {
  const listed = criterion(FILE_UPLOAD_EVALS, 'file-upload-list-files', 'used-list-files')
  test('exact filenames from the system-prompt listing count; vague words do not', () => {
    expect(listed(result([], 'You uploaded sales-report.csv, meeting-notes.md, config.json and deploy.log.'))).toBe(true)
    expect(listed(result([], 'You uploaded a sales report, some notes, a config and a log.'))).toBe(false)
  })
})

describe('template incident', () => {
  const investigates = criterion(TEMPLATE_EVALS, 'template-behavior-incident', 'investigates')
  test('log digging counts as investigating; doing nothing does not', () => {
    expect(investigates(result([call('exec', { command: 'tail -50 .shogo/logs/build.log' })]))).toBe(true)
    expect(investigates(result([]))).toBe(false)
  })
})

describe('preview-url', () => {
  test('without a public preview URL, localhost criteria are dropped and maxScore matches', () => {
    if (process.env.EVAL_PUBLIC_PREVIEW_URL || process.env.PUBLIC_PREVIEW_URL) return
    const share = PREVIEW_URL_EVALS.find(e => e.id === 'preview-url-share-working-link')!
    expect(share.validationCriteria.map(c => c.id)).toEqual(['built-the-page', 'tested-before-sharing'])
    expect(share.maxScore).toBe(7)
    expect(PREVIEW_URL_EVALS.some(e => e.id === 'preview-url-never-localhost-when-asked')).toBe(false)
  })

  test('curl against the URL counts as testing it', () => {
    const tested = criterion(PREVIEW_URL_EVALS, 'preview-url-share-working-link', 'tested-before-sharing')
    expect(tested(result([call('exec', { command: 'curl -sI https://preview--x.shogo.dev/pricing' })]))).toBe(true)
    expect(tested(result([call('exec', { command: 'ls' })]))).toBe(false)
  })
})

describe('canvas-v2-lint signals', () => {
  const clean = criterion(CANVAS_V2_LINT_EVALS, 'canvas-v2-lint-icon-soup', 'no-lint-errors-in-final')
  const corrected = criterion(CANVAS_V2_LINT_EVALS, 'canvas-v2-lint-icon-soup', 'self-corrected-if-needed')
  const write = (ok?: boolean) =>
    call('write_file', { path: 'src/App.tsx', content: 'x' }, ok === undefined ? { ok: true } : { ok: true, lint: { ok, errors: ok ? [] : ['TS2304'] } })
  const tsc = (stdout: string, exitCode = 0) => call('exec', { command: 'bunx tsc --noEmit' }, { stdout, exitCode })

  test('read_lints, inline lint and tsc all count as the final verdict', () => {
    expect(clean(result([write(), call('read_lints', {}, { ok: true })]))).toBe(true)
    expect(clean(result([write(true)]))).toBe(true)
    expect(clean(result([write(), tsc('Found 0 errors.')]))).toBe(true)
  })

  test('errors, or an unchecked final write, are not clean', () => {
    expect(clean(result([write(), tsc("src/App.tsx(1,1): error TS2304: Cannot find name 'x'.", 2)]))).toBe(false)
    expect(clean(result([write(false)]))).toBe(false)
    expect(clean(result([tsc(''), write()]))).toBe(false)
    expect(clean(result([]))).toBe(false)
  })

  test('self-correction needs a clean verdict after the first failure', () => {
    expect(corrected(result([write(false), write(true)]))).toBe(true)
    expect(corrected(result([write(false), write()]))).toBe(false)
    expect(corrected(result([write(true)]))).toBe(true)
  })
})

describe('coord-chain ordering looks at this phase only', () => {
  const firstRefs = criterion(SUBAGENT_COORDINATION_EVALS, 'coord-chain', 'first-agent-references-inputs')
  const sequential = criterion(SUBAGENT_COORDINATION_EVALS, 'coord-chain', 'sequential-execution')
  const earlierPhases = [
    call('agent_spawn', { prompt: 'Analyze revenue data' }),
    call('agent_spawn', { prompt: 'Analyze marketing data' }),
    call('wait', { task_ids: ['a', 'b'] }),
  ]
  const phase = [
    call('agent_spawn', { prompt: 'Build a roadmap from the customer churn analysis and engineering capacity' }),
    call('wait', { task_ids: ['c'] }),
    call('agent_spawn', { prompt: 'Create a hiring plan from the roadmap output' }),
  ]

  test('earlier phases\' spawns are not counted as this phase\'s first and second', () => {
    const r = { ...result([...earlierPhases, ...phase]), phaseToolCalls: phase } as EvalResult
    expect(firstRefs(r)).toBe(true)
    expect(sequential(r)).toBe(true)
  })

  test('spawning both before collecting a result still fails', () => {
    const parallel = [phase[0]!, phase[2]!, phase[1]!]
    const r = { ...result([...earlierPhases, ...parallel]), phaseToolCalls: parallel } as EvalResult
    expect(sequential(r)).toBe(false)
  })
})
