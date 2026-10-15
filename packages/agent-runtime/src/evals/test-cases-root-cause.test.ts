// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AgentEval, EvalResult, ToolCallRecord } from './types'
import {
  RAG_FIXTURE,
  ROOT_CAUSE_EVALS,
  TIMEOUT_FIXTURE,
  _resetWorkspaceTestCacheForTests,
  planSection,
  proposesWorkaround,
  RAG_WORKAROUND,
  workspaceTestsPass,
} from './test-cases-root-cause'

const byId = (id: string) => ROOT_CAUSE_EVALS.find((e) => e.id === id)!

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  _resetWorkspaceTestCacheForTests()
})

function workspace(files: Record<string, string>, overrides: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'root-cause-eval-'))
  dirs.push(dir)
  for (const [rel, content] of Object.entries({ ...files, ...overrides })) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

function call(name: string, input: Record<string, unknown>): ToolCallRecord {
  return { name, input, output: null }
}

function result(toolCalls: ToolCallRecord[], workspaceDir?: string): EvalResult {
  return { toolCalls, finalTurnToolCalls: toolCalls, workspaceDir } as unknown as EvalResult
}

/** Mirrors the runner: sum of passing criteria, pass at >= 70%. */
function score(evalCase: AgentEval, r: EvalResult): { score: number; passed: boolean; failed: string[] } {
  let total = 0
  const failed: string[] = []
  for (const c of evalCase.validationCriteria) {
    if (c.validate(r)) total += c.points
    else failed.push(c.id)
  }
  return { score: total, passed: (total / evalCase.maxScore) * 100 >= 70, failed }
}

function planCall(plan: string, todos: Array<{ id: string; content: string }> = []): ToolCallRecord {
  return call('create_plan', { name: 'Fix', overview: 'Fix it', plan, todos })
}

const GOOD_RAG_PLAN = `## Problem
RAG context is always cut at 4096 tokens.

## Root cause
\`src/rag/pipeline.ts:7\` calls \`truncateToTokens(ctx, MAX_INPUT_TOKENS)\`; the constant comes from \`src/config/llm.ts:3\` and the user setting \`getSettings().maxInputTokens\` (\`src/settings/store.ts:15\`) is never read.

## Options considered
1. Read \`getSettings().maxInputTokens\` in the pipeline. Chosen.
2. Raise MAX_INPUT_TOKENS to 32000. Rejected: still ignores the setting.

## Changes
- \`src/rag/pipeline.ts\`: replace the MAX_INPUT_TOKENS import with \`getSettings().maxInputTokens\`.

## Tests
- \`src/rag/__tests__/pipeline.test.ts\`: set maxInputTokens to 3 and assert the context is truncated to 3 tokens.

## Verification
Run \`bun test\`.

## Risks
None significant. Do not add an env override.
`

const WORKAROUND_RAG_PLAN = `## Root cause
The limit is too low.

## Options considered
Only one.

## Changes
- \`src/config/llm.ts\`: raise MAX_INPUT_TOKENS to 32000.
- Allow \`process.env.MAX_INPUT_TOKENS\` to override it.

## Tests
- Add a test for the bigger limit.
`

describe('fixtures', () => {
  test('the RAG fixture test suite passes as seeded', () => {
    expect(workspaceTestsPass(result([], workspace(RAG_FIXTURE)))).toBe(true)
  })

  test('the timeout fixture test suite passes as seeded', () => {
    expect(workspaceTestsPass(result([], workspace(TIMEOUT_FIXTURE)))).toBe(true)
  })

  test('a failing workspace test is reported', () => {
    const dir = workspace(RAG_FIXTURE, {
      'src/rag/__tests__/broken.test.ts': "import { test, expect } from 'bun:test'\ntest('x', () => expect(1).toBe(2))\n",
    })
    expect(workspaceTestsPass(result([], dir))).toBe(false)
  })

  test('without a workspace the test criterion fails closed', () => {
    expect(workspaceTestsPass(result([]))).toBe(false)
  })
})

describe('root-cause-agent-hardcoded-limit', () => {
  const evalCase = byId('root-cause-agent-hardcoded-limit')

  test('the untouched fixture fails', () => {
    const r = score(evalCase, result([], workspace(RAG_FIXTURE)))
    expect(r.passed).toBe(false)
    expect(r.failed).toEqual(['pipeline-drops-constant', 'pipeline-reads-setting', 'non-default-setting-test'])
  })

  test('a root-cause fix with a non-default setting test scores full marks', () => {
    const dir = workspace(RAG_FIXTURE, {
      'src/rag/pipeline.ts': `import { getSettings } from '../settings/store'
import { truncateToTokens } from './tokens'

export function buildContext(chunks: string[]): string {
  return truncateToTokens(chunks.join('\\n\\n'), getSettings().maxInputTokens)
}
`,
      'src/rag/__tests__/pipeline.test.ts': `import { afterEach, expect, test } from 'bun:test'
import { buildContext } from '../pipeline'
import { resetSettingsCache, updateSettings } from '../../settings/store'

afterEach(() => resetSettingsCache())

test('joins retrieved chunks', () => {
  expect(buildContext(['alpha beta', 'gamma'])).toBe('alpha beta gamma')
})

test('honors a non-default maxInputTokens', () => {
  updateSettings({ maxInputTokens: 2 }, { persist: false })
  expect(buildContext(['alpha beta', 'gamma'])).toBe('alpha beta')
})
`,
    })
    const r = score(evalCase, result([], dir))
    expect(r.failed).toEqual([])
    expect(r.score).toBe(100)
  })

  test('raising the constant fails', () => {
    const dir = workspace(RAG_FIXTURE, {
      'src/config/llm.ts': "export const MODEL = 'gpt-4o-mini'\nexport const MAX_INPUT_TOKENS = 32000\n",
    })
    const r = score(evalCase, result([], dir))
    expect(r.passed).toBe(false)
    expect(r.failed).toContain('constant-not-raised')
  })

  test('a fix that breaks the suite loses the bun-test criterion', () => {
    const dir = workspace(RAG_FIXTURE, {
      'src/rag/pipeline.ts': `import { getSettings } from '../settings/store'
export function buildContext(chunks: string[]): string {
  return chunks.join('|').slice(0, getSettings().maxInputTokens)
}
`,
    })
    expect(score(evalCase, result([], dir)).failed).toContain('bun-test-passes')
  })
})

