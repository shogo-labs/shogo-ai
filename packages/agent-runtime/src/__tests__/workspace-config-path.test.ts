// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { resolveWorkspaceConfigFilePath } from '../workspace-defaults'

const TEST_DIR = '/tmp/test-workspace-config-path'

describe('resolveWorkspaceConfigFilePath', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('prefers workspace root over .shogo/', () => {
    writeFileSync(join(TEST_DIR, 'AGENTS.md'), 'root')
    mkdirSync(join(TEST_DIR, '.shogo'), { recursive: true })
    writeFileSync(join(TEST_DIR, '.shogo', 'AGENTS.md'), 'shogo')
    expect(resolveWorkspaceConfigFilePath(TEST_DIR, 'AGENTS.md')).toBe(join(TEST_DIR, 'AGENTS.md'))
  })

  test('falls back to .shogo/ when root file is missing', () => {
    mkdirSync(join(TEST_DIR, '.shogo'), { recursive: true })
    writeFileSync(join(TEST_DIR, '.shogo', 'AGENTS.md'), 'from-template')
    expect(resolveWorkspaceConfigFilePath(TEST_DIR, 'AGENTS.md')).toBe(join(TEST_DIR, '.shogo', 'AGENTS.md'))
  })

  test('returns null when file exists in neither location', () => {
    expect(resolveWorkspaceConfigFilePath(TEST_DIR, 'AGENTS.md')).toBeNull()
  })
})
