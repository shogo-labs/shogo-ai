// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { observer } from "mobx-react-lite";
import { useAgentUrl } from "@shogo/shared-app/hooks";
import { CanvasWebView } from "../../../components/canvas/CanvasWebView";
import { FilesBrowserPanel } from "../../../components/project/panels/FilesBrowserPanel";
import { PlansPanel } from "../../../components/project/panels/PlansPanel";
import { ProjectSettingsContent } from "../../../components/settings/ProjectSettingsContent";
import { agentFetch } from "../../../lib/agent-fetch";
import { API_URL } from "../../../lib/api";

type ProjectSurface = "canvas" | "files" | "plans" | "settings";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function ProjectCanvasSurface({
  agentUrl,
  canvasBaseUrl,
  previewUrl,
}: {
  agentUrl: string | null;
  canvasBaseUrl: string | null;
  previewUrl: string | null;
}) {
  const [previewReady, setPreviewReady] = useState(false);
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);
  const startRequestedRef = useRef(false);

  useEffect(() => {
    setPreviewReady(false);
    setCanvasUnavailable(false);
    startRequestedRef.current = false;
    if (!agentUrl) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const response = await agentFetch(`${agentUrl}/preview/status`);
        if (!response.ok || cancelled) return;
        const status = await response.json();
        if (status.running && status.apiReady !== false) {
          setPreviewReady(true);
          return;
        }
        if (!startRequestedRef.current) {
          startRequestedRef.current = true;
          void agentFetch(`${agentUrl}/preview/start`, { method: "POST" })
            .then(async (startResponse) => {
              const result = await startResponse.json().catch(() => null);
              if (!cancelled && result?.mode === "no-project") {
                setCanvasUnavailable(true);
              }
            })
            .catch(() => {});
        }
      } catch {
        // The runtime can briefly be unavailable while the project wakes.
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [agentUrl]);

  if (canvasUnavailable) {
    return (
      <View className="flex-1 items-center justify-center px-8">
        <Text className="text-center text-base font-semibold text-foreground">
          No canvas yet
        </Text>
        <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
          Ask Shogo to build an app or website for this project, then its live
          preview will appear here.
        </Text>
      </View>
    );
  }

  if (!agentUrl || !previewReady) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <ActivityIndicator size="large" />
        <Text className="mt-3 text-center text-sm text-muted-foreground">
          Starting canvas…
        </Text>
      </View>
    );
  }

  return (
    <CanvasWebView
      agentUrl={agentUrl}
      canvasBaseUrl={canvasBaseUrl}
      previewUrl={previewUrl}
    />
  );
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
          <ProjectCanvasSurface
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
