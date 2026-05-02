// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-platform shell launcher + process-tree killer used by the IDE
 * Terminal routes in apps/api/src/routes/terminal.ts and the runtime-pod
 * copy in packages/agent-runtime/src/runtime-terminal-routes.ts.
 *
 * Why this exists: the original implementation hardcoded `bash`/`sh` and
 * `detached: true`. On Windows that:
 *   1. Pops a new console window for every spawn (no `windowsHide: true`).
 *   2. Spawns whatever `bash.exe` Windows finds first — typically WSL's
 *      System32 bash — against a Windows-style cwd like
 *      `C:\dev\shogo-ai\workspaces\<id>`, which the POSIX launcher can't
 *      `cd` into. The user sees `[exit 1]` for `cd files`, `ls`, etc.
 *
 * The fix: on win32 we use PowerShell (always available on Windows 10+),
 * which has built-in `cd`, `ls`, `pwd` aliases so user-typed shell-isms
 * Just Work. On Unix we keep the original `bash`/`sh` paths byte-for-byte
 * so the existing terminal-bench / Linux runtime-pod behavior is
 * unchanged.
 */
import { execFile, spawn, type ChildProcess } from 'child_process'

export const IS_WINDOWS = process.platform === 'win32'

/**
 * Spawn a free-form shell command with cwd-tracking semantics. On Unix
 * this is the original `bash -c` launcher that exports OLDPWD, runs
 * `eval "$SHOGO_CMD"`, captures `pwd` to a side-file, and exits with the
 * command's RC. On Windows it's a PowerShell equivalent that uses
 * `Set-Location`, `Invoke-Expression`, and `(Get-Location).Path`.
 *
 * The PowerShell launcher carefully distinguishes between cmdlet failures
 * (`-not $?`) and external-program exit codes (`$LASTEXITCODE`) so
 * `cd nonexistent` returns exit 1 and `bun install` propagates whatever
 * bun exits with. `-NoProfile -NonInteractive` keeps spawn fast and
 * deterministic across user PowerShell profile customizations.
 */
