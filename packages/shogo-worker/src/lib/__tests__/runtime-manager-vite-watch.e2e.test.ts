// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
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
})
