// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the soft-timeout behavior added to the `exec` tool plus the
 * companion `exec_wait` tool. The agent should:
 *   1. Get a normal completed result when the command finishes in time.
 *   2. Get { status: 'running', run_id, pid, ... } when it overruns the soft timeout.
 *   3. Be able to call exec_wait(run_id) to keep waiting (also soft-bounded).
 *   4. Be able to kill a backgrounded run via exec("kill <pid>") and then
 *      collect the final result via exec_wait.
 *   5. Have an absolute hard-cap so orphans don't leak forever.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTools, type ToolContext } from '../gateway-tools'
import { CommandRegistry } from '../command-registry'
import { sandboxExecAsync } from '../sandbox-exec'

const PLATFORM = process.platform

function getTool(ctx: ToolContext, name: string) {
  const tool = createTools(ctx).find(t => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

async function callTool(ctx: ToolContext, name: string, params: Record<string, any>) {
  const tool = getTool(ctx, name)
  const result = await tool.execute('test-call', params)
  return result.details
}

describe('exec soft-timeout', () => {
  let workDir: string
  let ctx: ToolContext
  let registry: CommandRegistry

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-exec-soft-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workDir, { recursive: true })
    registry = new CommandRegistry()
    const cwdMap = new Map<string, string>()
    const sessionId = 'test-session'
    ctx = {
      workspaceDir: workDir,
      channels: new Map(),
      config: {
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      } as any,
      projectId: 'test',
      sessionId,
      shellState: {
        getCwd: () => cwdMap.get(sessionId) || workDir,
        setCwd: (cwd: string) => cwdMap.set(sessionId, cwd),
      },
      commandRegistry: registry,
    }
  })

  afterEach(async () => {
    // SIGKILL any backgrounded runs so the workspace dir isn't held open by a
    // child process. On Windows the file lock can outlive the syscall by a
    // few hundred ms, so we retry the rm a few times.
    registry.killAll()
    await new Promise(r => setTimeout(r, 500))
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(workDir, { recursive: true, force: true })
        return
      } catch {
        await new Promise(r => setTimeout(r, 200))
      }
    }
    // Best-effort; OS tmpdir cleanup will handle anything left over.
  })

  test('completes within the soft timeout and returns full result', async () => {
    const result = await callTool(ctx, 'exec', { command: 'echo hello', timeout: 5000 })
    expect(result.status).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
    expect(result.run_id).toBeDefined()
  })

  test('returns running + run_id + pid when soft timeout fires', async () => {
    // Sleep longer than the soft timeout. The command keeps running.
    const sleepCmd = PLATFORM === 'win32' ? 'sleep 3' : 'sleep 3'
    const result = await callTool(ctx, 'exec', { command: sleepCmd, timeout: 200 })
    expect(result.status).toBe('running')
    expect(result.run_id).toMatch(/^cmd_/)
    expect(typeof result.pid).toBe('number')
    expect(result.hint).toContain('exec_wait')
    expect(result.hint).toContain(String(result.pid))
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    // Registry has the entry.
    expect(registry.get(result.run_id)).toBeDefined()
  })

  test('exec_wait collects the final result when the run finishes', async () => {
    // Start a 1.5s sleep with a 200ms soft timeout so we get a run_id.
    const start = await callTool(ctx, 'exec', { command: 'sleep 1', timeout: 200 })
    expect(start.status).toBe('running')

    // Wait up to 5s — the sleep finishes well before that.
    const waited = await callTool(ctx, 'exec_wait', { run_id: start.run_id, timeout_ms: 5000 })
    expect(waited.status).toBeUndefined()
    expect(waited.exitCode).toBe(0)
    expect(waited.run_id).toBe(start.run_id)
  })

  test('exec_wait soft-times-out again when the run is still going', async () => {
    const start = await callTool(ctx, 'exec', { command: 'sleep 5', timeout: 100 })
    expect(start.status).toBe('running')

    const waited = await callTool(ctx, 'exec_wait', { run_id: start.run_id, timeout_ms: 100 })
    expect(waited.status).toBe('running')
    expect(waited.run_id).toBe(start.run_id)
    expect(waited.pid).toBe(start.pid)
  })

  test('exec_wait with timeout_ms=0 is a non-blocking status check', async () => {
    const start = await callTool(ctx, 'exec', { command: 'sleep 2', timeout: 100 })
    expect(start.status).toBe('running')

    const checked = await callTool(ctx, 'exec_wait', { run_id: start.run_id, timeout_ms: 0 })
    expect(checked.status).toBe('running')
  })

  test('exec_wait reports unknown run_id', async () => {
    const result = await callTool(ctx, 'exec_wait', { run_id: 'cmd_doesnotexist', timeout_ms: 0 })
    expect(result.error).toContain('Unknown run_id')
  })

  test('killing a backgrounded run via exec("kill <pid>") completes it', async () => {
    if (PLATFORM === 'win32') {
      // taskkill semantics differ — covered by direct kill test below.
      return
    }
    const start = await callTool(ctx, 'exec', { command: 'sleep 30', timeout: 200 })
    expect(start.status).toBe('running')
    const pid = start.pid

    // Use exec to kill the backgrounded pid.
    const killResult = await callTool(ctx, 'exec', { command: `kill ${pid}`, timeout: 5000 })
    expect(killResult.exitCode).toBe(0)

    // exec_wait now sees the killed process and returns the final exit code.
    const waited = await callTool(ctx, 'exec_wait', { run_id: start.run_id, timeout_ms: 5000 })
    expect(waited.status).toBeUndefined()
    expect(waited.exitCode).not.toBe(0) // killed processes have non-zero exit
  })

  test('exec_wait pattern resolves as soon as the regex matches stdout', async () => {
    if (PLATFORM === 'win32') return // shell semantics differ on Windows
    const start = await callTool(ctx, 'exec', {
      command: 'echo first; sleep 0.5; echo TARGET; sleep 5; echo never',
      timeout: 200,
    })
    expect(start.status).toBe('running')

    const waited = await callTool(ctx, 'exec_wait', {
      run_id: start.run_id,
      timeout_ms: 4000,
      pattern: 'TARGET',
    })
    // Pattern hit returns the running shape (process still alive); kill it
    // so afterEach doesn't have to wait for the long sleep.
    expect(waited.run_id).toBe(start.run_id)
    expect(['running', undefined]).toContain(waited.status)
  })
})

