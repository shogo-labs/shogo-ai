// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings tabs surfaced on native Account. Each row opens a bottom sheet
 * with the existing Settings tab body — no push to `/(app)/settings`.
 *
 * Matches the phone Settings tab bar, minus Compute (hidden on iOS) and
 * tabs already inlined on Account (email, API keys).
 */
import {
  settingsTab,
  visibleSettingsTabs,
  type SettingsTabId,
  type SettingsTabDefinition,
} from "../../lib/settings-tabs"

export type AccountSettingsSheetTab = Exclude<SettingsTabId, "compute">

type SheetTabId = Exclude<AccountSettingsSheetTab, "appearance" | "account">
type SheetTabDef = Pick<SettingsTabDefinition, "id" | "Icon"> & {
  id: SheetTabId
}

const SHEET_TAB_IDS = new Set<SheetTabId>([
  "workspace",
  "people",
  "models",
  "integrations",
  "remote-control",
  "billing",
  "analytics",
  "costs",
  "security",
  "support",
])

function isSheetTab(id: SettingsTabId): id is SheetTabId {
  return SHEET_TAB_IDS.has(id as SheetTabId)
}

export function accountSettingsSheetTitle(tab: AccountSettingsSheetTab): string {
  return settingsTab(tab).label
}

export function accountSettingsSheetGroups({
  localMode,
  showBilling,
}: {
  localMode?: boolean
  showBilling?: boolean
}): Array<{ title: string; tabs: Array<SheetTabDef & { label: string }> }> {
  const tabs = visibleSettingsTabs({ localMode, showBilling })
    .filter((tab) => isSheetTab(tab.id))
    .map((tab) => ({
      id: tab.id as SheetTabId,
      Icon: tab.Icon,
      label: tab.label,
    }))
  const settings = tabs.filter((tab) => settingsTab(tab.id).group === "settings")
  const plan = tabs.filter((tab) => settingsTab(tab.id).group === "plan")
  const groups: Array<{ title: string; tabs: Array<SheetTabDef & { label: string }> }> = []
  if (settings.length) groups.push({ title: "Settings", tabs: settings })
  if (plan.length) groups.push({ title: "Plan", tabs: plan })
  return groups
}
