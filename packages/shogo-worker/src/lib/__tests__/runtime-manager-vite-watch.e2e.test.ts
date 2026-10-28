// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { WorkerRuntimeManager } from '../runtime-manager.ts'
import { writeViteWatchPidfile } from '@shogo-ai/sdk/vite-watch'

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1'
const tempDirs: string[] = []
let child: ChildProcess | null = null

afterEach(() => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The child already exited during the test.
    }
  }
  child = null
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!RUN_INTEGRATION)('WorkerRuntimeManager Vite watch cleanup e2e', () => {
  it('reaps a detached Vite watch left in a project workspace at startup', async () => {
    const projectsDir = mkdtempSync(join('/tmp', 'shogo-worker-vite-e2e-'))
    tempDirs.push(projectsDir)
    const projectDir = join(projectsDir, 'project-e2e')
    const bundlerCwd = join(projectDir, 'project')
    mkdirSync(bundlerCwd, { recursive: true })
    const viteShim = join(bundlerCwd, 'node_modules', '.bin', 'vite')

    child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', viteShim, 'build', '--watch'],
      { detached: true, stdio: 'ignore' },
    )
    expect(child.pid).toBeDefined()
    const pid = child.pid!
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
    child.unref()

    writeViteWatchPidfile(projectDir, {
      pid,
      pgid: pid,
      startedAt: Date.now(),
      bundlerCwd,
    })

    new WorkerRuntimeManager({
      autoPull: { enabled: false, projectsDir },
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    })

    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('watch process did not exit')), 2_000)),
    ])
  })

  /**
   * SHO-144: the pidfile only ever knew about vite. An exec shell and the
   * preview API sidecar lead their own groups too, and a runtime that was
   * SIGKILLed left them with no trail at all. The ledger is that trail; this
   * asserts the boot sweep uses it, and that it refuses a reused pid.
   */
  it('reaps the child groups a dead runtime left in the ledger', async () => {
    const projectsDir = mkdtempSync(join('/tmp', 'shogo-worker-ledger-e2e-'))
    tempDirs.push(projectsDir)
    const projectDir = join(projectsDir, 'project-ledger')
    mkdirSync(join(projectDir, '.shogo', 'run'), { recursive: true })

    const spawnSleeper = (label: string) =>
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', label], {
        detached: true,
        stdio: 'ignore',
      })

    const real = spawnSleeper('exec')
    const reused = spawnSleeper('unrelated')
    expect(real.pid).toBeDefined()
    expect(reused.pid).toBeDefined()
    real.unref()
    reused.unref()
    child = null
    // Registered as group leaders so the ledger's `kill(-pgid)` has a group.
    const realCommand = execFileSync('ps', ['-p', String(real.pid), '-o', 'command='], { encoding: 'utf8' }).trim()
    writeFileSync(
      join(projectDir, '.shogo', 'run', 'children.json'),
      JSON.stringify([
        // Ours: the command line still matches what was recorded.
        { pgid: real.pid, pid: real.pid, label: 'exec', commandFingerprint: realCommand, startedAt: Date.now() },
        // A pid that now belongs to something else: must never be signalled.
        { pgid: reused.pid, pid: reused.pid, label: 'api-sidecar', commandFingerprint: 'bun run server.tsx', startedAt: Date.now() },
      ]) + '\n',
      'utf8',
    )
    const realExited = new Promise<void>((resolve) => real.once('exit', () => resolve()))

    new WorkerRuntimeManager({
      autoPull: { enabled: false, projectsDir },
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    })

    await Promise.race([
      realExited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('ledger entry was not reaped')), 5_000)),
    ])
    // The unrelated process survives: a reused pid is dropped, never signalled.
    expect(() => process.kill(reused.pid as number, 0)).not.toThrow()
    reused.kill('SIGKILL')
  })
})
