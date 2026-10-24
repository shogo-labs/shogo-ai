// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-144 acceptance, driven the way the incident happened.
 *
 * `task_cancel` used to answer from the signal it sent. The card's e2e list is
 * about the answer being *true*: a tree it emptied says `cancelled`, a tree it
 * could not empty names what is still running, and a runtime that dies without
 * a shutdown leaves nothing for launchd.
 *
 * 1. Windows: a background exec whose script starts a long-lived child through
 *    an exiting `cmd /c` wrapper survives `taskkill /T`; the job object must
 *    still empty it. `describe.skipIf(!IS_WINDOWS)` — only the `test-windows`
 *    CI job can run it.
 * 2. POSIX: hard-kill a runtime while a background exec and the API sidecar are
 *    running. Whatever outlives it reaps the ledger; nothing is left alive.
 * 3. POSIX: a child that called `setsid` is out of the group. `task_cancel`
 *    either kills it or names it — never a bare `cancelled` while it runs.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTools, type ToolContext } from '../gateway-tools'
import { TaskRegistry } from '../task-registry'
import { taskOutputDir } from '../task-output'
import { readChildLedger, reapChildLedger } from '@shogo-ai/sdk/child-ledger'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const IS_WINDOWS = process.platform === 'win32'
const TEST_DIR = '/tmp/qa-sho144-cancel-truth'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function makeCtx(registry: TaskRegistry): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
    commandRegistry: registry,
    uiWriter: { write: () => {} } as any,
  }
}

async function run(ctx: ToolContext, name: string, params: Record<string, any>) {
  const tool = createTools(ctx).find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return (await tool.execute('call-1', params)).details as any
}

let registry: TaskRegistry
const strays: number[] = []

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  // `killAll` is async and sweeps the ledger: await it, or the rmSync below can
  // delete a directory a still-running sweep is writing to. Its own budget is
  // 3 s, so the hook states a budget larger than bun's 5 s default rather than
  // letting teardown be reported as the spec failing.
  try { await registry?.killAll() } catch { /* already gone */ }
  try {
    rmSync(TEST_DIR, { recursive: true, force: true })
  } catch {
    // A directory a killed process still holds is teardown noise, not a verdict.
  }
}, 30_000)

afterAll(() => clearTrustForTests())

function freshWorkspace(): void {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  trustWorkspaceForTests(TEST_DIR)
  registry = new TaskRegistry({ outputDir: taskOutputDir(TEST_DIR, 'chat-1'), workspaceDir: TEST_DIR })
}

describe.skipIf(IS_WINDOWS)('SHO-144 e2e 3 — a setsid escapee is killed or named', () => {
  test('task_cancel never says cancelled while the escapee is still running', async () => {
    freshWorkspace()
    const ctx = makeCtx(registry)
    // The child moves itself into a new session, so `kill(-pgid)` cannot reach
    // it. Its parent (the shell) stays alive, which is what lets the tool see
    // it in the snapshot and chase it by pid.
    const started = await run(ctx, 'exec', {
      command: 'python3 -c "import os,time; os.setsid(); time.sleep(300)" & echo "child $!"; wait',
      background: true,
    })
    const logPath = join(TEST_DIR, started.output_file)
    await waitFor(() => existsSync(logPath) && /child \d+/.test(readFileSync(logPath, 'utf8')), 15_000, 'the escapee pid')
    const escapee = Number(readFileSync(logPath, 'utf8').match(/child (\d+)/)![1])
    strays.push(escapee)
    expect(isAlive(escapee)).toBe(true)

    const cancelled = await run(ctx, 'task_cancel', { task_id: started.task_id })

    if (cancelled.status === 'cancelled') {
      await waitFor(() => !isAlive(escapee), 10_000, 'the escapee to die')
      expect(cancelled.survivors).toEqual([])
    } else {
      // The honest branch: named by pid, with a command that finishes the job.
      expect(cancelled.status).toBe('cancel_incomplete')
      expect(cancelled.survivors.map((survivor: any) => survivor.pid)).toContain(escapee)
      expect(cancelled.hint).toContain(String(escapee))
    }
  }, 60_000)

  test('a cancelled exec that left nothing behind is quick and reports an empty tree (AC 4)', async () => {
    freshWorkspace()
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 30', background: true })

    const began = Date.now()
    const cancelled = await run(ctx, 'task_cancel', { task_id: started.task_id })
    const took = Date.now() - began

    expect(cancelled).toMatchObject({ ok: true, status: 'cancelled', survivors: [] })
    expect(registry.get(started.task_id)?.status).toBe('cancelled')
    // Today's cancel is one signal; the verified sweep must not turn it into a
    // multi-second wait.
    expect(took).toBeLessThan(1_500)
  }, 30_000)
})

