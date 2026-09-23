// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace file API against a real merged root, laid out the way the API's
 * RuntimeManager builds one for a folder-linked project:
 *
 *   merged/                     WORKSPACE_DIR
 *     AGENTS.md, files/         Shogo scaffolding
 *     project-1/  -> user/      the anchor mount (junction / dir symlink)
 *   user/                       the user's own repo
 *
 * The IDE addresses files with `?scope=project` in the project's path space
 * (what Source Control shows: `agents/BuildingBlocks/main_block.py`); the
 * agent-files panel and chat downloads use the default merged-root space.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  projectScopeRoot,
  resolveWithinRoot,
  scopeCanvasEvent,
  workspaceFileRoutes,
  workspaceRelativePath,
} from '../workspace-file-routes'

const DIR_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'
const ANCHOR = 'project-1'

let base: string
let merged: string
let user: string
let filesDir: string
let written: Array<[string, string]>
let deleted: string[]
let app: ReturnType<typeof workspaceFileRoutes>

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'shogo-ws-file-routes-'))
  merged = join(base, 'merged')
  user = join(base, 'user')
  filesDir = join(merged, 'files')
  mkdirSync(join(user, 'agents', 'BuildingBlocks'), { recursive: true })
  writeFileSync(join(user, 'agents', 'BuildingBlocks', 'main_block.py'), 'print("hello")\n')
  writeFileSync(join(user, 'app.py'), 'app = 1\n')
  mkdirSync(filesDir, { recursive: true })
  writeFileSync(join(filesDir, 'upload.txt'), 'uploaded\n')
  writeFileSync(join(merged, 'AGENTS.md'), '# agents\n')
  symlinkSync(user, join(merged, ANCHOR), DIR_LINK_TYPE)
  // A sibling whose name extends the merged root's: `startsWith(root)` alone admits it.
  mkdirSync(`${merged}-evil`, { recursive: true })
  writeFileSync(join(`${merged}-evil`, 'secret.txt'), 'secret\n')
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

beforeEach(() => {
  written = []
  deleted = []
  app = workspaceFileRoutes({
    workspaceDir: merged,
    filesDir,
    getProjectRoot: () => projectScopeRoot(merged, ANCHOR),
    onFileWritten: (rel, abs) => written.push([rel, abs]),
    onFileDeleted: (rel) => deleted.push(rel),
  })
})

const request = (path: string, init?: RequestInit) => app.fetch(new Request(`http://runtime${path}`, init))
const encode = (p: string) => p.split('/').map(encodeURIComponent).join('/')

describe('?scope=project (the IDE path space)', () => {
  test('tree is rooted at the project, not the merged root', async () => {
    const res = await request('/agent/workspace/tree?scope=project')
    expect(res.status).toBe(200)
    const { tree } = (await res.json()) as { tree: Array<{ name: string; path: string; type: string }> }
    const names = tree.map((n) => n.name).sort()
    expect(names).toEqual(['agents', 'app.py'])
    expect(tree.find((n) => n.name === 'agents')).toEqual(expect.objectContaining({ type: 'directory', path: 'agents' }))
  })

  test('lazy subtree paths stay project-relative', async () => {
    const res = await request('/agent/workspace/tree?scope=project&path=agents')
    const { tree } = (await res.json()) as { tree: Array<{ name: string; path: string }> }
    expect(tree.map((n) => n.path)).toEqual(['agents/BuildingBlocks'])
  })

  test('reads a file by the path Source Control reports', async () => {
    const res = await request(`/agent/workspace/files/${encode('agents/BuildingBlocks/main_block.py')}?scope=project`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { content: string }).content).toBe('print("hello")\n')
  })

  test('a missing project path is a 404, not a fallback into files/', async () => {
    const res = await request('/agent/workspace/files/upload.txt?scope=project')
    expect(res.status).toBe(404)
  })

  test('writes land in the user folder and are reported in the merged-root path space', async () => {
    const res = await request('/agent/workspace/files/src/new.ts?scope=project', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'export {}\n' }),
    })
    expect(res.status).toBe(200)
    expect(readFileSync(join(user, 'src', 'new.ts'), 'utf8')).toBe('export {}\n')
    expect(existsSync(join(merged, 'src'))).toBe(false)
    expect(written.map(([rel]) => rel)).toEqual([`${ANCHOR}/src/new.ts`])
  })

  test('mkdir creates the folder in the project, not in files/', async () => {
    const res = await request('/agent/workspace/mkdir?scope=project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'docs/guides' }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(user, 'docs', 'guides'))).toBe(true)
    expect(existsSync(join(filesDir, 'docs'))).toBe(false)
  })

  test('delete removes the project file', async () => {
    writeFileSync(join(user, 'tmp.txt'), 'x')
    const res = await request('/agent/workspace/files/tmp.txt?scope=project', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(existsSync(join(user, 'tmp.txt'))).toBe(false)
    expect(deleted).toEqual([`${ANCHOR}/tmp.txt`])
  })

  test('download serves project bytes', async () => {
    const res = await request('/agent/workspace/download/app.py?scope=project')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('app = 1\n')
  })
})

