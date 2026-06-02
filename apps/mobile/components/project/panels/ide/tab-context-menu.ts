// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-COPY-PATH — editor-tab right-click context menu.
 *
 * Shogo's editor tabs had no context menu at all. VS Code's tab context
 * menu exposes Copy Path, Copy Relative Path, Reveal in Finder/Explorer,
 * and the close family (Close, Close Others, Close to the Right, Close
 * All). This module is the pure, side-effect-free brain behind that menu,
 * mirroring the extraction pattern of quick-open-disambiguate.ts /
 * diff-view-mode.ts / minimap-settings.ts / problems-navigation.ts: no
 * React, no clipboard, no shell/Finder call, no DOM. The React menu and
 * the platform-action layer stay thin and every rule is unit-testable.
 *
 * What lives here:
 *   • The Tab model + menu action ids.
 *   • Path computation: `tabAbsolutePath` and `tabRelativePath` (the two
 *     "Copy" payloads) — relative path is workspace-root-relative with
 *     normalised separators, the exact bug the feature fixes.
 *   • `buildTabContextMenu` — produces the ordered menu model with each
 *     item's `enabled` flag and separators, given the clicked tab, the
 *     full tab list, and environment facts (platform, whether the file is
 *     on disk). "Reveal in Finder" relabels per-platform and disables for
 *     virtual/untitled tabs; "Close Others/Right/All" disable when they
 *     would be no-ops.
 *   • `tabsToClose` — resolves WHICH tabs a close-action targets, so the
 *     reducer doesn't re-derive it. Honours pinned tabs.
 *   • `revealActionLabel` — platform-correct label.
 *
 * Deliberately NOT here: clipboard writes, shell calls, React, DOM.
 */

export type TabMenuActionId =
  | "copyPath"
  | "copyRelativePath"
  | "reveal"
  | "close"
  | "closeOthers"
  | "closeToRight"
  | "closeAll"

export type Platform = "mac" | "windows" | "linux"

export interface Tab {
  /** Stable id (usually the absolute path, but kept separate for virtual tabs). */
  id: string
  /** Absolute filesystem path, or null for untitled/virtual documents. */
  path: string | null
  /** Display label (basename or "Untitled-1"). */
  label?: string
  /** Pinned tabs are excluded from bulk closes (VS Code parity). */
  pinned?: boolean
}

export interface TabMenuItem {
  id: TabMenuActionId
  label: string
  enabled: boolean
  /** True when a separator should be rendered BEFORE this item. */
  separatorBefore?: boolean
}

export interface BuildMenuEnv {
  platform?: Platform
  /**
   * Whether the clicked tab's file actually exists on disk. Defaults to
   * "has a non-null path". Reveal requires a real on-disk file.
   */
  onDisk?: boolean
}

/** Normalise back-slashes to forward and collapse duplicate separators. */
function normalizeSeparators(p: string): string {
  return p.replace(/\\+/g, "/").replace(/\/{2,}/g, "/")
}

/** Strip a single trailing slash (but never reduce "/" to ""). */
function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p
}

/** The absolute-path copy payload. Null when the tab is virtual/untitled. */
export function tabAbsolutePath(tab: Tab): string | null {
  if (!tab || typeof tab.path !== "string" || tab.path.length === 0) return null
  return normalizeSeparators(tab.path)
}

/**
 * The relative-path copy payload: the tab's path relative to the
 * workspace root, with normalised forward-slash separators and no leading
 * "./". This is the behaviour Shogo lacked entirely.
 *
 * - Virtual/untitled tab → null.
 * - No/empty workspace root → falls back to the absolute path.
 * - Path outside the workspace root → returns the absolute path (VS Code
 *   copies the full path when the file isn't under the folder).
 * - Path === root → "" (the root itself).
 * - Case-insensitive root match on Windows/mac; case-sensitive on Linux.
 */