describe.skipIf(IS_WINDOWS)('SHO-144 e2e 2 — a hard-killed runtime leaves nothing alive', () => {
  test('the ledger reap kills the exec and the API sidecar of a SIGKILLed runtime', async () => {
    freshWorkspace()
    const workspaceDir = TEST_DIR
    // A stand-in for the runtime: the real `sandboxExecAsync` spawn (own group,
    // ledger entry) plus a sidecar-shaped detached child recorded with the same
    // `containChild`. It prints the pids and then waits to be SIGKILLed.
    const runnerPath = join(workspaceDir, 'runtime-stand-in.ts')
    writeFileSync(
      runnerPath,
      [
        `import { sandboxExecAsync } from ${JSON.stringify(join(import.meta.dir, '..', 'sandbox-exec'))}`,
        `import { containChild } from ${JSON.stringify(join(import.meta.dir, '..', 'process-tree'))}`,
        `import { spawn } from 'node:child_process'`,
        `const workspaceDir = ${JSON.stringify(workspaceDir)}`,
        `const exec = sandboxExecAsync({ command: 'sleep 600', workspaceDir, sandboxConfig: { enabled: false } })`,
        `const sidecar = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore' })`,
        `const containment = containChild(sidecar, { label: 'api-sidecar', workspaceDir })`,
        `console.log(JSON.stringify({ exec: exec.pid, sidecar: containment.pid }))`,
        `setInterval(() => {}, 1000)`,
      ].join('\n'),
      'utf8',
    )

    const runner: ChildProcess = spawn(process.execPath, [runnerPath], {
      cwd: workspaceDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let pids: { exec: number; sidecar: number } | null = null
    let buffered = ''
    runner.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const match = buffered.match(/\{"exec":(\d+),"sidecar":(\d+)\}/) ?? buffered.match(/\{"exec":(\d+),.*?"sidecar":(\d+)\}/)
      if (match) pids = { exec: Number(match[1]), sidecar: Number(match[2]) }
    })

    await waitFor(() => pids !== null, 20_000, 'the runtime stand-in to report its children')
    const { exec: execPid, sidecar: sidecarPid } = pids as unknown as { exec: number; sidecar: number }
    strays.push(execPid, sidecarPid, runner.pid as number)

    // Both groups are in the ledger, which is the only trail a reaper has.
    await waitFor(
      () => readChildLedger(workspaceDir).length >= 2,
      20_000,
      'both groups to be recorded',
    )
    const labels = readChildLedger(workspaceDir).map((entry) => entry.label)
    expect(labels).toContain('exec')
    expect(labels).toContain('api-sidecar')
    expect(isAlive(execPid)).toBe(true)
    expect(isAlive(sidecarPid)).toBe(true)

    // The runtime dies the way it does on Windows and under jetsam: no
    // shutdown, no `stop()`, no chance to clean up.
    process.kill(runner.pid as number, 'SIGKILL')
    await waitFor(() => !isAlive(runner.pid as number), 10_000, 'the runtime to die')
    // Detached children outlive their parent — that is the whole incident.
    expect(isAlive(execPid)).toBe(true)
    expect(isAlive(sidecarPid)).toBe(true)

    // What `WorkerRuntimeManager.stop()`/`handleExit()` and apps/api's boot
    // sweep do next.
    const { reaped } = reapChildLedger(workspaceDir)
    expect(reaped.map((entry) => entry.label).sort()).toEqual(['api-sidecar', 'exec'])

    await waitFor(() => !isAlive(execPid), 10_000, 'the exec group to die')
    await waitFor(() => !isAlive(sidecarPid), 10_000, 'the sidecar group to die')
    expect(readChildLedger(workspaceDir)).toEqual([])
  }, 90_000)
})
