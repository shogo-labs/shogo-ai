// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the read_lints tool in gateway-tools.ts.
 * Uses a mock LSP that returns controlled diagnostics.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import type { LSPDiagnostic, WorkspaceLSPManager } from '@shogo/shared-runtime'

// Use realpathSync to resolve /tmp -> /private/tmp on macOS
const TEST_DIR = realpathSync('/tmp') + '/test-read-lints'

function diag(line: number, message: string, severity = 1, code?: number): LSPDiagnostic {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 10 } },
    severity,
    message,
    code,
  }
}

function createMockLSPManager(diagnostics: Map<string, LSPDiagnostic[]> = new Map()): WorkspaceLSPManager {
  const getDiags = (uri?: string) => {
    if (uri) {
      const diags = diagnostics.get(uri)
      const result = new Map<string, LSPDiagnostic[]>()
      if (diags) result.set(uri, diags)
      return result
    }
    return new Map(diagnostics)
  }
  return {
    isRunning: () => true,
    getDiagnostics: getDiags,
    getDiagnosticsAsync: async (uri?: string) => getDiags(uri),
    notifyFileChanged: () => {},
    notifyFileDeleted: () => {},
    stop: () => {},
  } as unknown as WorkspaceLSPManager
}

function createCtx(lspManager?: WorkspaceLSPManager, fileStateCache?: FileStateCache): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'test',
    lspManager,
    fileStateCache,
  }
}

function getReadLintsTool(ctx: ToolContext) {
  const tools = createTools(ctx)
  const tool = tools.find(t => t.name === 'read_lints')
  if (!tool) throw new Error('read_lints tool not found')
  return tool
}

async function execReadLints(ctx: ToolContext, params: Record<string, any> = {}) {
  const tool = getReadLintsTool(ctx)
  const result = await tool.execute('test-call', params)
  return result.details as any
}

