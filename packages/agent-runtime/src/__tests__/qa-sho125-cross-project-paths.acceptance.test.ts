// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-125 acceptance — §4a, end to end at the tool level.
 *
 * The reported failure (19×, incl. an external desktop user) was:
 *
 *   read_file { project: "Shogo Dev 1", path: "MEMORY.md" }
 *   → HTTP 500 — Path is outside the project's allowed folders: MEMORY.md
 *
 * A project runtime's `WORKSPACE_DIR` is `<ws>/.workspace-roots/proj-<id>/<id>`,
 * a symlink onto `<ws>/workspaces/<id>`, and `LINKED_FOLDERS` carries the real
 * path. So this test builds exactly that layout — a symlinked workspace dir
 * whose real root is also an allowed root — and drives the *tools*, not the
 * guard helpers, because the guard helpers passing is not what the user saw.
 *
 * On `main` before this branch every case below that should succeed throws
 * `Path is outside the project's allowed folders`. The deny cases must keep
 * failing with the same messages they always did.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const ROOT = '/tmp/qa-sho125-accept'
const PROJECT_ID = '11111111-2222-4333-8444-555555555555'
const REAL_DIR = join(ROOT, 'real', PROJECT_ID)
// The symlink a project runtime really boots with.
const SYMLINKED_DIR = join(ROOT, '.workspace-roots', `proj-${PROJECT_ID}`, PROJECT_ID)

function makeCtx(): ToolContext {
  return {
    workspaceDir: SYMLINKED_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
    fileStateCache: new FileStateCache(SYMLINKED_DIR),
  } as ToolContext
}

/**
 * A refused path surfaces as a thrown error from the tool (the guard runs
 * before the tool body), so a deny case is an `error` in this shape and an
 * allow case is the tool's own details.
 */
async function run(ctx: ToolContext, name: string, params: Record<string, any>) {
  const tool = createTools(ctx).find((x) => x.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  try {
    const result = await tool.execute('qa-sho125', params)
    return result.details as Record<string, any>
  } catch (err: any) {
    return { error: String(err?.message ?? err) }
  }
}

describe('SHO-125 §4a — relative paths work in a project runtime whose WORKSPACE_DIR is a symlink', () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(REAL_DIR, { recursive: true })
    mkdirSync(join(ROOT, '.workspace-roots', `proj-${PROJECT_ID}`), { recursive: true })
    symlinkSync(REAL_DIR, SYMLINKED_DIR)
    // Outside the project, for the deny cases.
    mkdirSync(join(ROOT, 'outside'), { recursive: true })
    writeFileSync(join(ROOT, 'outside', 'secret.txt'), 'do not read me\n')
    // A sibling whose name prefixes the project id — the classic lexical bypass.
    mkdirSync(`${REAL_DIR}-evil`, { recursive: true })
    writeFileSync(join(`${REAL_DIR}-evil`, 'secret.txt'), 'sibling\n')
    writeFileSync(join(REAL_DIR, 'MEMORY.md'), '# MEMORY\n\nsho-125 canary line\n')
    // A real project runtime carries its members' *real* paths in LINKED_FOLDERS
    // (workspace-members.ts maintains it) — that is what selects the union-of-roots
    // branch in assertWithinWorkspace, so a test without it measures nothing.
    process.env.LINKED_FOLDERS = JSON.stringify([REAL_DIR])
    // Sanity: the layout really is the one the bug needed.
    expect(realpathSync(SYMLINKED_DIR)).toBe(realpathSync(REAL_DIR))
    trustWorkspaceForTests(SYMLINKED_DIR, { linkedFolders: [REAL_DIR] })
  })

  afterEach(() => {
    delete process.env.LINKED_FOLDERS
    clearTrustForTests()
    rmSync(ROOT, { recursive: true, force: true })
  })

  afterAll(() => {
    delete process.env.LINKED_FOLDERS
    clearTrustForTests()
    rmSync(ROOT, { recursive: true, force: true })
  })

  test('read_file { path: "MEMORY.md" } returns the file — the exact call from the report', async () => {
    const r = await run(makeCtx(), 'read_file', { path: 'MEMORY.md' })
    expect(r.error).toBeUndefined()
    expect(r.content).toContain('sho-125 canary line')
  })

  test('write_file creates a file in a new subdirectory, relative to the project', async () => {
    const r = await run(makeCtx(), 'write_file', { path: 'notes/new.txt', content: 'hello sho-125' })
    expect(r.error).toBeUndefined()
    expect(readFileSync(join(REAL_DIR, 'notes', 'new.txt'), 'utf8')).toBe('hello sho-125')
  })

  test('edit_file modifies that file by relative path', async () => {
    writeFileSync(join(REAL_DIR, 'notes-edit.txt'), 'before\n')
    const r = await run(makeCtx(), 'edit_file', {
      path: 'notes-edit.txt',
      old_string: 'before',
      new_string: 'after',
    })
    expect(r.error).toBeUndefined()
    expect(readFileSync(join(REAL_DIR, 'notes-edit.txt'), 'utf8')).toBe('after\n')
  })

  test('delete_file removes a file under files/ by relative path', async () => {
    mkdirSync(join(REAL_DIR, 'files'), { recursive: true })
    writeFileSync(join(REAL_DIR, 'files', 'tmp.txt'), 'x\n')
    const r = await run(makeCtx(), 'delete_file', { path: 'tmp.txt' })
    expect(r.error).toBeUndefined()
    expect(existsSync(join(REAL_DIR, 'files', 'tmp.txt'))).toBe(false)
  })

  test('absolute path inside the project still works', async () => {
    const r = await run(makeCtx(), 'read_file', { path: join(REAL_DIR, 'MEMORY.md') })
    expect(r.content).toContain('sho-125 canary line')
  })

  // ---- the denies must stay denies -------------------------------------

  test('../../etc/passwd is still refused', async () => {
    const r = await run(makeCtx(), 'read_file', { path: '../../../../etc/passwd' })
    expect(r.error).toContain("Path is outside the project's allowed folders")
  })

  test('an absolute path outside every root is still refused', async () => {
    const r = await run(makeCtx(), 'read_file', { path: join(ROOT, 'outside', 'secret.txt') })
    expect(r.error).toContain("Path is outside the project's allowed folders")
    expect(r.content).toBeUndefined()
  })

  test('a sibling directory whose name prefixes the project is still refused', async () => {
    const r = await run(makeCtx(), 'read_file', { path: join(`${REAL_DIR}-evil`, 'secret.txt') })
    expect(r.error).toContain("Path is outside the project's allowed folders")
  })

  test('a symlink inside the project pointing outside is still refused', async () => {
    symlinkSync(join(ROOT, 'outside', 'secret.txt'), join(REAL_DIR, 'escape.txt'))
    const r = await run(makeCtx(), 'read_file', { path: 'escape.txt' })
    expect(r.error).toContain('Symlink target outside allowed roots')
    expect(r.content).toBeUndefined()
  })

  test('writing through that escaping symlink is refused too', async () => {
    symlinkSync(join(ROOT, 'outside'), join(REAL_DIR, 'escape-dir'))
    const r = await run(makeCtx(), 'write_file', { path: 'escape-dir/pwned.txt', content: 'x' })
    expect(r.error).toContain('Symlink target outside allowed roots')
    expect(existsSync(join(ROOT, 'outside', 'pwned.txt'))).toBe(false)
  })
})
