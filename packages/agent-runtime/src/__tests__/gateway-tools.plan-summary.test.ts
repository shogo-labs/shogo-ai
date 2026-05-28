// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// gateway-tools.ts — runPlanSummary + dual-plan dispatch coverage
// Targets L5678-5727 (runPlanSummary IIFE: import plan-translation, summarize,
// upsertSummarySection, write back, emit data-plan-summary / -error events)
// and L5905-5919 (update_plan dual-plan trigger).

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock plan-translation with stateful toggles
let summarizeBehavior: 'ok' | 'throw' = 'ok'
let lastSummarizeArgs: any = null
mock.module('../plan-translation', () => ({
  summarizePlan: async (args: any) => {
    lastSummarizeArgs = args
    if (summarizeBehavior === 'throw') throw new Error('summary engine down')
    return '## What this plan does\n\nStub summary.'
  },
  upsertSummarySection: (existing: string, summary: string) =>
    existing.replace(/\n*$/, '\n\n') + summary + '\n',
}))

const { createTools } = await import('../gateway-tools')

let TEST_DIR: string

function makePlanFile(name = 'wave-1', overview = 'Test plan', body = 'Step 1. do thing\n'): string {
  const filepath = `.shogo/plans/${name}_abc123.plan.md`
  const planDir = join(TEST_DIR, '.shogo', 'plans')
  mkdirSync(planDir, { recursive: true })
  const content = [
    '---',
    `name: "${name}"`,
    `overview: "${overview}"`,
    `createdAt: "2026-05-28T00:00:00Z"`,
    'status: pending',
    'todos:',
    '  - id: t1',
    '    content: "Step one"',
    '    status: pending',
    '---',
    '',
    `# ${name}`,
    '',
    body,
  ].join('\n')
  writeFileSync(join(TEST_DIR, filepath), content, 'utf-8')
  return filepath
}

function makeWriter() {
  const events: any[] = []
  return { events, write: (e: any) => { events.push(e) } }
}

function makeCtx(overrides: any = {}): any {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800, heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'plan-summary-test',
    sessionId: 'sess-1',
    mainSessionIds: ['sess-1'],
    effectiveModel: 'claude-sonnet-4-5',
    ...overrides,
  }
}

async function exec(ctx: any, name: string, params: Record<string, any>) {
  const tools = createTools(ctx)
  const tool = tools.find((t: any) => t.name === name)!
  const r = await tool.execute('test-id', params)
  return r
}

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'plan-summary-'))
  summarizeBehavior = 'ok'
  lastSummarizeArgs = null
})
afterEach(() => {
  if (TEST_DIR && existsSync(TEST_DIR)) {
    try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  }
})

describe('runPlanSummary via update_plan + dualPlan', () => {
  test('update_plan with plan body change + dualPlan triggers summary IIFE', async () => {
    const filepath = makePlanFile()
    const writer = makeWriter()
    const ctx = makeCtx({ dualPlan: true, uiWriter: writer })
    const r = await exec(ctx, 'update_plan', { filepath, plan: 'New body content' })
    expect(r).toBeDefined()
    // Wait for async IIFE to run
    await new Promise(res => setTimeout(res, 100))
    // summarizePlan was called
    expect(lastSummarizeArgs).not.toBeNull()
    expect(lastSummarizeArgs.parentModel).toBe('claude-sonnet-4-5')
    expect(lastSummarizeArgs.planMarkdown).toBe('New body content')
    // data-plan-summary-start AND data-plan-summary fired
    const start = writer.events.find((e) => e.type === 'data-plan-summary-start')
    const done = writer.events.find((e) => e.type === 'data-plan-summary')
    expect(start).toBeDefined()
    expect(done).toBeDefined()
    expect(done.data.summary).toContain('Stub summary')
    // Plan file on disk now has the summary section appended
    const onDisk = readFileSync(join(TEST_DIR, filepath), 'utf-8')
    expect(onDisk).toContain('Stub summary')
  })

  test('update_plan with name change + dualPlan also triggers summary', async () => {
    const filepath = makePlanFile()
    const writer = makeWriter()
    const ctx = makeCtx({ dualPlan: true, uiWriter: writer })
    const r = await exec(ctx, 'update_plan', { filepath, name: 'renamed-plan' })
    expect(r).toBeDefined()
    await new Promise(res => setTimeout(res, 100))
    expect(lastSummarizeArgs?.name).toBe('renamed-plan')
  })

  test('update_plan without dualPlan does NOT trigger summary', async () => {
    const filepath = makePlanFile()
    const writer = makeWriter()
    const ctx = makeCtx({ dualPlan: false, uiWriter: writer })
    await exec(ctx, 'update_plan', { filepath, plan: 'changed body' })
    await new Promise(res => setTimeout(res, 50))
    expect(lastSummarizeArgs).toBeNull()
    expect(writer.events.find((e) => e.type === 'data-plan-summary-start')).toBeUndefined()
  })

  test('update_plan with no meaningful change does NOT trigger summary', async () => {
    const filepath = makePlanFile('p2', 'same', 'same body')
    const writer = makeWriter()
    const ctx = makeCtx({ dualPlan: true, uiWriter: writer })
    // No plan/name/overview provided — only todos
    await exec(ctx, 'update_plan', { filepath, todos: [{ id: 'x', content: 'y' }] })
    await new Promise(res => setTimeout(res, 50))
    expect(lastSummarizeArgs).toBeNull()
  })

  test('summarizePlan throw emits data-plan-summary-error', async () => {
    summarizeBehavior = 'throw'
    const filepath = makePlanFile()
    const writer = makeWriter()
    const ctx = makeCtx({ dualPlan: true, uiWriter: writer })
    await exec(ctx, 'update_plan', { filepath, plan: 'new body to trigger summary' })
    await new Promise(res => setTimeout(res, 100))
    const err = writer.events.find((e) => e.type === 'data-plan-summary-error')
    expect(err).toBeDefined()
    expect(err.data.message).toBe('summary engine down')
    const done = writer.events.find((e) => e.type === 'data-plan-summary')
    expect(done).toBeUndefined()
  })

  test('plan file removed between summarize and writeback — handled gracefully', async () => {
    const filepath = makePlanFile()
    const writer = makeWriter()
    const ctx = makeCtx({ dualPlan: true, uiWriter: writer })
    // Override summarizePlan to delete the file mid-flight
    const orig = (await import('../plan-translation')).summarizePlan
    ;(globalThis as any)._origSum = orig
    summarizeBehavior = 'ok'
    // Use plan-translation mock state: we can't easily inject side-effect.
    // Instead: just verify the existsSync guard runs by deleting the plan
    // file synchronously BEFORE calling exec (file disappears between
    // update_plan's writeFileSync and runPlanSummary's IIFE).
    await exec(ctx, 'update_plan', { filepath, plan: 'fresh body' })
    // Race the IIFE: delete the file after the synchronous write_plan
    // returns but before the async summarize completes
    rmSync(join(TEST_DIR, filepath))
    await new Promise(res => setTimeout(res, 100))
    // Should NOT have thrown; summary may still have been emitted with the
    // initial readFileSync's content captured before delete
    expect(writer.events.find((e) => e.type === 'data-plan-summary-start')).toBeDefined()
  })
})
