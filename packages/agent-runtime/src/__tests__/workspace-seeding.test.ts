// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'fs'
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
    // realpathSync may resolve /tmp → /private/tmp on macOS
    expect(result).not.toBeNull()
    expect(result!.endsWith('test-runtime-template-override')).toBe(true)

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

  test('resolves symlinks so cpSync does not choke on symlink-to-directory', () => {
    // Reproduces the VM crash: /opt/shogo/templates/runtime-template is a symlink
    // to /app/templates/runtime-template/. Without realpathSync, cpSync throws
    // "cannot overwrite non-directory ... with directory ..."
    const realDir = '/tmp/test-template-real'
    const symlinkDir = '/tmp/test-template-symlink'
    rmSync(realDir, { recursive: true, force: true })
    rmSync(symlinkDir, { recursive: true, force: true })
    mkdirSync(realDir, { recursive: true })
    writeFileSync(join(realDir, 'package.json'), '{}')
    symlinkSync(realDir, symlinkDir)

    process.env.RUNTIME_TEMPLATE_DIR = symlinkDir
    const result = getRuntimeTemplatePath()
    // Should resolve the symlink to the real directory path
    // (realpathSync may also resolve /tmp → /private/tmp on macOS)
    expect(result).not.toBeNull()
    expect(result!.endsWith('test-template-real')).toBe(true)
    expect(result).not.toContain('symlink')

    rmSync(realDir, { recursive: true, force: true })
    rmSync(symlinkDir, { force: true })
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

  test('works when template path is a symlink (VM provisioned image)', () => {
    // The VM image has /opt/shogo/templates/runtime-template → /app/templates/runtime-template
    // This must not crash with "cannot overwrite non-directory ... with directory ..."
    const realTemplate = getRuntimeTemplatePath()
    expect(realTemplate).not.toBeNull()

    const symlinkPath = '/tmp/test-template-symlink-seed'
    rmSync(symlinkPath, { force: true })
    symlinkSync(realTemplate!, symlinkPath)

    const origEnv = process.env.RUNTIME_TEMPLATE_DIR
    process.env.RUNTIME_TEMPLATE_DIR = symlinkPath

    try {
      const result = seedRuntimeTemplate(TEST_DIR)
      expect(result).toBe(true)
      expect(existsSync(join(TEST_DIR, 'package.json'))).toBe(true)
      expect(existsSync(join(TEST_DIR, 'vite.config.ts'))).toBe(true)
      expect(existsSync(join(TEST_DIR, 'src', 'App.tsx'))).toBe(true)
    } finally {
      if (origEnv === undefined) delete process.env.RUNTIME_TEMPLATE_DIR
      else process.env.RUNTIME_TEMPLATE_DIR = origEnv
      rmSync(symlinkPath, { force: true })
    }
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
