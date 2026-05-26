// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Paths for Vite/API build output and unified runtime console logs.
 *
 * Logs live under `<workspaceRoot>/.shogo/logs/` since 2026-05.
 * Previously they sat at `<bundlerCwd>/.{build,console}.log` — directly
 * next to `index.html`, `tsconfig.json`, and the rest of the project
 * sources. On Windows that was the canonical trigger for a vite-watch
 * rebuild loop: chokidar's parent-directory `fs.watch` fires on metadata
 * changes to any sibling of a watched file, every `appendFileSync` to
 * `.build.log` re-entered Rollup's input graph evaluation, and a single
 * agent boot would burn a full CPU core forever in 1-module / 0-module
 * rebuilds. Moving the logs under `.shogo/` puts them inside a directory
 * that:
 *
 *   - `tsconfig.json`'s `watchOptions.excludeDirectories` already lists
 *     (`**\/.shogo`),
 *   - the workspace `.gitignore` and `git.service.ts`'s
 *     `REQUIRED_IGNORE_ENTRIES` already mark as untracked, and
 *   - lives outside the bundler-cwd → no chokidar parent-dir trigger.
 *
 * `BUILD_LOG_FILE` / `CONSOLE_LOG_FILE` / `PREVIEW_SUBDIR` are retained
 * as named exports for back-compat with callers that still reference the
 * old constants (notably tests and older sibling packages); new code
 * should go through `previewBuildLogPath()` / `previewConsoleLogPath()`.
 */
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

/** Legacy Vite layout — used by the `react-app`, `threejs-game`, `phaser-game` stacks. */
export const PREVIEW_SUBDIR = 'project'
/**
 * Legacy log basenames. Kept exported so older tooling/tests can still
 * import them, but no longer used to derive the active log paths — see
 * `RUNTIME_LOG_SUBDIR` and the `*_BASENAME` constants below.
 */
export const BUILD_LOG_FILE = '.build.log'
export const CONSOLE_LOG_FILE = '.console.log'

/**
 * New canonical layout: `<workspaceRoot>/.shogo/logs/{build,console}.log`.
 * Sits inside `.shogo/` which is already excluded from tsconfig watch,
 * git, and the per-checkpoint snapshotter — see file docstring for the
 * vite-watch rebuild-loop history that drove the move.
 */
export const RUNTIME_LOG_SUBDIR = join('.shogo', 'logs')
export const BUILD_LOG_BASENAME = 'build.log'
export const CONSOLE_LOG_BASENAME = 'console.log'

/**
 * Resolve where the bundler's package.json + log files actually live for
 * a given workspace root. Returns `<workspaceRoot>/project/` if the legacy
 * Vite layout is present (Vite stacks), otherwise falls back to the
 * workspace root itself (Expo / RN / unscaffolded).
 *
 * IMPORTANT: this mirrors the logic in `PreviewManager.resolveBundlerCwd()`.
 * Keep them in sync — both are consulted from different processes for the
 * same workspace, and a divergence means the agent and the runtime write
 * logs to different files.
 */
export function resolveBundlerCwd(workspaceRoot: string): string {
  const legacy = join(workspaceRoot, PREVIEW_SUBDIR)
  if (existsSync(join(legacy, 'package.json'))) return legacy
  if (existsSync(join(workspaceRoot, 'package.json'))) return workspaceRoot
  // Empty workspace — fall back to the legacy Vite layout so unrelated callers
  // (e.g. the agent prompt's pre-seed `.console.log` reset) keep their old
  // behaviour. Once a stack is seeded and creates a package.json, subsequent
  // calls will return the correct cwd.
  return legacy
}

/**
 * Absolute path of the current runtime build log. Always under
 * `<workspaceRoot>/.shogo/logs/` regardless of stack — Vite and Expo
 * workspaces share the same `.shogo/` dir.
 */
export function previewBuildLogPath(workspaceRoot: string): string {
  return join(workspaceRoot, RUNTIME_LOG_SUBDIR, BUILD_LOG_BASENAME)
}

/** Absolute path of the current runtime console log. See `previewBuildLogPath`. */
export function previewConsoleLogPath(workspaceRoot: string): string {
  return join(workspaceRoot, RUNTIME_LOG_SUBDIR, CONSOLE_LOG_BASENAME)
}

/**
 * mkdir -p the directory that holds `build.log` / `console.log`. Cheap
 * and idempotent — callers run it before `appendFileSync` /
 * `writeFileSync` so the first write to a fresh workspace doesn't ENOENT.
 *
 * Best-effort: returns the directory path either way. If the mkdir fails
 * (permission, racing concurrent writer, parent gone) the caller's
 * subsequent write will throw the more useful error.
 */
export function ensureRuntimeLogDir(workspaceRoot: string): string {
  const dir = join(workspaceRoot, RUNTIME_LOG_SUBDIR)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Swallow — writers protect themselves with their own try/catch.
  }
  return dir
}
