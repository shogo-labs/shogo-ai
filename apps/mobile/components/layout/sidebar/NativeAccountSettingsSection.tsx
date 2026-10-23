// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native Account settings groups. Rows open bottom sheets on Account;
 * they do not push the Settings page.
 */
import { AccountSettingsGroup, AccountSettingsRow } from "./AccountSettingsGroup"
import { Platform } from "react-native"
import { PHONE_DENSITY } from "../../../lib/phone-density"
import { useWorkspaceExperience } from "../../../hooks/useWorkspaceExperience"
import {
  accountSettingsSheetGroups,
  type AccountSettingsSheetTab,
} from "../../settings/account-settings-sheets"

export function NativeAccountSettingsSection({
  hasWorkspace,
  localMode,
  showBilling,
  onOpenTab,
}: {
  hasWorkspace: boolean
  localMode?: boolean
  showBilling?: boolean
  onOpenTab: (tab: AccountSettingsSheetTab) => void
}) {
  const teamChat = useWorkspaceExperience().kind === "team"
  if (!hasWorkspace) return null
  const groups = accountSettingsSheetGroups({
    localMode,
    showBilling,
    platform: Platform.OS,
    teamChat,
  })
  return (
    <>
      {groups.map((group) => (
        <AccountSettingsGroup key={group.title} title={group.title}>
          {group.tabs.map((tab, index) => {
            const Icon = tab.Icon
            return (
              <AccountSettingsRow
                key={tab.id}
                icon={<Icon size={PHONE_DENSITY.icon.lg} className="text-muted-foreground" />}
                label={tab.label}
                separator={index < group.tabs.length - 1}
                onPress={() => onOpenTab(tab.id)}
              />
            )
          })}
        </AccountSettingsGroup>
      ))}
    </>
  )
}
