// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'

const TEST_DIR = '/tmp/test-gw-terminal-context'

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

async function run(ctx: ToolContext, params: Record<string, any> = {}) {
  const tool = createTools(ctx).find((t) => t.name === 'terminal_read')
  if (!tool) throw new Error('terminal_read not found')
  const result = await tool.execute('test-call', params)
  return result.details
}

describe('terminal_read desktop context bridge', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('prefers live desktop terminal context over saved files', async () => {
    const calls: Array<{ terminalId?: string; cwd?: string; maxChars?: number }> = []
    const result = await run(makeCtx({
      terminalRead: async (params) => {
        calls.push(params)
        return {
          source: 'desktop-pty',
          terminalId: 'term-1',
          cwd: TEST_DIR,
          content: 'bun test packages/agent-runtime/src/__tests__/gateway-tools.terminal-context.test.ts\npass',
          sessions: [{
            id: 'term-1',
            cwd: TEST_DIR,
            shell: '/bin/zsh',
            createdAt: 1,
            updatedAt: 2,
            exitedAt: null,
            bytes: 96,
            active: true,
          }],
          truncated: false,
        }
      },
    }))

    expect(calls).toEqual([{ cwd: TEST_DIR, maxChars: 24000, terminalId: undefined }])
    expect(result.source).toBe('desktop-pty')
    expect(result.terminalId).toBe('term-1')
    expect(result.content).toContain('bun test')
  })

  test('falls back to saved terminal files when no live context exists', async () => {
    const dir = join(TEST_DIR, '.shogo', 'terminals')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'terminal-old.txt'), '# Terminal terminal-old\n\n$ echo saved\nsaved\n', 'utf-8')

    const result = await run(makeCtx({
      terminalRead: async () => ({
        source: 'desktop-pty',
        terminalId: null,
        cwd: TEST_DIR,
        content: '',
        sessions: [],
        truncated: false,
      }),
    }))

    expect(result.terminalId).toBe('terminal-old')
    expect(result.content).toContain('echo saved')
  })

  test('falls back to saved terminal files when live bridge reports an empty error', async () => {
    const dir = join(TEST_DIR, '.shogo', 'terminals')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'terminal-error-fallback.txt'), '$ pwd\n/tmp/project\n', 'utf-8')

    const result = await run(makeCtx({
      terminalRead: async () => ({
        source: 'desktop-pty',
        terminalId: null,
        cwd: TEST_DIR,
        content: '',
        sessions: [],
        truncated: false,
        error: 'No desktop terminal sessions found.',
      }),
    }))

    expect(result.terminalId).toBe('terminal-error-fallback')
    expect(result.content).toContain('/tmp/project')
  })
})
