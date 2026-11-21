// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `main.log`: where the desktop keeps the record of a launch that did not work.
 *
 * The shell's console is teed into this file from `main.ts`, but that tee is a
 * buffered `createWriteStream` — a line written just before the process quits
 * never reaches disk. Startup failures are exactly the lines written just before
 * the process quits, so the migrate step writes its own through
 * `appendMainLogLineSync` (SHO-482: the FATAL line was in `main.log` and the
 * migration output that explained it was not).
 *
 * Electron-free on purpose: `apps/desktop/src/__tests__` must not import
 * electron, so the caller passes the paths it got from `app`.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The directory both the console tee and the startup writer use. */
export function resolveMainLogDir(opts: {
  platform?: NodeJS.Platform
  userDataDir: string
  homeDir: string
}): string {
  const platform = opts.platform ?? process.platform
  return platform === 'win32'
    ? path.join(opts.userDataDir, 'logs')
    : path.join(opts.homeDir, 'Library', 'Logs', 'Shogo')
}

export function formatLogMessage(args: unknown[]): string {
  return args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ')
}

export function formatLogLine(level: string, args: unknown[], now: Date = new Date()): string {
  return `${now.toISOString()} [${level}] ${formatLogMessage(args)}\n`
}

/**
 * Append one line and return only once it is on disk.
 *
 * A failed write is not worth throwing over — the process is usually on its way
 * out anyway — so this reports false and the caller moves on.
 */
export function appendMainLogLineSync(logFile: string, level: string, ...args: unknown[]): boolean {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, formatLogLine(level, args))
    return true
  } catch {
    return false
  }
}