describe('root-cause-plan-hardcoded-limit', () => {
  const evalCase = byId('root-cause-plan-hardcoded-limit')
  const research = [
    call('exec', { command: "rg -n 'MAX_INPUT_TOKENS'" }),
    call('read_file', { path: 'src/rag/pipeline.ts' }),
    call('read_file', { path: 'src/settings/store.ts' }),
  ]

  test('a researched root-cause plan scores full marks', () => {
    const r = score(evalCase, result([...research, planCall(GOOD_RAG_PLAN)]))
    expect(r.failed).toEqual([])
    expect(r.score).toBe(100)
  })

  test('a workaround plan fails', () => {
    const r = score(evalCase, result([...research, planCall(WORKAROUND_RAG_PLAN)]))
    expect(r.passed).toBe(false)
    expect(r.failed).toEqual(expect.arrayContaining(['plan-replaces-hardcode', 'no-workaround']))
  })

  test('skipping the code search and reading only the pipeline costs the intention points', () => {
    const r = score(evalCase, result([call('read_file', { path: 'src/rag/pipeline.ts' }), planCall(GOOD_RAG_PLAN)]))
    expect(r.failed).toEqual(['searched-code', 'read-consumer-and-source'])
    expect(r.score).toBe(70)
  })

  test('no plan scores only the research points', () => {
    const r = score(evalCase, result(research))
    expect(r.passed).toBe(false)
    expect(r.score).toBe(30)
  })

  test('Windows-style read paths count', () => {
    const r = score(evalCase, result([
      call('exec', { command: "rg -n 'x'" }),
      call('read_file', { path: 'src\\rag\\pipeline.ts' }),
      call('read_file', { path: 'src\\settings\\store.ts' }),
      planCall(GOOD_RAG_PLAN),
    ]))
    expect(r.score).toBe(100)
  })

  test('a test listed only in todos counts', () => {
    const plan = GOOD_RAG_PLAN.replace(/## Tests[\s\S]*?## Verification/, '## Verification')
    const r = score(evalCase, result([...research, planCall(plan, [{ id: 'add-test', content: 'Add a pipeline test for a custom limit' }])]))
    expect(r.failed).toEqual([])
  })
})

describe('root-cause-plan-timeout', () => {
  const evalCase = byId('root-cause-plan-timeout')
  const research = [
    call('exec', { command: "rg -n 'timeout'" }),
    call('read_file', { path: 'src/http/client.ts' }),
    call('read_file', { path: 'src/settings/settings.ts' }),
  ]

  test('a root-cause plan scores full marks', () => {
    const plan = `## Root cause
\`src/http/client.ts:24\` hardcodes \`timeout: 5000\`; \`settings().requestTimeoutMs\` is never read.

## Options considered
1. Pass \`settings().requestTimeoutMs\` into the client. Chosen.
2. Change the literal to 30000. Rejected: still ignores the setting.

## Changes
- \`src/http/client.ts\`: read \`settings().requestTimeoutMs\` for each request instead of the literal.

## Tests
- client.test.ts: with requestTimeoutMs = 50 a slow fetch aborts.
`
    const r = score(evalCase, result([...research, planCall(plan)]))
    expect(r.failed).toEqual([])
  })

  test('bumping the literal fails', () => {
    const plan = `## Root cause
5s is too short.

## Options considered
None.

## Changes
- \`src/http/client.ts\`: change \`timeout: 5000\` to \`timeout: 30000\`.

## Tests
- Add a test.
`
    const r = score(evalCase, result([...research, planCall(plan)]))
    expect(r.passed).toBe(false)
    expect(r.failed).toEqual(expect.arrayContaining(['plan-replaces-hardcode', 'no-workaround']))
  })
})

describe('validator helpers', () => {
  test('planSection stops at the next heading of the same level', () => {
    const body = '## A\none\n### A.1\ntwo\n## B\nthree'
    expect(planSection(body, 'A')).toBe('one\n### A.1\ntwo')
    expect(planSection(body, 'B')).toBe('three')
    expect(planSection(body, 'C')).toBeNull()
  })

  test('workarounds discussed in Options considered are not the primary fix', () => {
    expect(proposesWorkaround(result([planCall(GOOD_RAG_PLAN)]), RAG_WORKAROUND)).toBe(false)
  })

  test('negated env-override lines in Changes are ignored', () => {
    const plan = '## Changes\n- Read getSettings().maxInputTokens. Do not add a process.env override.\n'
    expect(proposesWorkaround(result([planCall(plan)]), RAG_WORKAROUND)).toBe(false)
  })

  test('without a Changes section, the body outside Options considered is checked', () => {
    const plan = '## Options considered\nraise MAX_INPUT_TOKENS (rejected)\n\n## Plan\n- increase MAX_INPUT_TOKENS to 32000\n'
    expect(proposesWorkaround(result([planCall(plan)]), RAG_WORKAROUND)).toBe(true)
  })
})
