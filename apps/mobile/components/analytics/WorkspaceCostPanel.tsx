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

  const fetchSubagentOverrides = useCallback(
    () => api.listSubagentOverrides(http, workspaceId!),
    [http, workspaceId]
  );

  const putSubagentOverride = useCallback(
    (body: {
      agentType: string;
      model: string;
      provider?: string | null;
      projectId?: string | null;
    }) => api.upsertSubagentOverride(http, workspaceId!, body),
    [http, workspaceId]
  );

  const deleteSubagentOverride = useCallback(
    (agentType: string, projectId?: string | null) =>
      api.deleteSubagentOverride(http, workspaceId!, agentType, projectId),
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
      workspaceId={workspaceId}
      fetchCostAnalytics={fetchCostAnalytics}
      postCostAnalytics={postCostAnalytics}
      fetchSubagentOverrides={fetchSubagentOverrides}
      putSubagentOverride={putSubagentOverride}
      deleteSubagentOverride={deleteSubagentOverride}
    />
  );
}
