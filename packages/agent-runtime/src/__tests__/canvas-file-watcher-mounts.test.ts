// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The canvas watcher runs on the merged root with `followSymlinks: false`, so
 * edits made on disk inside a mounted project / linked folder (agent `exec`,
 * an external editor, `git checkout`) are only seen through the per-mount
 * watchers. Events must come out in the merged-root path space
 * (`<mount>/<path>`), which is what `?scope=project` streams then re-scope.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasFileWatcher, type CanvasEvent } from '../canvas-file-watcher'

const DIR_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

let base: string
let merged: string
let user: string
let watcher: CanvasFileWatcher

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'shogo-watcher-mounts-'))
  merged = join(base, 'merged')
  user = join(base, 'user')
  mkdirSync(join(user, 'src'), { recursive: true })
  mkdirSync(merged, { recursive: true })
  symlinkSync(user, join(merged, 'project-1'), DIR_LINK_TYPE)
  watcher = new CanvasFileWatcher(merged)
  await watcher.addMountRoot(user, 'project-1')
  // Idempotent per mount name.
  await watcher.addMountRoot(user, 'project-1')
  // chokidar needs a moment to finish its initial scan before it reports changes.
  await new Promise((r) => setTimeout(r, 750))
})

afterAll(() => {
  watcher.close()
  rmSync(base, { recursive: true, force: true })
})

function nextEvent(predicate: (e: CanvasEvent) => boolean, timeoutMs = 10_000): Promise<CanvasEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.unsubscribe(handler)
      reject(new Error('timed out waiting for watcher event'))
    }, timeoutMs)
    const handler = (event: CanvasEvent) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      watcher.unsubscribe(handler)
      resolve(event)
    }
    watcher.subscribe(handler)
  })
}

describe('CanvasFileWatcher mount roots', () => {
  test('an on-disk edit inside a mounted folder is reported under the mount name', async () => {
    const seen = nextEvent((e) => e.type === 'file.changed' && e.path === 'project-1/src/added.ts')
    writeFileSync(join(user, 'src', 'added.ts'), 'export const a = 1\n')
    await expect(seen).resolves.toEqual(expect.objectContaining({ type: 'file.changed', path: 'project-1/src/added.ts' }))
  })

  test('ignored paths inside the mount stay ignored', async () => {
    const events: CanvasEvent[] = []
    const handler = (e: CanvasEvent) => events.push(e)
    watcher.subscribe(handler)
    mkdirSync(join(user, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(user, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    const marker = nextEvent((e) => e.type === 'file.changed' && e.path === 'project-1/marker.txt')
    writeFileSync(join(user, 'marker.txt'), 'x')
    await marker
    watcher.unsubscribe(handler)
    expect(events.some((e) => 'path' in e && e.path.includes('node_modules'))).toBe(false)
  })
})
