// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  getRuntimeTemplatePath,
  seedRuntimeTemplate,
  seedWorkspaceDefaults,
  ensureWorkspaceDeps,
} from '../workspace-defaults'

const TEST_DIR = '/tmp/test-workspace-seeding'

// ---------------------------------------------------------------------------
// getRuntimeTemplatePath — resolution across environments
// ---------------------------------------------------------------------------

describe('getRuntimeTemplatePath', () => {
  const originalEnv = process.env.RUNTIME_TEMPLATE_DIR

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RUNTIME_TEMPLATE_DIR
    } else {
      process.env.RUNTIME_TEMPLATE_DIR = originalEnv
    }
  })

  test('returns non-null in local dev (source tree has templates/runtime-template)', () => {
    delete process.env.RUNTIME_TEMPLATE_DIR
    const result = getRuntimeTemplatePath()
    expect(result).not.toBeNull()
    expect(existsSync(join(result!, 'package.json'))).toBe(true)
  })

  test('RUNTIME_TEMPLATE_DIR env override takes precedence', () => {
    const fakeDir = '/tmp/test-runtime-template-override'
    rmSync(fakeDir, { recursive: true, force: true })
    mkdirSync(fakeDir, { recursive: true })
    writeFileSync(join(fakeDir, 'package.json'), '{}')

    process.env.RUNTIME_TEMPLATE_DIR = fakeDir
    const result = getRuntimeTemplatePath()
    expect(result).toBe(fakeDir)

    rmSync(fakeDir, { recursive: true, force: true })
  })

  test('returns null when RUNTIME_TEMPLATE_DIR points to nonexistent dir', () => {
    process.env.RUNTIME_TEMPLATE_DIR = '/tmp/nonexistent-template-dir'
    // Still falls through to other candidates. In dev, the source tree candidate
    // will match. This test validates the env override doesn't crash when missing.
    const result = getRuntimeTemplatePath()
    // Should still find the source tree candidate in local dev
    expect(result).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// seedRuntimeTemplate — workspace completeness
// ---------------------------------------------------------------------------

describe('seedRuntimeTemplate', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('seeds all essential files into empty workspace', () => {
    const result = seedRuntimeTemplate(TEST_DIR)
    expect(result).toBe(true)

    expect(existsSync(join(TEST_DIR, 'package.json'))).toBe(true)
    expect(existsSync(join(TEST_DIR, 'vite.config.ts'))).toBe(true)
    expect(existsSync(join(TEST_DIR, 'tsconfig.json'))).toBe(true)
    expect(existsSync(join(TEST_DIR, 'src', 'App.tsx'))).toBe(true)
  })

  test('skips seeding when package.json already exists', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), '{"name":"existing"}')
    const result = seedRuntimeTemplate(TEST_DIR)
    expect(result).toBe(false)
  })

  test('does not copy node_modules or dist', () => {
    const result = seedRuntimeTemplate(TEST_DIR)
    expect(result).toBe(true)
    expect(existsSync(join(TEST_DIR, 'node_modules'))).toBe(false)
    expect(existsSync(join(TEST_DIR, 'dist'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// seedWorkspaceDefaults — config files
// ---------------------------------------------------------------------------

describe('seedWorkspaceDefaults', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('creates config.json with canvas code mode defaults', () => {
    seedWorkspaceDefaults(TEST_DIR)

    const configPath = join(TEST_DIR, 'config.json')
    expect(existsSync(configPath)).toBe(true)

    const config = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'))
    expect(config.activeMode).toBe('canvas')
    expect(config.canvasMode).toBe('code')
  })

  test('creates AGENTS.md describing Vite + React + Tailwind', () => {
    seedWorkspaceDefaults(TEST_DIR)

    const agentsPath = join(TEST_DIR, 'AGENTS.md')
    expect(existsSync(agentsPath)).toBe(true)

    const content = require('fs').readFileSync(agentsPath, 'utf-8')
    expect(content).toContain('Vite')
    expect(content).toContain('React')
    expect(content).toContain('Tailwind')
  })

  test('does not overwrite existing files', () => {
    writeFileSync(join(TEST_DIR, 'AGENTS.md'), 'custom')
    seedWorkspaceDefaults(TEST_DIR)
    const content = require('fs').readFileSync(join(TEST_DIR, 'AGENTS.md'), 'utf-8')
    expect(content).toBe('custom')
  })
})

// ---------------------------------------------------------------------------
// Full workspace bootstrap — template + defaults together
// ---------------------------------------------------------------------------

describe('full workspace bootstrap', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('seedDefaults + seedTemplate produces a complete workspace', () => {
    seedWorkspaceDefaults(TEST_DIR)
    seedRuntimeTemplate(TEST_DIR)

    // Config/markdown files from defaults
    expect(existsSync(join(TEST_DIR, 'config.json'))).toBe(true)
    expect(existsSync(join(TEST_DIR, 'AGENTS.md'))).toBe(true)

    // Vite project files from template
    expect(existsSync(join(TEST_DIR, 'package.json'))).toBe(true)
    expect(existsSync(join(TEST_DIR, 'vite.config.ts'))).toBe(true)
    expect(existsSync(join(TEST_DIR, 'tsconfig.json'))).toBe(true)
    expect(existsSync(join(TEST_DIR, 'src', 'App.tsx'))).toBe(true)
  })
})
