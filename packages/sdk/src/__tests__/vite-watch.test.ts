// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  killViteWatchFromPidfile,
  removeViteWatchPidfile,
  viteWatchPidfilePath,
  writeViteWatchPidfile,
} from '../vite-watch'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeWorkspace(): string {
  const dir = mkdtempSync(join('/tmp', 'shogo-vite-watch-'))
  tempDirs.push(dir)
  return dir
}

function writeRecord(workspaceDir: string, pid = 1234): void {
  writeViteWatchPidfile(workspaceDir, {
    pid,
    pgid: pid,
    startedAt: Date.now(),
    bundlerCwd: join(workspaceDir, 'project'),
  })
}

describe('vite-watch pidfile cleanup', () => {
  it('kills a matching detached Vite watch process and removes its pidfile', () => {
    const workspaceDir = makeWorkspace()
    writeRecord(workspaceDir)
    const killed: Array<[number, NodeJS.Signals]> = []

    const result = killViteWatchFromPidfile(workspaceDir, {
      platform: 'darwin',
      readProcessCommand: () =>
        `node ${workspaceDir}/project/node_modules/.bin/vite build --watch --emptyOutDir false`,
      killGroup: (pgid, signal) => killed.push([pgid, signal]),
    })

    expect(result?.pid).toBe(1234)
    expect(killed).toEqual([[1234, 'SIGTERM']])
    expect(existsSync(viteWatchPidfilePath(workspaceDir))).toBe(false)
  })

  it('does not kill a reused PID whose command is no longer the workspace Vite watch', () => {
    const workspaceDir = makeWorkspace()
    writeRecord(workspaceDir)
    const killed: number[] = []

    const result = killViteWatchFromPidfile(workspaceDir, {
      platform: 'darwin',
      readProcessCommand: () => 'node unrelated-server.js',
      killGroup: (pgid) => killed.push(pgid),
    })

    expect(result).toBeNull()
    expect(killed).toEqual([])
    expect(existsSync(viteWatchPidfilePath(workspaceDir))).toBe(false)
  })

  it('leaves the pidfile when process inspection fails so a later sweep can retry', () => {
    const workspaceDir = makeWorkspace()
    writeRecord(workspaceDir)

    const result = killViteWatchFromPidfile(workspaceDir, {
      platform: 'darwin',
      readProcessCommand: () => {
        throw new Error('ps unavailable')
      },
    })

    expect(result).toBeNull()
    expect(existsSync(viteWatchPidfilePath(workspaceDir))).toBe(true)
  })

  it('does not remove a replacement pidfile when an old watcher exits late', () => {
    const workspaceDir = makeWorkspace()
    writeRecord(workspaceDir, 111)
    writeRecord(workspaceDir, 222)

    removeViteWatchPidfile(workspaceDir, 111)

    expect(JSON.parse(readFileSync(viteWatchPidfilePath(workspaceDir), 'utf8')).pid).toBe(222)
  })
})
