// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Focused coverage for RuntimeManager's filesystem bootstrap helpers.
 *
 * These tests deliberately reach into private helpers so we can exercise the
 * large deterministic project-directory branches without spawning Vite or the
 * agent runtime.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RuntimeManager } from '../lib/runtime/manager'

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'runtime-manager-dir-'))
})

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

function privateRuntimeManager(config: ConstructorParameters<typeof RuntimeManager>[0] = {}) {
  return new RuntimeManager({
    workspacesDir: tmp,
    ...config,
  }) as unknown as {
    createMinimalProject: (projectDir: string) => void
    // Post-marketplace-consolidation signature: the legacy `templateId`
    // parameter was dropped, so `externalProject` is the 3rd arg, not
    // the 4th. (manager.ts:701–707)
    ensureProjectDirectory: (
      projectId: string,
      techStackId?: string,
      externalProject?: { primaryPath: string },
    ) => Promise<string>
  }
}

describe('RuntimeManager directory bootstrap helpers', () => {
  test('createMinimalProject writes a complete inline Vite app skeleton', () => {
    const rm = privateRuntimeManager()
    const projectDir = join(tmp, 'inline-project')

    rm.createMinimalProject(projectDir)

    expect(JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))).toMatchObject({
      private: true,
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
    })
    expect(readFileSync(join(projectDir, 'vite.config.ts'), 'utf8')).toContain("host: '0.0.0.0'")
    expect(readFileSync(join(projectDir, 'tsconfig.json'), 'utf8')).toContain('"jsx": "react-jsx"')
    expect(readFileSync(join(projectDir, 'index.html'), 'utf8')).toContain('/src/main.tsx')
    expect(readFileSync(join(projectDir, 'src', 'main.tsx'), 'utf8')).toContain('ShogoErrorBoundary')
    expect(readFileSync(join(projectDir, 'src', 'ShogoErrorBoundary.tsx'), 'utf8')).toContain('componentDidCatch')
    expect(readFileSync(join(projectDir, 'src', 'App.tsx'), 'utf8')).toContain('Project Ready')
  })

  test('external projects reuse the primary path and create the .shogo skeleton only', async () => {
    const externalDir = join(tmp, 'user-owned-folder')
    const rm = privateRuntimeManager()

    const result = await rm.ensureProjectDirectory('proj-external', undefined, {
      primaryPath: externalDir,
    })

    expect(result).toBe(externalDir)
    expect(existsSync(join(externalDir, '.shogo', 'skills'))).toBe(true)
    expect(existsSync(join(externalDir, '.shogo', 'plans'))).toBe(true)
    expect(existsSync(join(externalDir, '.shogo', 'local', 'dist'))).toBe(true)
    expect(existsSync(join(tmp, 'proj-external'))).toBe(false)
  })

  test('self-seeding tech stacks create an empty workspace and skip dependency install', async () => {
    const rm = privateRuntimeManager()

    const result = await rm.ensureProjectDirectory('proj-python', 'python-data')

    expect(result).toBe(join(tmp, 'proj-python'))
    expect(existsSync(result)).toBe(true)
    expect(existsSync(join(result, 'package.json'))).toBe(false)
    expect(existsSync(join(result, 'node_modules'))).toBe(false)
  })

  test('existing self-seeding workspace without package.json is preserved', async () => {
    const existingDir = join(tmp, 'proj-existing')
    rmSync(existingDir, { recursive: true, force: true })
    const rm = privateRuntimeManager()
    await rm.ensureProjectDirectory('proj-existing', 'python-data')
    writeFileSync(join(existingDir, 'notes.txt'), 'keep me')

    const result = await rm.ensureProjectDirectory('proj-existing', 'python-data')

    expect(result).toBe(existingDir)
    expect(readFileSync(join(existingDir, 'notes.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(join(existingDir, 'package.json'))).toBe(false)
  })
})
