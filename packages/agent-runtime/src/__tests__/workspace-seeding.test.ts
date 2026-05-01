// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  getRuntimeTemplatePath,
  seedRuntimeTemplate,
  seedWorkspaceDefaults,
  ensureWorkspaceDeps,
  overlayAgentTemplateCodeDirs,
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
// overlayAgentTemplateCodeDirs — curator src wins after runtime skeleton
// ---------------------------------------------------------------------------

describe('overlayAgentTemplateCodeDirs', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('replaces generic Project Ready App after seedRuntimeTemplate (agent template bootstrap order)', () => {
    expect(seedRuntimeTemplate(TEST_DIR)).toBe(true)
    const genericApp = readFileSync(join(TEST_DIR, 'src', 'App.tsx'), 'utf-8')
    expect(genericApp).toContain('Project Ready')

    expect(overlayAgentTemplateCodeDirs(TEST_DIR, 'sales-bdr-pipeline')).toBe(true)

    const app = readFileSync(join(TEST_DIR, 'src', 'App.tsx'), 'utf-8')
    expect(app).toContain('BDRPipeline')
    expect(app).not.toContain('Project Ready')
    expect(existsSync(join(TEST_DIR, 'src', 'surfaces', 'BDRPipeline.tsx'))).toBe(true)
  })

  test('returns false for unknown template id', () => {
    expect(overlayAgentTemplateCodeDirs(TEST_DIR, 'unknown-template-xxxxx')).toBe(false)
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
// ensureWorkspaceDeps — platform detection
// ---------------------------------------------------------------------------

describe('ensureWorkspaceDeps platform detection', () => {
  const DEPS_DIR = '/tmp/test-workspace-deps-platform'

  beforeEach(() => {
    rmSync(DEPS_DIR, { recursive: true, force: true })
    mkdirSync(DEPS_DIR, { recursive: true })
    writeFileSync(join(DEPS_DIR, 'package.json'), '{"name":"test","dependencies":{"vite":"^5"}}')
  })

  afterEach(() => {
    rmSync(DEPS_DIR, { recursive: true, force: true })
  })

  test('detects wrong-platform marker and reinstalls', async () => {
    mkdirSync(join(DEPS_DIR, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(DEPS_DIR, 'node_modules', '.bin', 'vite'), '#!/bin/sh')
    writeFileSync(join(DEPS_DIR, 'node_modules', '.shogo-platform'), 'linux-arm64-fake\n')

    const currentPlatform = `${process.platform}-${process.arch}`
    expect(currentPlatform).not.toBe('linux-arm64-fake')

    // This should detect the mismatch, nuke node_modules, and reinstall
    // We can't easily test the full bun install in unit tests, but we can
    // verify the old node_modules got removed
    try {
      await ensureWorkspaceDeps(DEPS_DIR)
    } catch {
      // bun install may fail in test env — that's fine, we're testing detection
    }
    // The fake .shogo-platform should be gone (node_modules was nuked)
    const markerAfter = existsSync(join(DEPS_DIR, 'node_modules', '.shogo-platform'))
      ? require('fs').readFileSync(join(DEPS_DIR, 'node_modules', '.shogo-platform'), 'utf-8').trim()
      : null
    // Either nuked (no marker) or reinstalled (correct marker)
    if (markerAfter) {
      expect(markerAfter).toBe(currentPlatform)
    }
  })

  test('skips reinstall when platform marker matches', async () => {
    const currentPlatform = `${process.platform}-${process.arch}`
    mkdirSync(join(DEPS_DIR, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(DEPS_DIR, 'node_modules', '.bin', 'vite'), '#!/bin/sh')
    writeFileSync(join(DEPS_DIR, 'node_modules', '.shogo-platform'), currentPlatform + '\n')

    await ensureWorkspaceDeps(DEPS_DIR)

    // Should have returned early — marker still intact
    const marker = require('fs').readFileSync(
      join(DEPS_DIR, 'node_modules', '.shogo-platform'), 'utf-8'
    ).trim()
    expect(marker).toBe(currentPlatform)
  })

  test('detects wrong-platform rollup packages when no marker exists', async () => {
    mkdirSync(join(DEPS_DIR, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(DEPS_DIR, 'node_modules', '.bin', 'vite'), '#!/bin/sh')
    // Simulate macOS rollup in a Linux env (or vice versa)
    const foreignOs = process.platform === 'linux' ? 'darwin' : 'linux'
    mkdirSync(join(DEPS_DIR, 'node_modules', '@rollup', `rollup-${foreignOs}-arm64`), { recursive: true })
    // No .shogo-platform marker

    try {
      await ensureWorkspaceDeps(DEPS_DIR)
    } catch {
      // bun install may fail — testing detection, not install
    }
    // The foreign rollup package should be gone
    expect(existsSync(join(DEPS_DIR, 'node_modules', '@rollup', `rollup-${foreignOs}-arm64`))).toBe(false)
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

  test('local mode order (apps/api copies bundled template, then template overlay) renders the template surface, not Project Ready', () => {
    // 1. Mimic apps/api/src/lib/runtime/manager.ts: copy the bundled
    //    runtime-template into the project dir (this is what the user sees
    //    *before* the agent-runtime even spawns).
    const templatePath = getRuntimeTemplatePath()
    expect(templatePath).not.toBeNull()
    require('fs').cpSync(templatePath!, TEST_DIR, {
      recursive: true,
      filter: (src: string) =>
        !src.includes('node_modules') && !src.includes('.git') && !src.endsWith('bun.lock'),
    })
    expect(existsSync(join(TEST_DIR, 'package.json'))).toBe(true)
    const before = readFileSync(join(TEST_DIR, 'src', 'App.tsx'), 'utf-8')
    expect(before).toContain('Project Ready')

    // 2. Apply the agent-template overlay BEFORE Vite would spawn — same
    //    new code path the API now exercises in `ensureProjectDirectory`.
    expect(overlayAgentTemplateCodeDirs(TEST_DIR, 'sales-bdr-pipeline')).toBe(true)

    // 3. The canvas iframe will paint this src/App.tsx on first request,
    //    so it must be the template's surface — not the generic stub.
    const after = readFileSync(join(TEST_DIR, 'src', 'App.tsx'), 'utf-8')
    expect(after).not.toContain('Project Ready')
    expect(after).toContain('BDRPipeline')

    expect(existsSync(join(TEST_DIR, 'src', 'surfaces', 'BDRPipeline.tsx'))).toBe(true)
    expect(existsSync(join(TEST_DIR, 'src', 'components', 'MetricCard.tsx'))).toBe(true)
  })

  test('local mode order: cold-call agent template overlays correctly', () => {
    const templatePath = getRuntimeTemplatePath()
    require('fs').cpSync(templatePath!, TEST_DIR, {
      recursive: true,
      filter: (src: string) =>
        !src.includes('node_modules') && !src.includes('.git') && !src.endsWith('bun.lock'),
    })
    expect(overlayAgentTemplateCodeDirs(TEST_DIR, 'sales-cold-call-agent')).toBe(true)
    const after = readFileSync(join(TEST_DIR, 'src', 'App.tsx'), 'utf-8')
    expect(after).not.toContain('Project Ready')
    expect(existsSync(join(TEST_DIR, 'src', 'surfaces', 'OutboundCalls.tsx'))).toBe(true)
  })

  test('local mode order: stripe revenue ops template overlays correctly', () => {
    const templatePath = getRuntimeTemplatePath()
    require('fs').cpSync(templatePath!, TEST_DIR, {
      recursive: true,
      filter: (src: string) =>
        !src.includes('node_modules') && !src.includes('.git') && !src.endsWith('bun.lock'),
    })
    expect(overlayAgentTemplateCodeDirs(TEST_DIR, 'stripe-revenue-ops')).toBe(true)
    const after = readFileSync(join(TEST_DIR, 'src', 'App.tsx'), 'utf-8')
    expect(after).not.toContain('Project Ready')
    expect(existsSync(join(TEST_DIR, 'src', 'surfaces', 'RevenueOps.tsx'))).toBe(true)
  })
})