describe('default (merged-root) path space', () => {
  test('lists the anchor mount as a directory', async () => {
    const res = await request('/agent/workspace/tree')
    const { tree } = (await res.json()) as { tree: Array<{ name: string; type: string }> }
    expect(tree.find((n) => n.name === ANCHOR)?.type).toBe('directory')
  })

  test('keeps the files/ fallback for agent-files panel paths', async () => {
    const res = await request('/agent/workspace/files/upload.txt')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { content: string }).content).toBe('uploaded\n')
  })

  test('mkdir still resolves under files/', async () => {
    const res = await request('/agent/workspace/mkdir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'reports' }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(filesDir, 'reports'))).toBe(true)
  })
})

describe('directories are rejected cleanly', () => {
  test.each([
    ['GET', `/agent/workspace/files/${ANCHOR}`],
    ['GET', `/agent/workspace/download/${ANCHOR}`],
    ['DELETE', `/agent/workspace/files/${ANCHOR}`],
    ['GET', '/agent/workspace/files/agents?scope=project'],
  ])('%s %s -> 400', async (method, path) => {
    const res = await request(path, { method })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Path is a directory')
  })

  test('PUT onto a directory -> 400 and the directory survives', async () => {
    const res = await request('/agent/workspace/files/agents?scope=project', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    })
    expect(res.status).toBe(400)
    expect(existsSync(join(user, 'agents', 'BuildingBlocks', 'main_block.py'))).toBe(true)
  })
})

describe('resolveWithinRoot', () => {
  test('rejects a sibling directory whose name extends the root', () => {
    expect(resolveWithinRoot(merged, '../merged-evil/secret.txt')).toBeNull()
  })

  test('rejects parent traversal and accepts descendants', () => {
    expect(resolveWithinRoot(merged, '../user/app.py')).toBeNull()
    expect(resolveWithinRoot(merged, 'files/upload.txt')).toBe(join(merged, 'files', 'upload.txt'))
  })

  test.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'is case-insensitive where the filesystem is',
    () => {
      expect(resolveWithinRoot(merged.toUpperCase(), 'files/upload.txt')).not.toBeNull()
    },
  )
})

describe('projectScopeRoot', () => {
  test('is the anchor mount on a workspace runtime', () => {
    expect(projectScopeRoot(merged, ANCHOR)).toBe(join(merged, ANCHOR))
  })

  test('falls back to the workspace dir without an anchor or before its mount exists', () => {
    expect(projectScopeRoot(merged, undefined)).toBe(merged)
    expect(projectScopeRoot(merged, 'not-mounted-yet')).toBe(merged)
  })
})

describe('scopeCanvasEvent', () => {
  const prefix = () => workspaceRelativePath(merged, join(merged, ANCHOR))

  test('the scope prefix of the anchor mount is its mount name', () => {
    expect(prefix()).toBe(ANCHOR)
  })

  test('strips the project prefix from file events inside the project', () => {
    expect(scopeCanvasEvent({ type: 'file.changed', path: `${ANCHOR}/src/a.ts`, mtime: 1 }, prefix()))
      .toEqual({ type: 'file.changed', path: 'src/a.ts', mtime: 1 })
    expect(scopeCanvasEvent({ type: 'file.deleted', path: `${ANCHOR}/b.ts` }, prefix()))
      .toEqual({ type: 'file.deleted', path: 'b.ts' })
  })

  test('drops file events outside the project, including a sibling sharing the prefix', () => {
    expect(scopeCanvasEvent({ type: 'file.changed', path: 'AGENTS.md', mtime: 1 }, prefix())).toBeNull()
    expect(scopeCanvasEvent({ type: 'file.changed', path: `${ANCHOR}-2/a.ts`, mtime: 1 }, prefix())).toBeNull()
  })

  test('passes non-file events and unscoped streams through', () => {
    expect(scopeCanvasEvent({ type: 'reload' }, prefix())).toEqual({ type: 'reload' })
    const event = { type: 'file.changed' as const, path: 'AGENTS.md', mtime: 1 }
    expect(scopeCanvasEvent(event, '')).toBe(event)
  })
})
