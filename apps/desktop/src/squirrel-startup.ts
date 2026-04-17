// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn } from 'child_process'
import path from 'path'
import { app } from 'electron'

/**
 * Handles Squirrel.Windows lifecycle events (install, update, uninstall, obsolete).
 * Returns true if a Squirrel event was handled and the app should exit immediately.
 */
export function handleSquirrelEvent(): boolean {
  if (process.platform !== 'win32') return false

  const squirrelArg = process.argv.find(arg => arg.startsWith('--squirrel-'))
  if (!squirrelArg) return false

  const appFolder = path.resolve(process.execPath, '..')
  const rootFolder = path.resolve(appFolder, '..')
  const updateDotExe = path.join(rootFolder, 'Update.exe')
  const exeName = path.basename(process.execPath)

  function runSquirrelCommand(args: string[]): void {
    try {
      spawn(updateDotExe, args, { detached: true })
    } catch {
      // Update.exe may not exist in dev; ignore
    }
  }

  switch (squirrelArg) {
    case '--squirrel-install':
    case '--squirrel-updated':
      runSquirrelCommand(['--createShortcut', exeName])
      return true

    case '--squirrel-uninstall':
      runSquirrelCommand(['--removeShortcut', exeName])
      return true

    case '--squirrel-obsolete':
      return true

    default:
      return false
  }
}
