// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 4a — createWriteFileTool — create/append/parent-dirs/protected/lint-queue
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { CommandRegistry } from '../command-registry'
import { FileStateCache } from '../file-state-cache'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-write-file'

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
    ...overrides,
  }
}

async function run(ctx: ToolContext, name: string, params: Record<string, any>) {
  const all = createTools(ctx)
  const t = all.find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  const result = await t.execute('test-call', params)
  return { details: result.details, content: result.content }
}


describe('createWriteFileTool', () => {
  
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })

  afterAll(() => clearTrustForTests())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('creates a new file and reports bytes written', async () => {
    const ctx = makeCtx()
    const r = await run(ctx, 'write_file', { path: 'x.txt', content: 'hello' })
    expect(r.details.ok).toBe(true)
    expect(r.details.bytes).toBe(5)
    expect(readFileSync(join(TEST_DIR, 'x.txt'), 'utf8')).toBe('hello')
  })

  test('creates parent directories on the fly', async () => {
    const ctx = makeCtx()
    const r = await run(ctx, 'write_file', { path: 'a/b/c/deep.txt', content: 'deep' })
    expect(r.details.ok).toBe(true)
    expect(existsSync(join(TEST_DIR, 'a/b/c/deep.txt'))).toBe(true)
  })

  test('append mode concatenates to an existing file', async () => {
    writeFileSync(join(TEST_DIR, 'log.txt'), 'first\n')
    const ctx = makeCtx()
    const r = await run(ctx, 'write_file', { path: 'log.txt', content: 'second\n', append: true })
    expect(r.details.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'log.txt'), 'utf8')).toBe('first\nsecond\n')
  })

  test('append mode on a missing file creates it with just the content', async () => {
    const ctx = makeCtx()
    const r = await run(ctx, 'write_file', { path: 'fresh.txt', content: 'only', append: true })
    expect(r.details.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'fresh.txt'), 'utf8')).toBe('only')
  })

  test('protected path (src/main.tsx) is rejected', async () => {
    // PROTECTED_WORKSPACE_FILES = ['src/main.tsx', 'src/ShogoErrorBoundary.tsx']
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    const ctx = makeCtx()
    const r = await run(ctx, 'write_file', { path: 'src/main.tsx', content: 'export {}' })
    expect(typeof r.details.error).toBe('string')
    expect(r.details.error.toLowerCase()).toMatch(/protected|cannot|not allowed/)
  })

  test('invalidates fileStateCache so subsequent edit reads the new content', async () => {
    const cache = new FileStateCache(TEST_DIR)
    writeFileSync(join(TEST_DIR, 'cache.txt'), 'old')
    cache.recordRead('cache.txt', statSync(join(TEST_DIR, 'cache.txt')).mtimeMs, 1, undefined, 'old')
    const ctx = makeCtx({ fileStateCache: cache })
    await run(ctx, 'write_file', { path: 'cache.txt', content: 'new' })
    // After invalidate, getRecord should be undefined or stale-flagged.
    const rec = cache.getRecord('cache.txt')
    if (rec) {
      expect(cache.isStale('cache.txt', join(TEST_DIR, 'cache.txt'))).toBe(false)
    }
  })

  test('quick-actions JSON validation surfaces errors in the result', async () => {
    mkdirSync(join(TEST_DIR, '.shogo'), { recursive: true })
    const ctx = makeCtx()
    // Invalid: not an array
    const r = await run(ctx, 'write_file', {
      path: '.shogo/quick-actions.json',
      content: JSON.stringify({ wrong: 'shape' }),
    })
    expect(r.details.quickActionsLint).toBeDefined()
    expect(r.details.quickActionsLint.valid).toBe(false)
  })

  test('quick-actions JSON valid {actions:[...]} passes the lint', async () => {
    mkdirSync(join(TEST_DIR, '.shogo'), { recursive: true })
    const ctx = makeCtx()
    const r = await run(ctx, 'write_file', {
      path: '.shogo/quick-actions.json',
      content: JSON.stringify({ actions: [{ label: 'Test', prompt: 'do thing' }] }),
    })
    expect(r.details.quickActionsLint?.valid).toBe(true)
  })

  test('appendImpactHint adds impact_note when graph reports impactedFiles', async () => {
    const ctx = makeCtx({
      workspaceGraph: {
        getImpactRadius: () => ({
          impactedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
          changedNodes: [], edges: [], impactedNodes: [],
        }),
      },
    })
    const r = await run(ctx, 'write_file', {
      path: 'lib/u.ts',
      content: 'export const x = 1\n',
    })
    expect(r.details.ok).toBe(true)
    expect(String(r.details.impact_note)).toContain('referenced by 3 other file(s)')
    expect(String(r.details.impact_note)).toContain('src/a.ts')
  })

  test('appendImpactHint truncates large impact lists with "and N more"', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`)
    const ctx = makeCtx({
      workspaceGraph: {
        getImpactRadius: () => ({
          impactedFiles: many, changedNodes: [], edges: [], impactedNodes: [],
        }),
      },
    })
    const r = await run(ctx, 'write_file', {
      path: 'lib/u2.ts',
      content: 'export const y = 2\n',
    })
    expect(String(r.details.impact_note)).toContain('referenced by 12 other file(s)')
    expect(String(r.details.impact_note)).toContain('and 7 more')
  })

  test('appendImpactHint silent when impactedFiles empty', async () => {
    const ctx = makeCtx({
      workspaceGraph: {
        getImpactRadius: () => ({
          impactedFiles: [], changedNodes: [], edges: [], impactedNodes: [],
        }),
      },
    })
    const r = await run(ctx, 'write_file', {
      path: 'lib/u3.ts',
      content: 'export const z = 3\n',
    })
    expect(r.details.impact_note).toBeUndefined()
  })

  test('appendImpactHint swallows graph errors silently', async () => {
    const ctx = makeCtx({
      workspaceGraph: {
        getImpactRadius: () => { throw new Error('graph corrupt') },
      },
    })
    const r = await run(ctx, 'write_file', {
      path: 'lib/u4.ts',
      content: 'export const w = 4\n',
    })
    expect(r.details.ok).toBe(true)
    expect(r.details.impact_note).toBeUndefined()
  })
})