export function spawnRunShell(args: {
  command: string
  effectiveCwd: string
  rootDir: string
  pwdFile: string
  prevCwd: string
  extraEnv?: NodeJS.ProcessEnv
}): ChildProcess {
  const { command, effectiveCwd, rootDir, pwdFile, prevCwd, extraEnv } = args
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SHOGO_CMD: command,
    SHOGO_CWD: effectiveCwd,
    SHOGO_ROOT: rootDir,
    SHOGO_PWD_FILE: pwdFile,
    OLDPWD: prevCwd,
    SHOGO_OLDPWD: prevCwd,
    HOME: process.env.HOME || rootDir,
    PWD: effectiveCwd,
    FORCE_COLOR: '1',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
    TERM: process.env.TERM || 'xterm-256color',
    ...extraEnv,
  }

  if (IS_WINDOWS) {
    // PowerShell launcher mirroring the bash one: cd to caller's cwd
    // (falling back to the project root), run user input via
    // Invoke-Expression, write the post-command pwd to the side-file,
    // and exit with a sane RC that distinguishes cmdlet failures from
    // external-program exits.
    //
    // RC detection has two parts because PowerShell's failure surface
    // is bifurcated:
    //   * `$LASTEXITCODE` is only set by EXTERNAL programs (node, bun,
    //     git, …). A non-zero value means "the program exited non-zero".
    //   * Cmdlet failures (`cd missing`, `Get-ChildItem missing`, …) are
    //     non-terminating errors that DON'T touch $LASTEXITCODE and DON'T
    //     flip $? when wrapped in Invoke-Expression — IE itself succeeds
    //     even when the cmdlet inside it errors out. We detect them by
    //     clearing `$Error` first and counting entries afterwards. This
    //     is the standard PowerShell idiom for "did anything fail?".
    //
    // We join with newlines, NOT '; ': PowerShell's parser treats
    // `try { ... };` as a complete statement and then chokes on the
    // following `catch` ("The Try statement is missing its Catch or
    // Finally block"). Newlines avoid that footgun and also keep the
    // -Command argv readable in process listings.
    const launcher = [
      "$ErrorActionPreference = 'Continue'",
      'try { Set-Location -LiteralPath $env:SHOGO_CWD -ErrorAction Stop } catch { Set-Location -LiteralPath $env:SHOGO_ROOT }',
      '$env:OLDPWD = $env:SHOGO_OLDPWD',
      '$Error.Clear()',
      '$global:LASTEXITCODE = 0',
      'Invoke-Expression $env:SHOGO_CMD',
      '$rc = if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($Error.Count -gt 0) { 1 } else { 0 }',
      '[System.IO.File]::WriteAllText($env:SHOGO_PWD_FILE, (Get-Location).Path)',
      'exit $rc',
    ].join('\n')
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], {
      cwd: effectiveCwd,
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }

  // Unix: keep the original bash launcher byte-for-byte so existing
  // behavior + tests are unchanged.
  const launcher =
    'cd -- "${SHOGO_CWD:-$SHOGO_ROOT}" 2>/dev/null || cd -- "$SHOGO_ROOT"; ' +
    'export OLDPWD="${SHOGO_OLDPWD:-$PWD}"; ' +
    'eval "$SHOGO_CMD"; ' +
    '__shogo_rc=$?; ' +
    '{ pwd > "$SHOGO_PWD_FILE"; } 2>/dev/null; ' +
    'exit $__shogo_rc'
  return spawn('bash', ['-c', launcher], {
    cwd: effectiveCwd,
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
}

/**
 * Spawn a single preset command (no cwd tracking). On Unix `sh -c <cmd>`
 * keeps shell features (pipes, redirects, `&&`, env-expansion). On
 * Windows `powershell.exe -Command <cmd>` provides the same — `bun
 * install`, `bun x prisma generate`, `bun run build` all run as-is.
 */
export function spawnPresetShell(args: {
  command: string
  cwd: string
  extraEnv?: NodeJS.ProcessEnv
}): ChildProcess {
  const { command, cwd, extraEnv } = args
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '1',
    CI: 'true',
    ...extraEnv,
  }

  if (IS_WINDOWS) {
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }

  return spawn('sh', ['-c', command], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
}

/**
 * Returns a function that terminates `child` and its descendants. Two-
 * phase: a soft signal (SIGTERM / `taskkill /T`) first so well-behaved
 * programs can clean up, a hard kill 2s later for anything that ignores
 * it. Safe to call repeatedly.
 *
 * On Unix we signal the process group via negative pid; this requires
 * the child to have been spawned with `detached: true`. On Windows
 * `process.kill(-pid)` is meaningless, so we shell out to `taskkill /T`
 * which walks the Job/parent-pid tree. `windowsHide: true` keeps
 * taskkill from flashing its own console window.
 */
export function makeKillChild(child: ChildProcess) {
  let killed = false

  const killUnix = (sig: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {
        /* already exited */
      }
    }
  }

  const killWindows = (force: boolean) => {
    if (!child.pid) return
    const args = force
      ? ['/T', '/F', '/PID', String(child.pid)]
      : ['/T', '/PID', String(child.pid)]
    try {
      execFile('taskkill', args, { windowsHide: true }, () => {
        /* swallow: taskkill prints status text we don't care about, and
         * the process may already be gone (race with normal exit). */
      })
    } catch {
      try {
        child.kill()
      } catch {
        /* already exited */
      }
    }
  }

  return function killChild(signal: NodeJS.Signals = 'SIGTERM') {
    if (killed) return
    killed = true
    if (IS_WINDOWS) {
      killWindows(false)
    } else {
      killUnix(signal)
    }
    setTimeout(() => {
      if (child.killed || child.exitCode !== null) return
      if (IS_WINDOWS) {
        killWindows(true)
      } else {
        killUnix('SIGKILL')
      }
    }, 2_000).unref?.()
  }
}
