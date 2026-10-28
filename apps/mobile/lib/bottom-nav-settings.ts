// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * What the bottom nav's ⚙️ opens.
 *
 * Inside a project it is that project's own settings — the way Slack's channel
 * details are — and on Home it is workspace settings. Workspace settings stay
 * reachable from the sidebar either way, which is why a project does not need a
 * second route to them (SHO-220).
 */
export interface SettingsTarget {
  /** Hand the sheet the project's settings instead of the workspace's. */
  openProjectSettings: boolean
}

export function settingsTargetFor(projectMode: boolean): SettingsTarget {
  return { openProjectSettings: projectMode }
}