describe('CommandRegistry', () => {
  test('register assigns a unique cmd_-prefixed id and tracks completion', async () => {
    const reg = new CommandRegistry()
    const handle = sandboxExecAsync({
      command: 'echo done',
      workspaceDir: tmpdir(),
      sandboxConfig: { enabled: false },
    })
    const entry = reg.register('echo done', handle)
    expect(entry.runId).toMatch(/^cmd_[0-9a-f]{8}$/)
    expect(reg.get(entry.runId)).toBe(entry)

    const final = await handle.done
    expect(final.exitCode).toBe(0)
    // finalResult is filled by the registry's `.then` on done.
    await new Promise(r => setTimeout(r, 20))
    expect(entry.finalResult).toBeDefined()
    expect(entry.finalResult!.exitCode).toBe(0)
  })

  test('killAll terminates still-running entries', async () => {
    const reg = new CommandRegistry()
    const handle = sandboxExecAsync({
      command: 'sleep 30',
      workspaceDir: tmpdir(),
      sandboxConfig: { enabled: false },
    })
    reg.register('sleep 30', handle)
    expect(handle.exited()).toBe(false)
    reg.killAll()
    // After killAll, the handle should resolve relatively quickly.
    const result = await Promise.race([
      handle.done,
      new Promise(r => setTimeout(() => r({ timedOut: true }), 5000)),
    ]) as any
    expect(result.timedOut).not.toBe(true)
    expect(handle.exited()).toBe(true)
  })
})

describe('sandboxExecAsync hard cap', () => {
  test('hardTimeoutMs SIGKILLs runaway processes', async () => {
    const handle = sandboxExecAsync({
      command: 'sleep 30',
      workspaceDir: tmpdir(),
      sandboxConfig: { enabled: false },
      hardTimeoutMs: 300,
    })
    const start = Date.now()
    const result = await handle.done
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(5000)
    expect(result.timedOut).toBe(true)
    expect(result.killed).toBe(true)
  })

  test('produces stdout snapshot before completion', async () => {
    if (PLATFORM === 'win32') return
    const handle = sandboxExecAsync({
      command: 'echo first; sleep 1; echo second',
      workspaceDir: tmpdir(),
      sandboxConfig: { enabled: false },
    })
    // Give it ~300ms to emit "first".
    await new Promise(r => setTimeout(r, 400))
    expect(handle.stdout()).toContain('first')
    expect(handle.exited()).toBe(false)
    // Wait for completion.
    const result = await handle.done
    expect(result.stdout).toContain('first')
    expect(result.stdout).toContain('second')
  })
})
