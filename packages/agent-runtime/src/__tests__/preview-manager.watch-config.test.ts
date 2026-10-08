// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The generated `.shogo/vite.watch.config.ts` must keep `.shogo/` out of
// `vite build --watch`. Every rebuild writes runtime state there, so a
// watched `.shogo/` file turns the watcher into a continuous rebuild loop.
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreviewManager } from '../preview-manager'

describe('ensureViteWatchConfig', () => {
  let root: string | null = null

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
  })

  test('excludes .shogo/ from the build watcher, not just the dev server', () => {
    root = mkdtempSync(join(tmpdir(), 'shogo-vite-watch-config-'))
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    const configPath: string = (pm as any).ensureViteWatchConfig(root)
    const source = readFileSync(configPath, 'utf-8')

    expect(configPath).toBe(join(root, '.shogo', 'vite.watch.config.ts'))
    expect(source).toMatch(/build:\s*\{\s*watch:\s*\{\s*exclude:\s*\['\*\*\/\.shogo\/\*\*'\]/)
    expect(source).toMatch(/server:\s*\{\s*watch:\s*\{\s*ignored:\s*\['\*\*\/\.shogo\/\*\*'\]/)
  })
})
