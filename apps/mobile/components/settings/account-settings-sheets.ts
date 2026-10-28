// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings tabs surfaced on native Account. Each row opens a bottom sheet
 * with the existing Settings tab body — no push to `/(app)/settings`.
 *
 * Matches the phone Settings tab bar, minus the desktop-only tabs (`updates`,
 * `computer-files`) that cannot render on a handset. Tabs already inlined on
 * Account (email, API keys) are in the type but not in the row list below.
 */
import {
  settingsTab,
  visibleSettingsTabs,
  type SettingsTabId,
  type SettingsTabDefinition,
} from "../../lib/settings-tabs";

export type AccountSettingsSheetTab = Exclude<
  SettingsTabId,
  "updates" | "computer-files"
>;

type SheetTabId = Exclude<AccountSettingsSheetTab, "appearance" | "account">;
type SheetTabDef = Pick<SettingsTabDefinition, "id" | "Icon"> & {
  id: SheetTabId;
};

const SHEET_TAB_IDS = new Set<SheetTabId>([
  "workspace",
  "people",
  "chat",
  "models",
  "integrations",
  "automations",
  "remote-control",
  "billing",
  "compute",
  "security",
]);

function isSheetTab(id: SettingsTabId): id is SheetTabId {
  return SHEET_TAB_IDS.has(id as SheetTabId);
}

export function accountSettingsSheetTitle(
  tab: AccountSettingsSheetTab
): string {
  return settingsTab(tab).label;
}

export function accountSettingsSheetGroups({
  localMode,
  showBilling,
  platform,
  teamChat,
}: {
  localMode?: boolean;
  showBilling?: boolean;
  platform?: string;
  teamChat?: boolean;
}): Array<{ title: string; tabs: Array<SheetTabDef & { label: string }> }> {
  const tabs = visibleSettingsTabs({ localMode, showBilling, platform, teamChat })
    .filter((tab) => isSheetTab(tab.id))
    .map((tab) => ({
      id: tab.id as SheetTabId,
      Icon: tab.Icon,
      label: tab.label,
    }));
  const settings = tabs.filter(
    (tab) => settingsTab(tab.id).group === "settings"
  );
  const plan = tabs.filter((tab) => settingsTab(tab.id).group === "plan");
  const groups: Array<{
    title: string;
    tabs: Array<SheetTabDef & { label: string }>;
  }> = [];
  if (settings.length) groups.push({ title: "Settings", tabs: settings });
  if (plan.length) groups.push({ title: "Plan", tabs: plan });
  return groups;
}
