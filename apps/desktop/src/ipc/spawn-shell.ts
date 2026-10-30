// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The executable a terminal session spawns. The renderer names shells the
 * way its picker shows them (`cmd`, `bash`), but ConPTY on Windows only
 * finds a program by its full file name — a bare `cmd` fails with
 * "File not found".
 */
export function resolveSpawnShell(
  shell: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!shell) {
    if (platform === 'win32') return env.ComSpec || env.COMSPEC || 'pwsh.exe'
    return env.SHELL || '/bin/zsh'
  }
  if (platform !== 'win32' || /[\\/]/.test(shell) || /\.[A-Za-z0-9]+$/.test(shell)) return shell
  if (shell.toLowerCase() === 'cmd') return env.ComSpec || env.COMSPEC || 'cmd.exe'
  return `${shell}.exe`
}
