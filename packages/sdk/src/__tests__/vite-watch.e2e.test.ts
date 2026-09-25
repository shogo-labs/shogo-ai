// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  killViteWatchFromPidfile,
  writeViteWatchPidfile,
} from '../vite-watch'

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

describe.skipIf(!RUN_INTEGRATION)('vite-watch process cleanup e2e', () => {
  it('kills a real detached process through its pidfile and process group', async () => {
    const workspaceDir = mkdtempSync(join('/tmp', 'shogo-vite-watch-e2e-'))
    tempDirs.push(workspaceDir)
    const bundlerCwd = join(workspaceDir, 'project')
    const viteShim = join(bundlerCwd, 'node_modules', '.bin', 'vite')

    child = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
        viteShim,
        'build',
        '--watch',
      ],
      { detached: true, stdio: 'ignore' },
    )
    expect(child.pid).toBeDefined()
    const pid = child.pid!
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
    child.unref()

    writeViteWatchPidfile(workspaceDir, {
      pid,
      pgid: pid,
      startedAt: Date.now(),
      bundlerCwd,
    })

    const reaped = killViteWatchFromPidfile(workspaceDir)
    expect(reaped?.pid).toBe(pid)
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('watch process did not exit')), 2_000)),
    ])
  })
})
