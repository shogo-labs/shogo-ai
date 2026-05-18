// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 4b — gateway-tools pure helpers + small-surface tools.
 *
 *   - `hostToContainer` / `containerToHost` — exported path translators
 *     (2 happy + 2 fallback branches each).
 *   - `bogusPathPrefixHint` — reachable through `read_file` /
 *     `delete_file` "File not found" branches. The model frequently
 *     hallucinates `project/src/...` / `workspace/src/...`; the hint
 *     turns the mistake into a one-shot fix.
 *   - `createDeleteFileTool` — outside-files traversal guard, missing-
 *     file branch, happy path.
 *   - `textResult` — wraps result in `details` + `content`.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

import {
  createTools,
  textResult,
  hostToContainer,
  containerToHost,
  type ToolContext,
} from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-helpers'

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

async function runTool(ctx: ToolContext, name: string, params: any) {
  const tool = createTools(ctx).find(t => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  const result = await tool.execute('call-1', params)
  return result.details
}

describe('hostToContainer / containerToHost', () => {
  test('hostToContainer translates a host path under workspaceDir to /workspace/...', () => {
    expect(hostToContainer('/home/user/proj/src/App.tsx', '/home/user/proj'))
      .toBe('/workspace/src/App.tsx')
  })

  test('hostToContainer for the workspaceDir itself maps to /workspace', () => {
    expect(hostToContainer('/home/user/proj', '/home/user/proj')).toBe('/workspace')
  })

  test('hostToContainer for an unrelated host path falls back to /workspace', () => {
    expect(hostToContainer('/tmp/foreign', '/home/user/proj')).toBe('/workspace')
  })

  test('containerToHost translates /workspace/... back to the host path', () => {
    expect(containerToHost('/workspace/src/App.tsx', '/home/user/proj'))
      .toBe('/home/user/proj/src/App.tsx')
  })

  test('containerToHost for bare /workspace returns workspaceDir', () => {
    expect(containerToHost('/workspace', '/home/user/proj')).toBe('/home/user/proj')
  })

  test('containerToHost for non-/workspace path returns workspaceDir', () => {
    expect(containerToHost('/etc/passwd', '/home/user/proj')).toBe('/home/user/proj')
  })

  test('round-trip is stable for paths inside workspaceDir', () => {
    const ws = '/var/data/proj'
    const host = '/var/data/proj/a/b/c.txt'
    expect(containerToHost(hostToContainer(host, ws), ws)).toBe(host)
  })
})

describe('textResult', () => {
  test('emits { details, content: [{ type: text, text: JSON }] }', () => {
    const r = textResult({ ok: true, n: 42 })
    expect(r.details).toEqual({ ok: true, n: 42 })
    expect(Array.isArray(r.content)).toBe(true)
    expect((r.content as any)[0].type).toBe('text')
    expect(JSON.parse((r.content as any)[0].text)).toEqual({ ok: true, n: 42 })
  })

  test('handles error payloads identically (no special-case)', () => {
    const r = textResult({ error: 'boom' })
    expect(r.details).toEqual({ error: 'boom' })
  })
})

describe('bogusPathPrefixHint via read_file File-not-found branch', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))
  afterAll(() => clearTrustForTests())

  test('"project/" prefix where stripped file exists → hint points to stripped path', async () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src/App.tsx'), 'export default 1\n')
    const ctx = makeCtx()
    const r = await runTool(ctx, 'read_file', { path: 'project/src/App.tsx' })
    expect(r.error).toContain('File not found')
    expect(r.error).toContain('Drop the "project/"')
    expect(r.error).toContain('src/App.tsx')
  })

  test('"workspace/" prefix is also recognised', async () => {
    mkdirSync(join(TEST_DIR, 'lib'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'lib/helper.ts'), 'export const x = 1\n')
    const ctx = makeCtx()
    const r = await runTool(ctx, 'read_file', { path: 'workspace/lib/helper.ts' })
    expect(r.error).toContain('Drop the "workspace/"')
    expect(r.error).toContain('lib/helper.ts')
  })

  test('"app/" / "pod/" / "repo/" prefixes recognised when stripped file exists', async () => {
    writeFileSync(join(TEST_DIR, 'README.md'), '# hi\n')
    const ctx = makeCtx()
    for (const prefix of ['app/', 'pod/', 'repo/']) {
      const r = await runTool(ctx, 'read_file', { path: `${prefix}README.md` })
      expect(r.error).toContain(`Drop the "${prefix}"`)
    }
  })

  test('bogus prefix BUT stripped file also missing → no hint (plain File not found)', async () => {
    const ctx = makeCtx()
    const r = await runTool(ctx, 'read_file', { path: 'project/nope.ts' })
    expect(r.error).toBe('File not found: project/nope.ts')
    expect(r.error).not.toContain('Drop the')
  })

  test('non-bogus path also returns plain File not found (no hint)', async () => {
    const ctx = makeCtx()
    const r = await runTool(ctx, 'read_file', { path: 'src/missing.ts' })
    expect(r.error).toBe('File not found: src/missing.ts')
    expect(r.error).not.toContain('Hint:')
  })

  test('bare prefix (just "project/") with no remainder → no hint', async () => {
    const ctx = makeCtx()
    const r = await runTool(ctx, 'read_file', { path: 'project/' })
    expect(r.error).toContain('File not found')
    expect(r.error).not.toContain('Drop the')
  })
})

describe('createDeleteFileTool', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(join(TEST_DIR, 'files'), { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))
  afterAll(() => clearTrustForTests())

  test('happy path: deletes a file under files/ and reports the relative path', async () => {
    writeFileSync(join(TEST_DIR, 'files/notes.txt'), 'hi\n')
    const ctx = makeCtx()
    const r = await runTool(ctx, 'delete_file', { path: 'notes.txt' })
    expect(r.ok).toBe(true)
    expect(r.deleted).toBe('notes.txt')
    expect(existsSync(join(TEST_DIR, 'files/notes.txt'))).toBe(false)
  })

  test('traversal attempt (../) is rejected before unlink runs', async () => {
    writeFileSync(join(TEST_DIR, 'sensitive.txt'), 'shh\n')
    const ctx = makeCtx()
    const r = await runTool(ctx, 'delete_file', { path: '../sensitive.txt' })
    expect(r.error).toBe('Path outside files directory')
    expect(existsSync(join(TEST_DIR, 'sensitive.txt'))).toBe(true)
  })

  test('missing file under files/ → File not found, no hint for plain path', async () => {
    const ctx = makeCtx()
    const r = await runTool(ctx, 'delete_file', { path: 'ghost.txt' })
    expect(r.error).toBe('File not found: ghost.txt')
  })

  test('missing file with bogus prefix where stripped exists at workspace root → hint included', async () => {
    writeFileSync(join(TEST_DIR, 'README.md'), '# hi\n')
    const ctx = makeCtx()
    const r = await runTool(ctx, 'delete_file', { path: 'project/README.md' })
    expect(r.error).toContain('File not found')
    expect(r.error).toContain('Drop the "project/"')
  })
})
