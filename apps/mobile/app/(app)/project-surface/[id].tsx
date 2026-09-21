// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useMemo } from "react";
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { observer } from "mobx-react-lite";
import { useAgentUrl } from "@shogo/shared-app/hooks";
import { CanvasWebView } from "../../../components/canvas/CanvasWebView";
import { FilesBrowserPanel } from "../../../components/project/panels/FilesBrowserPanel";
import { PlansPanel } from "../../../components/project/panels/PlansPanel";
import { ProjectSettingsContent } from "../../../components/settings/ProjectSettingsContent";
import { API_URL } from "../../../lib/api";

type ProjectSurface = "canvas" | "files" | "plans" | "settings";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default observer(function ProjectSurfaceScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    surface?: string | string[];
  }>();
  const projectId = firstParam(params.id);
  const surface = (firstParam(params.surface) ?? "canvas") as ProjectSurface;
  const { agentUrl, canvasBaseUrl, previewUrl } = useAgentUrl(
    API_URL ?? "",
    projectId ?? ""
  );

  const panel = useMemo(() => {
    if (!projectId) return null;
    switch (surface) {
      case "files":
        return (
          <FilesBrowserPanel
            projectId={projectId}
            agentUrl={agentUrl}
            visible
          />
        );
      case "plans":
        return <PlansPanel visible projectId={projectId} agentUrl={agentUrl} />;
      case "settings":
        return (
          <View className="flex-1 px-5 pt-20">
            <ProjectSettingsContent projectId={projectId} />
          </View>
        );
      case "canvas":
      default:
        return (
          <CanvasWebView
            agentUrl={agentUrl}
            canvasBaseUrl={canvasBaseUrl}
            previewUrl={previewUrl}
          />
        );
    }
  }, [agentUrl, canvasBaseUrl, previewUrl, projectId, surface]);

  if (!projectId) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  return <View className="flex-1 bg-background">{panel}</View>;
});
