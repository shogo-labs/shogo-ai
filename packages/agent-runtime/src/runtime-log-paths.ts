// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Paths for Vite/API build output and unified runtime console logs.
 * Both live next to the app template under workspace `project/` (same cwd as PreviewManager.projectDir).
 */
import { join } from 'path'

export const PREVIEW_SUBDIR = 'project'
export const BUILD_LOG_FILE = '.build.log'
export const CONSOLE_LOG_FILE = '.console.log'

export function previewBuildLogPath(workspaceRoot: string): string {
  return join(workspaceRoot, PREVIEW_SUBDIR, BUILD_LOG_FILE)
}

export function previewConsoleLogPath(workspaceRoot: string): string {
  return join(workspaceRoot, PREVIEW_SUBDIR, CONSOLE_LOG_FILE)
}
