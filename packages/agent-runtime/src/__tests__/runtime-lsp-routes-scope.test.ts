// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `?scope=project`: the IDE addresses documents relative to its project. On a
 * workspace runtime that project is a mount below the LSP's workspace dir, so
 * paths must resolve against — and response URIs be rewritten relative to —
 * the project root, including when the language server reports files by the
 * real path behind a linked mount.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runtimeLspRoutes } from '../runtime-lsp-routes'

const DIR_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

let base: string
let merged: string
let user: string
let lastPath: string | null
let definitionUri: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'shogo-lsp-scope-'))
  merged = join(base, 'merged')
  user = join(base, 'user')
  mkdirSync(join(user, 'src'), { recursive: true })
  mkdirSync(merged, { recursive: true })
  symlinkSync(user, join(merged, 'proj-1'), DIR_LINK_TYPE)
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

function makeApp() {
  lastPath = null
  const lsp = {
    isTSReady: () => true,
    didOpenDocument: (path: string) => { lastPath = path },
    definition: async (path: string) => {
      lastPath = path
      return [{ uri: definitionUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    },
  }
  return runtimeLspRoutes({
    workspaceDir: merged,
    getLspManager: () => lsp as any,
    getProjectRoot: () => join(merged, 'proj-1'),
  })
}

async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown) {
  const res = await app.fetch(new Request(`http://t${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

describe('runtime LSP routes with ?scope=project', () => {
  test('resolves document paths against the project root', async () => {
    const app = makeApp()
    const r = await post(app, '/agent/lsp/didOpen?scope=project', { path: 'src/a.ts', text: 'x' })
    expect(r.status).toBe(200)
    expect(lastPath).toBe(join(merged, 'proj-1', 'src', 'a.ts'))
  })

  test('unscoped requests keep resolving against the workspace dir', async () => {
    const app = makeApp()
    await post(app, '/agent/lsp/didOpen', { path: 'proj-1/src/a.ts', text: 'x' })
    expect(lastPath).toBe(join(merged, 'proj-1', 'src', 'a.ts'))
  })

  test('rewrites result URIs reported by real path to project-relative paths', async () => {
    definitionUri = decodeURIComponent(pathToFileURL(join(user, 'src', 'b.ts')).href).replace(/^file:\/\/\//, 'file://')
    const app = makeApp()
    const r = await post(app, '/agent/lsp/definition?scope=project', { path: 'src/a.ts', line: 0, character: 0 })
    expect(r.status).toBe(200)
    expect(r.json.result[0].uri).toBe('src/b.ts')
  })
})
