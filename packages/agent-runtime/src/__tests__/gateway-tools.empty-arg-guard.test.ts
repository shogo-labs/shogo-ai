// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-223 — the empty-argument guard against the *real* gateway schemas, through
 * the real wrapper.
 *
 * QA round 1 caught that a blanket "required string must not be empty" rule broke
 * three documented calls: `edit_file` with `old_string: ""` creates a file,
 * `edit_file` with `new_string: ""` deletes text, and `write_file` with
 * `content: ""` writes an empty file. Those three properties declare
 * `'x-empty-ok': true` in their schema and the guard skips them; everything else
 * still rejects a lost argument.
 *
 * These calls go through `wrapToolsWithOrchestration`, which the existing
 * edit_file tests do not (they call `execute` directly, which is why they missed
 * the regression).
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync } from 'fs'
import { createTools, type ToolContext } from '../gateway-tools'
// The wrapper is imported from SDK *source*, not `@shogo-ai/sdk/tool-orchestration`:
// that subpath resolves to `packages/sdk/dist` (a build artifact, stale in a dev
// checkout), and the guard under test lives in source. Everything else here
// (gateway-tools, trust helpers) is source too.
import { wrapToolsWithOrchestration } from '../../../agent/src/tool-orchestration'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-empty-arg-guard'

function makeCtx(): ToolContext {
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
  }
}

/** Every gateway tool, wrapped exactly as the agent loop wraps them. */
function wrappedTools(ctx: ToolContext) {
  const { tools } = wrapToolsWithOrchestration(createTools(ctx))
  const byName = (name: string) => {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`Tool not found: ${name}`)
    return tool
  }
  return {
    run: async (name: string, params: Record<string, any>) => {
      const result = await byName(name).execute('test-call', params)
      return { details: result.details as Record<string, any>, content: result.content }
    },
    byName,
  }
}

describe('empty-argument guard vs the real gateway schemas', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })

  afterAll(() => clearTrustForTests())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('edit_file with old_string: "" still creates the file', async () => {
    const { run } = wrappedTools(makeCtx())

    const result = await run('edit_file', { path: 'created.txt', old_string: '', new_string: 'fresh content\n' })

    expect(result.details.ok).toBe(true)
    expect(result.details.created).toBe(true)
    expect(existsSync(`${TEST_DIR}/created.txt`)).toBe(true)
    expect(readFileSync(`${TEST_DIR}/created.txt`, 'utf-8')).toBe('fresh content\n')
  })

  test('edit_file with new_string: "" still deletes the matched text', async () => {
    writeFileSync(`${TEST_DIR}/del.txt`, 'KEEP\nDROP ME\n')
    const { run } = wrappedTools(makeCtx())
    await run('read_file', { path: 'del.txt' })

    const result = await run('edit_file', { path: 'del.txt', old_string: 'DROP ME\n', new_string: '' })

    expect(result.details.ok).toBe(true)
    expect(readFileSync(`${TEST_DIR}/del.txt`, 'utf-8')).toBe('KEEP\n')
  })

  test('write_file with content: "" still writes an empty file', async () => {
    const { run } = wrappedTools(makeCtx())

    const result = await run('write_file', { path: 'empty.txt', content: '' })

    expect(result.details.ok).toBe(true)
    expect(existsSync(`${TEST_DIR}/empty.txt`)).toBe(true)
    expect(statSync(`${TEST_DIR}/empty.txt`).size).toBe(0)
  })

  test('a blank required argument that is NOT exempt is still rejected', async () => {
    const { byName } = wrappedTools(makeCtx())

    // exec: the call that started this card. It must not reach the shell.
    await expect(byName('exec').execute('test-call', { command: '' })).rejects.toThrow(
      /exec: required argument 'command' was empty/,
    )
    // read_file.path has no exemption either.
    await expect(byName('read_file').execute('test-call', { path: '' })).rejects.toThrow(
      /read_file: required argument 'path' was empty/,
    )
    // edit_file.path is required and blank — the exemption is per property.
    await expect(
      byName('edit_file').execute('test-call', { path: '', old_string: '', new_string: 'x' }),
    ).rejects.toThrow(/edit_file: required argument 'path' was empty/)

    // And the rejected call created nothing.
    expect(readdirSync(TEST_DIR)).toEqual([])
  })
})
