// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings navigation for the wide app sidebar. It takes the sidebar panel
 * while the route is `/settings`; the main area shows the selected tab. The
 * active tab lives in the `?tab=` param, which both this panel and the page
 * read.
 *
 * Workspace switching is not here. The workspace menu in the rail and panel
 * header covers it, the same as on every other page.
 */

import { Pressable, ScrollView, View } from "react-native";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { cn } from "@shogo/shared-ui/primitives";
import { useAuth } from "../../contexts/auth";
import { usePlatformConfig } from "../../lib/platform-config";
import {
  settingsTab,
  settingsTabFromParam,
  type SettingsTabId,
} from "../../lib/settings-tabs";
import {
  HIDE_COMPUTE_PURCHASES_ON_IOS,
  IS_DESKTOP_CLIENT,
  WorkspaceAccountActions,
} from "../../app/(app)/settings";
import { Text } from "./account-sheet-chrome";

interface SidebarItem {
  id: SettingsTabId;
  label: string;
}

interface SidebarSection {
  id: string;
  label?: string;
  items: SidebarItem[];
}

export function SettingsNavPanel() {
  const router = useRouter();
  const params = useGlobalSearchParams<{ tab?: string }>();
  const activeTab = settingsTabFromParam(params.tab);
  const { features, localMode } = usePlatformConfig();
  const { user } = useAuth();
  const showBilling = features.billing;
  const userName = user?.name || "";

  const onTabChange = (id: SettingsTabId) => {
    router.setParams({ tab: id } as any);
  };

  const tabItem = (id: SettingsTabId): SidebarItem => ({
    id,
    label: settingsTab(id).label,
  });

  const workspaceItems: SidebarItem[] = [
    tabItem("workspace"),
    ...(!(localMode || !showBilling)
      ? [tabItem("people"), tabItem("models")]
      : []),
    tabItem("integrations"),
    tabItem("automations"),
    tabItem("remote-control"),
    ...(showBilling
      ? [
          ...(!HIDE_COMPUTE_PURCHASES_ON_IOS ? [tabItem("compute")] : []),
          tabItem("billing"),
          tabItem("team-activity"),
          tabItem("analytics"),
          tabItem("costs"),
        ]
      : [
          tabItem("billing"),
          tabItem("team-activity"),
          tabItem("analytics"),
          tabItem("costs"),
        ]),
  ];

  const sections: SidebarSection[] = [
    {
      id: "workspace",
      items: workspaceItems,
    },
    {
      id: "account",
      label: settingsTab("account").label,
      items: [
        {
          ...tabItem("account"),
          label: userName || settingsTab("account").label,
        },
        tabItem("appearance"),
        ...(!showBilling ? [tabItem("security")] : []),
        ...(!showBilling && IS_DESKTOP_CLIENT ? [tabItem("computer-files")] : []),
        ...(IS_DESKTOP_CLIENT ? [tabItem("updates")] : []),
      ],
    },
  ];

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="px-3 pb-5 pt-2"
      showsVerticalScrollIndicator={false}
    >
      {sections.map((section, sectionIdx) => (
        <View key={section.id} className={sectionIdx > 0 ? "mt-6" : ""}>
          {section.label && (
            <Text className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {section.label}
            </Text>
          )}
          <View className="gap-0.5">
            {section.items.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="tab"
                  aria-selected={isActive}
                  onPress={() => onTabChange(item.id)}
                  className={cn(
                    "flex-row items-center gap-2 rounded-lg px-2.5 py-2.5",
                    isActive
                      ? "border border-primary/20 bg-primary/5"
                      : "active:bg-muted"
                  )}
                >
                  <Text
                    className={cn(
                      "text-sm flex-1",
                      isActive
                        ? "text-foreground font-medium"
                        : "text-muted-foreground"
                    )}
                    numberOfLines={1}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      <WorkspaceAccountActions onSelectTab={onTabChange} showWorkspace={false} variant="sidebar" />
    </ScrollView>
  );
}