describe('read_lints tool', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(join(TEST_DIR, 'canvas'), { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('returns error when LSP is not available', async () => {
    const ctx = createCtx(undefined)
    const result = await execReadLints(ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Language server not available')
  })

  test('returns error when LSP is not running', async () => {
    const deadLsp = { ...createMockLSPManager(), isRunning: () => false } as unknown as WorkspaceLSPManager
    const ctx = createCtx(deadLsp)
    const result = await execReadLints(ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Language server not available')
  })

  test('returns ok when no diagnostics', async () => {
    const ctx = createCtx(createMockLSPManager())
    const result = await execReadLints(ctx)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('No errors found')
  })

  test('returns ok with specific message for file with no errors', async () => {
    writeFileSync(join(TEST_DIR, 'canvas', 'clean.ts'), 'var x = 1', 'utf-8')
    const ctx = createCtx(createMockLSPManager())
    const result = await execReadLints(ctx, { path: 'canvas/clean.ts' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('canvas/clean.ts')
  })

  test('reports errors for a file with diagnostics', async () => {
    writeFileSync(join(TEST_DIR, 'canvas', 'broken.ts'), 'var x = FakeIcon', 'utf-8')
    const diagnostics = new Map<string, LSPDiagnostic[]>([
      [`file://${TEST_DIR}/canvas/broken.ts`, [
        diag(0, "Cannot find name 'FakeIcon'.", 1, 2304),
      ]],
    ])
    const ctx = createCtx(createMockLSPManager(diagnostics))
    const result = await execReadLints(ctx, { path: 'canvas/broken.ts' })
    expect(result.ok).toBe(false)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('canvas/broken.ts')
    expect(result.files[0].ok).toBe(false)
    expect(result.files[0].errors[0]).toContain('FakeIcon')
    expect(result.hint).toContain('edit_file')
  })

  test('filters out TS1108 (return outside function) for canvas files', async () => {
    writeFileSync(join(TEST_DIR, 'canvas', 'surface.ts'), "return h('div', null, 'hi')", 'utf-8')
    const diagnostics = new Map<string, LSPDiagnostic[]>([
      [`file://${TEST_DIR}/canvas/surface.ts`, [
        diag(0, "A 'return' statement can only be used within a function body.", 1, 1108),
      ]],
    ])
    const ctx = createCtx(createMockLSPManager(diagnostics))
    const result = await execReadLints(ctx, { path: 'canvas/surface.ts' })
    expect(result.ok).toBe(true)
    expect(result.files).toBeUndefined()
    expect(result.message).toContain('canvas/surface.ts')
  })

  test('skips .d.ts files in diagnostics', async () => {
    const diagnostics = new Map<string, LSPDiagnostic[]>([
      [`file://${TEST_DIR}/canvas-globals.d.ts`, [
        diag(5, 'Some ambient type issue', 1, 9999),
      ]],
    ])
    const ctx = createCtx(createMockLSPManager(diagnostics))
    const result = await execReadLints(ctx)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('No errors found')
  })

  test('reports multiple files with mixed results', async () => {
    writeFileSync(join(TEST_DIR, 'canvas', 'good.ts'), 'var x = 1', 'utf-8')
    writeFileSync(join(TEST_DIR, 'canvas', 'bad.ts'), 'var x = Oops', 'utf-8')
    const diagnostics = new Map<string, LSPDiagnostic[]>([
      [`file://${TEST_DIR}/canvas/good.ts`, []],
      [`file://${TEST_DIR}/canvas/bad.ts`, [
        diag(0, "Cannot find name 'Oops'.", 1, 2304),
      ]],
    ])
    const ctx = createCtx(createMockLSPManager(diagnostics))
    const result = await execReadLints(ctx)
    expect(result.ok).toBe(false)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toContain('bad')
    expect(result.files[0].ok).toBe(false)
    expect(result.files.find((f: any) => f.path.includes('good'))).toBeUndefined()
  })

  test('ignores warnings (severity 2) and info (severity 3)', async () => {
    writeFileSync(join(TEST_DIR, 'canvas', 'warn.ts'), 'var x = 1', 'utf-8')
    const diagnostics = new Map<string, LSPDiagnostic[]>([
      [`file://${TEST_DIR}/canvas/warn.ts`, [
        diag(0, 'This is a warning', 2),
        diag(1, 'This is info', 3),
      ]],
    ])
    const ctx = createCtx(createMockLSPManager(diagnostics))
    const result = await execReadLints(ctx, { path: 'canvas/warn.ts' })
    expect(result.ok).toBe(true)
    expect(result.files).toBeUndefined()
    expect(result.message).toContain('canvas/warn.ts')
  })

  test('read_lints tool exists in createTools output', () => {
    const ctx = createCtx(createMockLSPManager())
    const tools = createTools(ctx)
    const tool = tools.find(t => t.name === 'read_lints')
    expect(tool).toBeTruthy()
    expect(tool!.description).toContain('TypeScript')
  })

  // ---------------------------------------------------------------------------
  // Auto-scope behavior (reads ctx.fileStateCache.getEditedThisTurn())
  // ---------------------------------------------------------------------------

  test('auto-scope: no path + no edits this turn falls back to all tracked files', async () => {
    const diagnostics = new Map<string, LSPDiagnostic[]>([
      [`file://${TEST_DIR}/canvas/good.ts`, []],
      [`file://${TEST_DIR}/canvas/bad.ts`, [
        diag(0, "Cannot find name 'Oops'.", 1, 2304),
      ]],
    ])
    const cache = new FileStateCache() // empty editedThisTurn
    const ctx = createCtx(createMockLSPManager(diagnostics), cache)
    const result = await execReadLints(ctx)
    expect(result.auto_scoped).toBeUndefined()
    expect(result.ok).toBe(false)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toContain('bad')
  })

  test('auto-scope: no path + one edited file lints only that file', async () => {
    writeFileSync(join(TEST_DIR, 'canvas', 'touched.ts'), 'var x = Boom', 'utf-8')
    writeFileSync(join(TEST_DIR, 'canvas', 'untouched.ts'), 'var y = Oops', 'utf-8')
    const diagnostics = new Map<string, LSPDiagnostic[]>([
      [`file://${TEST_DIR}/canvas/touched.ts`, [
        diag(0, "Cannot find name 'Boom'.", 1, 2304),
      ]],
      [`file://${TEST_DIR}/canvas/untouched.ts`, [
        diag(0, "Cannot find name 'Oops'.", 1, 2304),
      ]],
    ])
    const cache = new FileStateCache()
    cache.markEditedThisTurn('canvas/touched.ts')
    const ctx = createCtx(createMockLSPManager(diagnostics), cache)
    const result = await execReadLints(ctx)
    expect(result.auto_scoped).toBe(true)
    expect(result.scoped_to).toEqual(['canvas/touched.ts'])
    expect(result.ok).toBe(false)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('canvas/touched.ts')
    expect(result.files[0].errors[0]).toContain('Boom')
  })

  test('auto-scope: no path + multiple edited files merges diagnostics', async () => {
    writeFileSync(join(TEST_DIR, 'canvas', 'a.ts'), 'var x = A', 'utf-8')
    writeFileSync(join(TEST_DIR, 'canvas', 'b.ts'), 'var y = B', 'utf-8')
    writeFileSync(join(TEST_DIR, 'canvas', 'skipped.ts'), 'var z = Z', 'utf-8')
    const diagnostics = new Map<string, LSPDiagnostic[]>([
      [`file://${TEST_DIR}/canvas/a.ts`, [diag(0, "Cannot find name 'A'.", 1, 2304)]],
      [`file://${TEST_DIR}/canvas/b.ts`, [diag(0, "Cannot find name 'B'.", 1, 2304)]],
      [`file://${TEST_DIR}/canvas/skipped.ts`, [diag(0, "Cannot find name 'Z'.", 1, 2304)]],
    ])
    const cache = new FileStateCache()
    cache.markEditedThisTurn('canvas/a.ts')
    cache.markEditedThisTurn('canvas/b.ts')
    const ctx = createCtx(createMockLSPManager(diagnostics), cache)
    const result = await execReadLints(ctx)
    expect(result.auto_scoped).toBe(true)
    expect(result.scoped_to.sort()).toEqual(['canvas/a.ts', 'canvas/b.ts'])
    expect(result.files).toHaveLength(2)
    const paths = result.files.map((f: any) => f.path).sort()
    expect(paths).toEqual(['canvas/a.ts', 'canvas/b.ts'])
  })

  test('auto-scope: no path + edited file with no diagnostics still reports it as ok', async () => {
    writeFileSync(join(TEST_DIR, 'canvas', 'clean.ts'), 'var x = 1', 'utf-8')
    const cache = new FileStateCache()
    cache.markEditedThisTurn('canvas/clean.ts')
    const ctx = createCtx(createMockLSPManager(new Map()), cache)
    const result = await execReadLints(ctx)
    expect(result.auto_scoped).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.scoped_to).toEqual(['canvas/clean.ts'])
    expect(result.files).toBeUndefined()
    expect(result.message).toContain('canvas/clean.ts')
  })

  test('explicit path overrides auto-scope', async () => {
    writeFileSync(join(TEST_DIR, 'canvas', 'edited.ts'), 'var x = E', 'utf-8')
    writeFileSync(join(TEST_DIR, 'canvas', 'requested.ts'), 'var y = R', 'utf-8')
    const diagnostics = new Map<string, LSPDiagnostic[]>([
      [`file://${TEST_DIR}/canvas/edited.ts`, [diag(0, "Cannot find name 'E'.", 1, 2304)]],
      [`file://${TEST_DIR}/canvas/requested.ts`, [diag(0, "Cannot find name 'R'.", 1, 2304)]],
    ])
    const cache = new FileStateCache()
    cache.markEditedThisTurn('canvas/edited.ts')
    const ctx = createCtx(createMockLSPManager(diagnostics), cache)
    const result = await execReadLints(ctx, { path: 'canvas/requested.ts' })
    expect(result.auto_scoped).toBeUndefined()
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('canvas/requested.ts')
  })

  test('resetTurn clears the auto-scope set', async () => {
    writeFileSync(join(TEST_DIR, 'canvas', 'touched.ts'), 'var x = 1', 'utf-8')
    const diagnostics = new Map<string, LSPDiagnostic[]>([
      [`file://${TEST_DIR}/canvas/touched.ts`, []],
      [`file://${TEST_DIR}/canvas/other.ts`, []],
    ])
    const cache = new FileStateCache()
    cache.markEditedThisTurn('canvas/touched.ts')
    expect(cache.getEditedThisTurn()).toEqual(['canvas/touched.ts'])

    cache.resetTurn()
    expect(cache.getEditedThisTurn()).toEqual([])

    const ctx = createCtx(createMockLSPManager(diagnostics), cache)
    const result = await execReadLints(ctx)
    expect(result.auto_scoped).toBeUndefined()
  })
})
