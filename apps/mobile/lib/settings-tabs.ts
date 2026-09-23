// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  BarChart3,
  Boxes,
  Building2,
  Coins,
  CreditCard,
  Monitor,
  Paintbrush,
  Plug,
  RefreshCw,
  Server,
  Shield,
  User,
  Users,
  type LucideIcon,
} from "lucide-react-native";

export type SettingsTabId =
  | "workspace"
  | "people"
  | "models"
  | "integrations"
  | "remote-control"
  | "account"
  | "security"
  | "billing"
  | "compute"
  | "analytics"
  | "costs"
  | "appearance"
  | "updates";

export type SettingsTabGroup = "settings" | "plan" | "personal";

export type SettingsTabDefinition = {
  id: SettingsTabId;
  label: string;
  Icon: LucideIcon;
  group: SettingsTabGroup;
  cloudOnly?: boolean;
  localOnly?: boolean;
  /** Only shown when running inside the Electron desktop shell — regardless
   * of `localMode` (a cloud-connected desktop install still needs the
   * updater, since `localMode` there reflects the app-mode API, not whether
   * the client is Electron). See `visibleSettingsTabs`'s `isDesktop` param. */
  desktopOnly?: boolean;
};

export const SETTINGS_TABS: readonly SettingsTabDefinition[] = [
  { id: "workspace", label: "Workspace", Icon: Building2, group: "settings" },
  {
    id: "people",
    label: "People",
    Icon: Users,
    group: "settings",
    cloudOnly: true,
  },
  {
    id: "models",
    label: "Models",
    Icon: Boxes,
    group: "settings",
    cloudOnly: true,
  },
  { id: "integrations", label: "Integrations", Icon: Plug, group: "settings" },
  {
    id: "remote-control",
    label: "Remote Control",
    Icon: Monitor,
    group: "settings",
  },
  {
    id: "security",
    label: "Security",
    Icon: Shield,
    group: "settings",
    localOnly: true,
  },
  { id: "billing", label: "Billing", Icon: CreditCard, group: "plan" },
  { id: "analytics", label: "Usage", Icon: BarChart3, group: "plan" },
  { id: "costs", label: "Cost Optimizer", Icon: Coins, group: "plan" },
  {
    id: "compute",
    label: "Compute",
    Icon: Server,
    group: "plan",
    cloudOnly: true,
  },
  { id: "account", label: "Account", Icon: User, group: "personal" },
  {
    id: "appearance",
    label: "Appearance",
    Icon: Paintbrush,
    group: "personal",
  },
  {
    id: "updates",
    label: "Updates",
    Icon: RefreshCw,
    group: "personal",
    desktopOnly: true,
  },
];

const SETTINGS_TAB_BY_ID = new Map(SETTINGS_TABS.map((tab) => [tab.id, tab]));

export function settingsTab(id: SettingsTabId): SettingsTabDefinition {
  const tab = SETTINGS_TAB_BY_ID.get(id);
  if (!tab) throw new Error(`Unknown settings tab: ${id}`);
  return tab;
}

export function settingsNavItems(
  ids: readonly SettingsTabId[]
): Array<{ id: SettingsTabId; label: string; icon: LucideIcon }> {
  return ids.map((id) => {
    const tab = settingsTab(id);
    return { id: tab.id, label: tab.label, icon: tab.Icon };
  });
}

export function visibleSettingsTabs({
  localMode = false,
  showBilling = true,
  platform,
  isDesktop = false,
}: {
  localMode?: boolean;
  showBilling?: boolean;
  platform?: string;
  isDesktop?: boolean;
} = {}): SettingsTabDefinition[] {
  return SETTINGS_TABS.filter((tab) => {
    if (tab.id === "compute") return showBilling && platform !== "ios";
    if (tab.desktopOnly) return isDesktop;
    if (tab.localOnly) return localMode;
    if (tab.cloudOnly) return !localMode && showBilling;
    return true;
  });
}