export function tabRelativePath(
  tab: Tab,
  workspaceRoot: string | null | undefined,
  platform: Platform = "linux",
): string | null {
  const abs = tabAbsolutePath(tab)
  if (abs == null) return null
  if (!workspaceRoot || workspaceRoot.length === 0) return abs

  const root = stripTrailingSlash(normalizeSeparators(workspaceRoot))
  const caseInsensitive = platform !== "linux"
  const a = caseInsensitive ? abs.toLowerCase() : abs
  const r = caseInsensitive ? root.toLowerCase() : root

  if (a === r) return ""
  // Must match root followed by a separator to be "inside" (avoids
  // /work matching /workspace).
  if (a.startsWith(r + "/")) {
    return abs.slice(root.length + 1)
  }
  return abs
}

/** Platform-correct label for the reveal action. */
export function revealActionLabel(platform: Platform = "linux"): string {
  if (platform === "mac") return "Reveal in Finder"
  if (platform === "windows") return "Reveal in File Explorer"
  return "Open Containing Folder"
}

/**
 * Resolve which tabs a close-action targets. Pinned tabs are preserved by
 * the bulk closers (Others / Right / All), matching VS Code. Returns a new
 * array; never mutates the input.
 */
export function tabsToClose(
  action: Extract<TabMenuActionId, "close" | "closeOthers" | "closeToRight" | "closeAll">,
  clickedId: string,
  tabs: Tab[],
): Tab[] {
  const list = Array.isArray(tabs) ? tabs : []
  const idx = list.findIndex((t) => t.id === clickedId)
  switch (action) {
    case "close":
      return idx === -1 ? [] : [list[idx]]
    case "closeOthers":
      return list.filter((t, i) => i !== idx && !t.pinned)
    case "closeToRight":
      if (idx === -1) return []
      return list.slice(idx + 1).filter((t) => !t.pinned)
    case "closeAll":
      return list.filter((t) => !t.pinned)
    default:
      return []
  }
}

/**
 * Build the ordered tab context-menu model. Each item carries its own
 * `enabled` flag so the React layer renders dumbly. Enablement rules:
 *
 *   • Copy Path / Copy Relative Path — enabled only for on-disk files
 *     (a path exists). Untitled tabs have nothing to copy.
 *   • Reveal — enabled only when the file is on disk; relabelled per OS.
 *   • Close — always enabled (you can always close the clicked tab).
 *   • Close Others — enabled only if there is at least one OTHER
 *     non-pinned, closable tab.
 *   • Close to the Right — enabled only if at least one non-pinned tab
 *     exists to the right of the clicked tab.
 *   • Close All — enabled if there is at least one non-pinned tab.
 */
export function buildTabContextMenu(
  clicked: Tab,
  tabs: Tab[],
  workspaceRoot?: string | null,
  env: BuildMenuEnv = {},
): TabMenuItem[] {
  const platform = env.platform ?? "linux"
  const list = Array.isArray(tabs) ? tabs : []
  const hasPath = tabAbsolutePath(clicked) != null
  const onDisk = env.onDisk ?? hasPath

  const closeOthersTargets = tabsToClose("closeOthers", clicked.id, list)
  const closeRightTargets = tabsToClose("closeToRight", clicked.id, list)
  const closeAllTargets = tabsToClose("closeAll", clicked.id, list)

  return [
    { id: "copyPath", label: "Copy Path", enabled: hasPath },
    { id: "copyRelativePath", label: "Copy Relative Path", enabled: hasPath },
    { id: "reveal", label: revealActionLabel(platform), enabled: onDisk, separatorBefore: true },
    { id: "close", label: "Close", enabled: true, separatorBefore: true },
    { id: "closeOthers", label: "Close Others", enabled: closeOthersTargets.length > 0 },
    { id: "closeToRight", label: "Close to the Right", enabled: closeRightTargets.length > 0 },
    { id: "closeAll", label: "Close All", enabled: closeAllTargets.length > 0 },
  ]
}
