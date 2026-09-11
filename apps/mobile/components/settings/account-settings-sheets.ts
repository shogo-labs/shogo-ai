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
  BarChart3,
  Boxes,
  Bug,
  Building2,
  Coins,
  CreditCard,
  Monitor,
  Plug,
  Shield,
  Users,
  type LucideIcon,
} from "lucide-react-native"

export type AccountSettingsSheetTab =
  | "workspace"
  | "people"
  | "models"
  | "integrations"
  | "remote-control"
  | "billing"
  | "analytics"
  | "costs"
  | "security"
  | "support"
  | "appearance"
  | "account"

type SheetTabDef = {
  id: Exclude<AccountSettingsSheetTab, "appearance" | "account">
  Icon: LucideIcon
  /** Hidden in local mode or when billing is off (same as Settings people/models). */
  cloudOnly?: boolean
  /** Local-mode Settings tabs (Security, Report Bug). */
  localOnly?: boolean
}

const SHEET_TITLE_BY_ID: Record<AccountSettingsSheetTab, string> = {
  workspace: "Workspace",
  people: "People",
  models: "Models",
  integrations: "Integrations",
  "remote-control": "Remote Control",
  billing: "Billing",
  analytics: "Usage",
  costs: "Costs",
  security: "Security",
  support: "Report Bug",
  appearance: "Appearance",
  account: "Profile",
}

const SETTINGS_GROUP: SheetTabDef[] = [
  { id: "workspace", Icon: Building2 },
  { id: "people", Icon: Users, cloudOnly: true },
  { id: "models", Icon: Boxes, cloudOnly: true },
  { id: "integrations", Icon: Plug },
  { id: "remote-control", Icon: Monitor },
  { id: "security", Icon: Shield, localOnly: true },
  { id: "support", Icon: Bug, localOnly: true },
]

const PLAN_GROUP: SheetTabDef[] = [
  { id: "billing", Icon: CreditCard, cloudOnly: true },
  { id: "analytics", Icon: BarChart3 },
  { id: "costs", Icon: Coins },
]

function tabVisible(
  tab: SheetTabDef,
  localMode?: boolean,
  showBilling?: boolean,
) {
  if (tab.localOnly) return !!localMode
  if (tab.cloudOnly) return !localMode && !!showBilling
  return true
}

export function accountSettingsSheetTitle(tab: AccountSettingsSheetTab): string {
  return SHEET_TITLE_BY_ID[tab]
}

export function accountSettingsSheetGroups({
  localMode,
  showBilling,
}: {
  localMode?: boolean
  showBilling?: boolean
}): Array<{ title: string; tabs: Array<SheetTabDef & { label: string }> }> {
  const withLabel = (tab: SheetTabDef) => ({
    ...tab,
    label: SHEET_TITLE_BY_ID[tab.id],
  })
  const settings = SETTINGS_GROUP.filter((tab) => tabVisible(tab, localMode, showBilling)).map(withLabel)
  const plan = PLAN_GROUP.filter((tab) => tabVisible(tab, localMode, showBilling)).map(withLabel)
  const groups: Array<{ title: string; tabs: Array<SheetTabDef & { label: string }> }> = []
  if (settings.length) groups.push({ title: "Settings", tabs: settings })
  if (plan.length) groups.push({ title: "Plan", tabs: plan })
  return groups
}
