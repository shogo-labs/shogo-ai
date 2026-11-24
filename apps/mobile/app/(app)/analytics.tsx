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
import { useLocalSearchParams, useRouter } from "expo-router";
import { BarChart3 } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import {
  TabScreen,
  TabScreenScrollView,
} from "../../components/layout/TabScreenHeader";
import { Text } from "../../components/settings/account-sheet-chrome";
import { Button, ButtonText } from "../../components/ui/button";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { usePermissions } from "../../hooks/usePermissions";
import { WorkspaceUsagePanel } from "../../components/analytics/WorkspaceUsagePanel";
import { WorkspaceChannelsPanel } from "../../components/analytics/WorkspaceChannelsPanel";
import { WorkspaceHeartbeatsPanel } from "../../components/analytics/WorkspaceHeartbeatsPanel";
import { WorkspaceCostPanel } from "../../components/analytics/WorkspaceCostPanel";
import { Spinner } from '@/components/ui/spinner'

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
  const router = useRouter();
  const workspace = useActiveWorkspace();
  const { can, loading } = usePermissions({ workspaceId: workspace?.id });
  // Workspace analytics are owner/admin only on the server; a member who lands
  // here (a stale link, a deep link) gets the empty state and no fetch at all.
  const isAdmin = can("workspace.analytics:read");

  const [view, setView] = useState<AnalyticsView>(
    isAnalyticsView(params.view) ? params.view : "usage"
  );

  // `can()` is false until the permissions land, so an admin opening a deep
  // link would otherwise be told they are not an admin. Wait for the answer.
  if (loading) {
    return (
      <TabScreen title="Analytics" back testID="analytics-screen">
        <View className="flex-1 items-center justify-center" testID="analytics-loading">
          <Spinner />
        </View>
      </TabScreen>
    );
  }

  if (!isAdmin) {
    return (
      <TabScreen title="Analytics" back testID="analytics-screen">
        <View
          className="flex-1 items-center justify-center gap-3 px-8"
          testID="analytics-admins-only"
        >
          <BarChart3 size={32} className="text-muted-foreground" />
          <Text className="text-center text-base font-semibold text-foreground">
            Workspace admins only
          </Text>
          <Text className="text-center text-sm text-muted-foreground">
            Ask a workspace owner or admin for access.
          </Text>
          <Button variant="outline" onPress={() => router.back()}>
            <ButtonText>Back</ButtonText>
          </Button>
        </View>
      </TabScreen>
    );
  }

  return (
    <TabScreen title="Analytics" back testID="analytics-screen">
      <View className="flex-row flex-wrap gap-2 px-4 pb-3">
        {VIEWS.map((item) => {
          const active = view === item.id;
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
        {view === "usage" ? (
          <WorkspaceUsagePanel />
        ) : view === "channels" ? (
          <WorkspaceChannelsPanel />
        ) : view === "heartbeats" ? (
          <WorkspaceHeartbeatsPanel />
        ) : (
          <WorkspaceCostPanel />
        )}
      </TabScreenScrollView>
    </TabScreen>
  );
}
