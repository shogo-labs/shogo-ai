// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { sandboxExec, RUNTIME_ONLY_VARS, stripRuntimeVars } from '../sandbox-exec'

describe('stripRuntimeVars', () => {
  test('removes PORT and VITE_PORT from env object', () => {
    const env: Record<string, string | undefined> = {
      HOME: '/home/user',
      PORT: '38554',
      VITE_PORT: '37554',
      NODE_ENV: 'development',
    }
    stripRuntimeVars(env)
    expect(env.PORT).toBeUndefined()
    expect(env.VITE_PORT).toBeUndefined()
    expect(env.HOME).toBe('/home/user')
    expect(env.NODE_ENV).toBe('development')
  })

  test('is a no-op when runtime vars are absent', () => {
    const env: Record<string, string | undefined> = {
      HOME: '/home/user',
      NODE_ENV: 'test',
    }
    stripRuntimeVars(env)
    expect(env.HOME).toBe('/home/user')
    expect(env.NODE_ENV).toBe('test')
    expect(Object.keys(env)).toHaveLength(2)
  })

  test('RUNTIME_ONLY_VARS includes PORT and VITE_PORT', () => {
    expect(RUNTIME_ONLY_VARS).toContain('PORT')
    expect(RUNTIME_ONLY_VARS).toContain('VITE_PORT')
  })
})

describe('sandboxExec PORT isolation', () => {
  let workDir: string
  const savedPort = process.env.PORT
  const savedVitePort = process.env.VITE_PORT

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-port-test-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
    // Simulate the runtime having PORT set (as RuntimeManager does)
    process.env.PORT = '38554'
    process.env.VITE_PORT = '37554'
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
    if (savedPort !== undefined) process.env.PORT = savedPort
    else delete process.env.PORT
    if (savedVitePort !== undefined) process.env.VITE_PORT = savedVitePort
    else delete process.env.VITE_PORT
  })

  // sandboxExec uses Git Bash on Windows, so always use bash syntax
  test('exec does not leak PORT to child processes', () => {
    const result = sandboxExec({
      command: 'echo ${PORT:-unset}',
      workspaceDir: workDir,
      sandboxConfig: { enabled: false },
    })

    // The child should NOT see 38554 — it should be empty or "unset"
    expect(result.stdout).not.toContain('38554')
  })

  test('exec does not leak VITE_PORT to child processes', () => {
    const result = sandboxExec({
      command: 'echo ${VITE_PORT:-unset}',
      workspaceDir: workDir,
      sandboxConfig: { enabled: false },
    })

    expect(result.stdout).not.toContain('37554')
  })

  test('workspace .env PORT still takes effect', () => {
    writeFileSync(join(workDir, '.env'), 'PORT=3001\n')

    const result = sandboxExec({
      command: 'echo ${PORT:-unset}',
      workspaceDir: workDir,
      sandboxConfig: { enabled: false },
    })

    // The workspace .env PORT=3001 should be visible
    expect(result.stdout).toContain('3001')
  })

  test('non-PORT env vars still pass through', () => {
    process.env.__SHOGO_TEST_VAR = 'visible'

    const result = sandboxExec({
      command: 'echo ${__SHOGO_TEST_VAR:-unset}',
      workspaceDir: workDir,
      sandboxConfig: { enabled: false },
    })

    expect(result.stdout).toContain('visible')
    delete process.env.__SHOGO_TEST_VAR
  })
})
