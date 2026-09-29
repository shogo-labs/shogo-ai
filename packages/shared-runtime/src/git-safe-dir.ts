// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Git ownership guard for runtimes that run as root.
 *
 * Metal (Firecracker) guests exec the runtime as root from PID 1, while the
 * image chowns `/app/workspace` to `appuser` (uid 1001). Git >= 2.35.2 then
 * refuses every command in that repo with "detected dubious ownership", so
 * the per-turn committer never commits and the durable `.git` stays empty.
 *
 * The image sets `safe.directory=*` in the system gitconfig; this is the
 * in-process fallback for rootfs builds that predate it. `safe.directory` is
 * only honored from protected config, and `GIT_CONFIG_COUNT` entries count as
 * command-line config, so exporting them covers every git child process
 * (the sync, LFS, and the agent's own shell).
 */

import { spawn } from 'child_process'

export const DUBIOUS_OWNERSHIP_RE = /dubious ownership/i

/**
 * Append `safe.directory=*` to the `GIT_CONFIG_*` env chain when running as
 * root. No-op for non-root processes (desktop/local users own their repos, and
 * we don't want to disable the check for them) or when already present.
 * Returns true when the env was changed.
 */
export function applyGitSafeDirectoryEnv(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null,
): boolean {
  if (uid !== 0) return false
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10)
  const n = Number.isFinite(count) && count > 0 ? count : 0
  for (let i = 0; i < n; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`] === 'safe.directory' && env[`GIT_CONFIG_VALUE_${i}`] === '*') {
      return false
    }
  }
  env[`GIT_CONFIG_KEY_${n}`] = 'safe.directory'
  env[`GIT_CONFIG_VALUE_${n}`] = '*'
  env.GIT_CONFIG_COUNT = String(n + 1)
  return true
}

export interface GitUsability {
  ok: boolean
  /** True when git rejected the repo for ownership reasons. */
  dubiousOwnership: boolean
  stderr: string
}

/**
 * Probe whether git can operate in `workspaceDir` (`git status`). Used at
 * startup so an unusable repo is reported once, loudly, instead of surfacing
 * as an endless stream of sync retries.
 */
export function checkGitUsable(workspaceDir: string): Promise<GitUsability> {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: workspaceDir,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (c) => { stderr += String(c) })
    child.on('error', (err) => resolve({ ok: false, dubiousOwnership: false, stderr: err.message }))
    child.on('close', (code) =>
      resolve({ ok: code === 0, dubiousOwnership: DUBIOUS_OWNERSHIP_RE.test(stderr), stderr: stderr.slice(0, 500) }),
    )
  })
}
