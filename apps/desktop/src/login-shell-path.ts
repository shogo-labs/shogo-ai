// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PATH for the local API and everything it spawns (agent runtimes, the
 * agent's shell).
 *
 * A macOS app launched from Finder/Dock inherits launchd's PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's shell PATH. The agent's
 * `exec` runs `/bin/sh -c` with that env, so `docker`, `brew`, `node`, `npm`,
 * `gh`, `uv`, ... all fail with "command not found" and any "clone this repo
 * and make it work" request dead-ends. Resolve the login shell's PATH once at
 * startup (what `fix-path` / VS Code do) and always include the standard
 * Homebrew / Docker Desktop directories in case the shell can't be read.
 */
import { execFile } from 'child_process'
import { existsSync } from 'fs'

const MARKER = '__SHOGO_LOGIN_PATH__'

/** Where Homebrew (Apple silicon + Intel) and Docker Desktop install CLIs. */
export const WELL_KNOWN_UNIX_BIN_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']

/** Join PATH lists in priority order, dropping empties and duplicates. */
export function mergePathLists(...lists: Array<string | null | undefined>): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const entry of (list ?? '').split(':')) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      out.push(entry)
    }
  }
  return out.join(':')
}

/** Pull the PATH out of shell output that may include rc-file noise around it. */
export function parseLoginShellOutput(stdout: string): string | null {
  const start = stdout.indexOf(MARKER)
  const end = start === -1 ? -1 : stdout.indexOf(MARKER, start + MARKER.length)
  if (end === -1) return null
  const path = stdout.slice(start + MARKER.length, end).trim()
  return path.length > 0 ? path : null
}

/**
 * The user's interactive login-shell PATH, or null when it can't be read
 * within `timeoutMs` (slow rc files, a shell that prompts, no $SHELL).
 */
export function readLoginShellPath(
  opts: { shell?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const shell = opts.shell ?? process.env.SHELL ?? '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`],
      {
        timeout: opts.timeoutMs ?? 5_000,
        encoding: 'utf-8',
        env: { ...(opts.env ?? process.env), DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true' },
      },
      (_err, stdout) => resolve(parseLoginShellOutput(String(stdout ?? ''))),
    )
  })
}

/**
 * PATH to hand the local API: bundled bun first, then the login shell's
 * PATH, the inherited PATH, and whichever well-known bin dirs exist.
 */
export async function resolveDesktopPath(opts: {
  bunDir: string
  inheritedPath: string | undefined
  platform?: NodeJS.Platform
  readShellPath?: () => Promise<string | null>
  exists?: (path: string) => boolean
}): Promise<string> {
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') {
    return [opts.bunDir, opts.inheritedPath].filter(Boolean).join(';')
  }
  const exists = opts.exists ?? existsSync
  const shellPath = await (opts.readShellPath ?? (() => readLoginShellPath()))().catch(() => null)
  const wellKnown = WELL_KNOWN_UNIX_BIN_DIRS.filter((dir) => exists(dir)).join(':')
  return mergePathLists(opts.bunDir, shellPath, opts.inheritedPath || '/usr/bin:/bin:/usr/sbin:/sbin', wellKnown)
}
