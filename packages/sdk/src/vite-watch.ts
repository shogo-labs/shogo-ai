// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import * as childProcess from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const PIDFILE_NAME = join('.shogo', 'vite-watch.pid')

export interface ViteWatchPidfile {
  pid: number
  pgid: number
  startedAt: number
  workspaceDir: string
  bundlerCwd: string
}

export interface ViteWatchPidfileOptions {
  platform?: NodeJS.Platform
  readProcessCommand?: (pid: number) => string
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void
  logger?: Pick<Console, 'warn'>
}

export function viteWatchPidfilePath(workspaceDir: string): string {
  return join(workspaceDir, PIDFILE_NAME)
}

export function writeViteWatchPidfile(
  workspaceDir: string,
  info: Omit<ViteWatchPidfile, 'workspaceDir'> & { workspaceDir?: string },
): void {
  const path = viteWatchPidfilePath(workspaceDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      ...info,
      workspaceDir: info.workspaceDir ?? workspaceDir,
    }) + '\n',
    'utf8',
  )
}

/**
 * Remove the pidfile only when it still belongs to `expectedPid`.
 *
 * The PID guard matters when an old watcher's exit handler runs after a new
 * watcher has already written its replacement pidfile.
 */
export function removeViteWatchPidfile(workspaceDir: string, expectedPid?: number): void {
  const path = viteWatchPidfilePath(workspaceDir)
  if (!existsSync(path)) return
  if (expectedPid !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ViteWatchPidfile>
      if (parsed.pid !== expectedPid) return
    } catch {
      // A malformed file is safe to remove.
    }
  }
  try {
    unlinkSync(path)
  } catch {
    // The file may have been removed by another cleanup path.
  }
}

function readPidfile(workspaceDir: string): ViteWatchPidfile | null {
  const path = viteWatchPidfilePath(workspaceDir)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ViteWatchPidfile>
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.pgid !== 'number' ||
      !Number.isInteger(parsed.pgid) ||
      parsed.pgid <= 0 ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.workspaceDir !== 'string' ||
      typeof parsed.bundlerCwd !== 'string'
    ) {
      removeViteWatchPidfile(workspaceDir)
      return null
    }
    return parsed as ViteWatchPidfile
  } catch {
    if (existsSync(path)) removeViteWatchPidfile(workspaceDir)
    return null
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function defaultReadProcessCommand(pid: number, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return childProcess.execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
  }
  return childProcess.execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function isExpectedViteWatchCommand(command: string, record: ViteWatchPidfile): boolean {
  const normalizedCommand = normalizePath(command)
  const roots = [record.workspaceDir, record.bundlerCwd].flatMap((root) => {
    const variants = [root]
    try {
      const realRoot = realpathSync(root)
      if (!variants.includes(realRoot)) variants.push(realRoot)
    } catch {
      // The workspace may have been removed after the runtime exited.
    }
    return variants
  }).map(normalizePath).filter(Boolean)
  return (
    normalizedCommand.includes('build --watch') &&
    normalizedCommand.includes('vite') &&
    roots.some((root) => normalizedCommand.includes(root))
  )
}

/**
 * Kill the detached Vite watch process recorded for a workspace.
 *
 * The process command is checked before signalling so a reused PID can never
 * cause an unrelated process to be killed. A failed process-table lookup is
 * treated as transient and leaves the pidfile for a later cleanup attempt.
 */
export function killViteWatchFromPidfile(
  workspaceDir: string,
  opts: ViteWatchPidfileOptions = {},
): ViteWatchPidfile | null {
  const record = readPidfile(workspaceDir)
  if (!record) return null

  const platform = opts.platform ?? process.platform
  let command: string
  try {
    command = (opts.readProcessCommand ?? ((pid) => defaultReadProcessCommand(pid, platform)))(record.pid)
  } catch (err: any) {
    opts.logger?.warn(
      `[vite-watch] Could not inspect pid ${record.pid}: ${err?.message ?? err}; leaving pidfile for retry`,
    )
    return null
  }

  if (!isExpectedViteWatchCommand(command, record)) {
    removeViteWatchPidfile(workspaceDir, record.pid)
    return null
  }

  const killGroup =
    opts.killGroup ??
    (platform === 'win32'
      ? (pgid: number) => {
          try {
            childProcess.execFileSync('taskkill', ['/F', '/T', '/PID', String(pgid)], {
              stdio: ['pipe', 'pipe', 'pipe'],
            })
          } catch {
            // The process may have exited between inspection and cleanup.
          }
        }
      : (pgid: number, signal: NodeJS.Signals) => {
          try {
            process.kill(-pgid, signal)
          } catch {
            // ESRCH is expected when the group exited during cleanup.
          }
        })

  try {
    killGroup(record.pgid, 'SIGTERM')
  } finally {
    removeViteWatchPidfile(workspaceDir, record.pid)
  }
  return record
}
