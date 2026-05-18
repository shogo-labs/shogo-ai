// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the `WORKING_MODE === 'external'` branch in
 * `seedWorkspaceDefaults`.
 *
 * Why this matters: in external (VS Code-style) mode the user's folder
 * IS the workspace. Seeding our managed template files (App.tsx,
 * package.json, README.md, …) into that folder would either overwrite
 * the user's scaffold or pollute a clean repo. The branch under test
 * MUST only create `.shogo/{skills,plans,local}` and nothing else.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { seedWorkspaceDefaults } from '../workspace-defaults'

describe('seedWorkspaceDefaults — WORKING_MODE=external', () => {
  let dir: string
  let originalMode: string | undefined

  beforeEach(() => {
    originalMode = process.env.WORKING_MODE
    process.env.WORKING_MODE = 'external'
    dir = mkdtempSync(join(tmpdir(), 'shogo-extseed-'))
  })

  afterEach(() => {
    if (originalMode === undefined) delete process.env.WORKING_MODE
    else process.env.WORKING_MODE = originalMode
    rmSync(dir, { recursive: true, force: true })
  })

  test('creates .shogo/{skills,plans,local} and nothing else', () => {
    seedWorkspaceDefaults(dir)

    const top = readdirSync(dir)
    expect(top).toEqual(['.shogo'])

    const shogo = readdirSync(join(dir, '.shogo')).sort()
    expect(shogo).toEqual(['local', 'plans', 'skills'])
  })

  test('does NOT write any managed template files (App.tsx, package.json, README.md, …)', () => {
    seedWorkspaceDefaults(dir)
    const forbidden = ['package.json', 'README.md', 'App.tsx', 'index.html', 'vite.config.ts']
    for (const f of forbidden) {
      expect(existsSync(join(dir, f))).toBe(false)
    }
  })

  test('does NOT create a `memory/` directory (managed-mode-only convention)', () => {
    seedWorkspaceDefaults(dir)
    expect(existsSync(join(dir, 'memory'))).toBe(false)
  })

  test('idempotent: running twice is a no-op', () => {
    seedWorkspaceDefaults(dir)
    const firstTop = readdirSync(dir).sort()
    seedWorkspaceDefaults(dir)
    const secondTop = readdirSync(dir).sort()
    expect(secondTop).toEqual(firstTop)
  })
})
