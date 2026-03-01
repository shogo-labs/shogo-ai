import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { sandboxExec } from '../sandbox-exec'

describe('sandboxExec', () => {
  let workDir: string

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-sandbox-test-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('runs natively when sandbox disabled', () => {
    const result = sandboxExec({
      command: 'echo hello',
      workspaceDir: workDir,
      sandboxConfig: { enabled: false },
    })

    expect(result.stdout).toBe('hello')
    expect(result.exitCode).toBe(0)
    expect(result.sandboxed).toBe(false)
  })

  test('runs natively for main session with non-main mode', () => {
    const result = sandboxExec({
      command: 'echo main-session',
      workspaceDir: workDir,
      sandboxConfig: { enabled: true, mode: 'non-main' },
      sessionId: 'owner-chat',
      mainSessionIds: ['owner-chat'],
    })

    expect(result.stdout).toBe('main-session')
    expect(result.exitCode).toBe(0)
    expect(result.sandboxed).toBe(false)
  })

  test('runs natively when no sandbox config provided', () => {
    const result = sandboxExec({
      command: 'echo no-config',
      workspaceDir: workDir,
    })

    expect(result.stdout).toBe('no-config')
    expect(result.exitCode).toBe(0)
    expect(result.sandboxed).toBe(false)
  })

  test('handles command failure gracefully', () => {
    const result = sandboxExec({
      command: 'ls /nonexistent_dir_99999',
      workspaceDir: workDir,
      sandboxConfig: { enabled: false },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.sandboxed).toBe(false)
  })

  test('respects timeout', () => {
    const start = Date.now()
    const result = sandboxExec({
      command: 'sleep 10',
      workspaceDir: workDir,
      timeout: 100,
      sandboxConfig: { enabled: false },
    })
    const elapsed = Date.now() - start

    expect(result.exitCode).not.toBe(0)
    expect(elapsed).toBeLessThan(5000)
  })
})
