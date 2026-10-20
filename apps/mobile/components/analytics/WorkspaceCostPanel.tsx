// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cost Optimizer panel for the Analytics screen. Wires the workspace
 * cost-analytics API into `CostAnalyticsTab`.
 */

import { useCallback } from "react";
import { View } from "react-native";
import { Text } from "../settings/account-sheet-chrome";
import { useDomainHttp } from "../../contexts/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { api } from "../../lib/api";
import { CostAnalyticsTab } from "./CostAnalyticsTab";


export function WorkspaceCostPanel() {
  const http = useDomainHttp();
  const workspace = useActiveWorkspace();
  const workspaceId = workspace?.id;

  const fetchCostAnalytics = useCallback(
    <T,>(endpoint: string, params?: Record<string, string>) =>
      api.getWorkspaceCostAnalytics<T>(http, workspaceId!, endpoint, params),
    [http, workspaceId]
  );

  const postCostAnalytics = useCallback(
    <T,>(endpoint: string, body: Record<string, unknown>) =>
      api.postWorkspaceCostAnalytics<T>(http, workspaceId!, endpoint, body),
    [http, workspaceId]
  );

  if (!workspaceId) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">
          No workspace selected
        </Text>
      </View>
    );
  }

  return (
    <CostAnalyticsTab
      fetchCostAnalytics={fetchCostAnalytics}
      postCostAnalytics={postCostAnalytics}
    />
  );
}
