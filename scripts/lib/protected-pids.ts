// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pids that repo scripts must never signal.
 *
 * `bun dev:all` clears the API/web ports by `lsof -ti:<port> | xargs kill -9`.
 * That is the right thing for a leftover dev stack and a fatal thing for the
 * running Shogo desktop app, which owns its own long-lived API child on port
 * 39100 and re-reads `api.pid` on the next launch. On 2026-10-18 an agent
 * shell that had inherited `API_PORT=39100` ran `bun dev:all` and SIGKILLed
 * the desktop's API (SHO-26).
 *
 * The desktop app writes its API child's pid to `<SHOGO_DATA_DIR>/api.pid`
 * (apps/desktop/src/local-server.ts) and exports `SHOGO_DATA_DIR` into the API
 * (and therefore agent-runtime, and therefore agent exec shells) env, so a
 * script can identify the app's process without any new plumbing.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Reads the desktop app's owned pids.
 *
 * Returns an empty set when `SHOGO_DATA_DIR` is unset (i.e. not running under
 * the desktop app's shell) or the pid file is missing/garbage — there is
 * nothing to protect in that case, and guessing a userData path would be
 * wrong on every platform we ship.
 */
export function readProtectedPids(env: NodeJS.ProcessEnv = process.env): Set<number> {
  const pids = new Set<number>()
  const dataDir = env.SHOGO_DATA_DIR?.trim()
  if (!dataDir) return pids

  const pidFile = join(dataDir, 'api.pid')
  if (!existsSync(pidFile)) return pids

  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  } catch {
    // Unreadable pid file: treat as "nothing to protect" rather than failing
    // the whole dev command.
  }
  return pids
}
