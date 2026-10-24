// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics: workspace usage, per-channel activity and the agent cost
 * optimizer, in one place. Reached from the More tab and the desktop
 * sidebar's More panel.
 * `?view=usage|channels|heartbeats|costs` selects the segment on open.
 */
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { cn } from "@shogo/shared-ui/primitives";
import {
  TabScreen,
  TabScreenScrollView,
} from "../../components/layout/TabScreenHeader";
import { Text } from "../../components/settings/account-sheet-chrome";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { usePermissions } from "../../hooks/usePermissions";
import { WorkspaceUsagePanel } from "../../components/analytics/WorkspaceUsagePanel";
import { WorkspaceChannelsPanel } from "../../components/analytics/WorkspaceChannelsPanel";
import { WorkspaceHeartbeatsPanel } from "../../components/analytics/WorkspaceHeartbeatsPanel";
import { WorkspaceCostPanel } from "../../components/analytics/WorkspaceCostPanel";

type AnalyticsView = "usage" | "channels" | "heartbeats" | "costs";

const VIEWS: Array<{ id: AnalyticsView; label: string }> = [
  { id: "usage", label: "Usage" },
  { id: "channels", label: "Channels" },
  { id: "heartbeats", label: "Heartbeats" },
  { id: "costs", label: "Cost Optimizer" },
];

const isAnalyticsView = (value: unknown): value is AnalyticsView =>
  VIEWS.some((item) => item.id === value);

export default function AnalyticsScreen() {
  const params = useLocalSearchParams<{ view?: string }>();
  const workspace = useActiveWorkspace();
  const { can } = usePermissions({ workspaceId: workspace?.id });
  // The server gates per-channel activity to owners/admins, so members never
  // get a tab that would only 403.
  const showChannels = can("workspace.analytics:read");
  const views = VIEWS.filter((item) => item.id !== "channels" || showChannels);

  const [view, setView] = useState<AnalyticsView>(
    isAnalyticsView(params.view) ? params.view : "usage"
  );
  const activeView: AnalyticsView =
    view === "channels" && !showChannels ? "usage" : view;

  return (
    <TabScreen title="Analytics" testID="analytics-screen">
      <View className="flex-row flex-wrap gap-2 px-4 pb-3">
        {views.map((item) => {
          const active = activeView === item.id;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              aria-selected={active}
              testID={`analytics-view-${item.id}`}
              onPress={() => setView(item.id)}
              className={cn(
                "rounded-lg px-3 py-2",
                active ? "bg-primary/10" : "active:bg-muted"
              )}
            >
              <Text
                className={cn(
                  "text-sm font-medium",
                  active ? "text-primary" : "text-muted-foreground"
                )}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <TabScreenScrollView contentContainerClassName="px-4 pb-36">
        {activeView === "usage" ? (
          <WorkspaceUsagePanel />
        ) : activeView === "channels" ? (
          <WorkspaceChannelsPanel />
        ) : activeView === "heartbeats" ? (
          <WorkspaceHeartbeatsPanel />
        ) : (
          <WorkspaceCostPanel />
        )}
      </TabScreenScrollView>
    </TabScreen>
  );
}
