// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `read_file` / `edit_file` / `delete_file` not-found path-prefix hint.
 *
 * The model frequently hallucinates a `project/`, `workspace/`, `app/`,
 * etc. prefix when the workspace root IS its CWD. A bare `File not
 * found` then costs an extra exploration round trip. These tests pin
 * the hint that points the model at the path with the bogus prefix
 * stripped — but only when that stripped path actually exists.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createTools } from '../gateway-tools'

const TEST_DIR = '/tmp/test-path-prefix-hint'

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
  writeFileSync(join(TEST_DIR, 'src', 'App.tsx'), 'export default function App() {}\n')
  writeFileSync(join(TEST_DIR, 'custom-routes.ts'), '// routes\n')
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

function ctx() {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: { heartbeatInterval: 1800, heartbeatEnabled: false, channels: [] },
    projectId: 'test',
  } as any
}

function getTool(name: string) {
  const t = createTools(ctx()).find(t => t.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

async function runTool(name: string, params: Record<string, unknown>) {
  const t = getTool(name)
  const res = await t.execute('call-1', params)
  return JSON.parse((res.content[0] as any).text)
}

describe('read_file File not found — path-prefix hint', () => {
  test('project/<existing> → hint suggests stripped path', async () => {
    const data = await runTool('read_file', { path: 'project/src/App.tsx' })
    expect(data.error).toContain('File not found: project/src/App.tsx')
    expect(data.error).toContain('"src/App.tsx"')
    expect(data.error).toContain('Drop the "project/" prefix')
  })

  test('workspace/<existing> → hint suggests stripped path', async () => {
    const data = await runTool('read_file', { path: 'workspace/custom-routes.ts' })
    expect(data.error).toContain('"custom-routes.ts"')
    expect(data.error).toContain('Drop the "workspace/" prefix')
  })

  test('app/<existing> → hint suggests stripped path', async () => {
    const data = await runTool('read_file', { path: 'app/src/App.tsx' })
    expect(data.error).toContain('"src/App.tsx"')
  })

  test('bogus prefix but stripped path also missing → no hint', async () => {
    const data = await runTool('read_file', { path: 'project/does-not-exist.ts' })
    expect(data.error).toBe('File not found: project/does-not-exist.ts')
    expect(data.error).not.toContain('Hint:')
  })

  test('bare missing path with no bogus prefix → no hint', async () => {
    const data = await runTool('read_file', { path: 'totally-missing.ts' })
    expect(data.error).toBe('File not found: totally-missing.ts')
    expect(data.error).not.toContain('Hint:')
  })

  test('valid path still reads normally (no false-positive hint)', async () => {
    const data = await runTool('read_file', { path: 'src/App.tsx' })
    expect(data.error).toBeUndefined()
    expect(data.content).toContain('export default function App')
  })
})

describe('edit_file File not found — path-prefix hint', () => {
  test('project/<existing> → hint when old_string non-empty (cannot create)', async () => {
    const data = await runTool('edit_file', {
      path: 'project/src/App.tsx',
      old_string: 'something',
      new_string: 'else',
    })
    expect(data.error).toContain('File not found: project/src/App.tsx')
    expect(data.error).toContain('Drop the "project/" prefix')
  })
})

describe('delete_file File not found — path-prefix hint', () => {
  test('workspace/<existing> → hint suggests stripped path', async () => {
    const data = await runTool('delete_file', { path: 'workspace/custom-routes.ts' })
    expect(data.error).toContain('File not found: workspace/custom-routes.ts')
    expect(data.error).toContain('"custom-routes.ts"')
  })
})
