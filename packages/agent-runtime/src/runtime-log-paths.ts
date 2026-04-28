// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Paths for Vite/API build output and unified runtime console logs.
 *
 * Historically these lived under `<workspace>/project/` because the only
 * supported stack (Vite) seeded its app there. Expo / RN stacks put the
 * package.json at the workspace root instead — so the helpers now resolve
 * the bundler cwd from the workspace root by checking which layout exists,
 * matching `PreviewManager.resolveBundlerCwd()`.
 */
import { existsSync } from 'fs'
import { join } from 'path'

/** Legacy Vite layout — used by the `react-app`, `threejs-game`, `phaser-game` stacks. */
export const PREVIEW_SUBDIR = 'project'
export const BUILD_LOG_FILE = '.build.log'
export const CONSOLE_LOG_FILE = '.console.log'

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

export function previewBuildLogPath(workspaceRoot: string): string {
  return join(resolveBundlerCwd(workspaceRoot), BUILD_LOG_FILE)
}

export function previewConsoleLogPath(workspaceRoot: string): string {
  return join(resolveBundlerCwd(workspaceRoot), CONSOLE_LOG_FILE)
}
