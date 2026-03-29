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

function createCtx(lspManager?: WorkspaceLSPManager): ToolContext {
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
    expect(result.files[0].ok).toBe(true)
    expect(result.files[0].errors).toHaveLength(0)
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
    expect(result.files).toHaveLength(2)
    const goodFile = result.files.find((f: any) => f.path.includes('good'))
    const badFile = result.files.find((f: any) => f.path.includes('bad'))
    expect(goodFile.ok).toBe(true)
    expect(badFile.ok).toBe(false)
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
    expect(result.files[0].ok).toBe(true)
    expect(result.files[0].errors).toHaveLength(0)
  })

  test('read_lints tool exists in createTools output', () => {
    const ctx = createCtx(createMockLSPManager())
    const tools = createTools(ctx)
    const tool = tools.find(t => t.name === 'read_lints')
    expect(tool).toBeTruthy()
    expect(tool!.description).toContain('TypeScript')
  })
})
