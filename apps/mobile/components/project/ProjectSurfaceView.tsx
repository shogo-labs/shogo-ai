// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { observer } from "mobx-react-lite";
import { RefreshCw } from "lucide-react-native";
import { useAgentUrl } from "@shogo/shared-app/hooks";
import { CanvasWebView } from "../canvas/CanvasWebView";
import { FilesBrowserPanel } from "./panels/FilesBrowserPanel";
import { PlansPanel } from "./panels/PlansPanel";
import { ProjectSettingsContent } from "../settings/ProjectSettingsContent";
import { API_URL } from "../../lib/api";
import {
  PHASE_LABELS,
  isApiGateLatched,
  latchApiGate,
  nativeCanvasBaseReady,
  previewStatusPollBase,
  resolveCanvasGate,
} from "../../lib/preview-gate";
import { usePreviewGateTimers, usePreviewPhase } from "../../lib/use-preview-phase";
import { useWorkspaceBudgetToast } from "./WorkspaceBudgetNotice";

export type ProjectSurface = "canvas" | "files" | "plans" | "settings";

function GateMessage({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
}) {
  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="mb-3 h-3 w-3 rounded-full bg-destructive" />
      <Text className="text-center text-base font-semibold text-foreground">{title}</Text>
      <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{detail}</Text>
      {onRetry && (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry"
          className="mt-4 flex-row items-center gap-2 rounded-md border border-border px-4 py-2 active:opacity-70"
        >
          <RefreshCw size={14} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground">Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

function ProjectCanvasSurface({
  agentUrl,
  canvasBaseUrl,
  previewUrl,
  onRetryRuntime,
}: {
  agentUrl: string | null;
  canvasBaseUrl: string | null;
  previewUrl: string | null;
  /** Re-resolve `/sandbox/url` — the only recovery when no runtime URL exists. */
  onRetryRuntime?: () => void;
}) {
  // The same gate the project screen's CanvasPanel uses (SHO-406). This view
  // used to run its own copy that could only ever leave the spinner on
  // `running && apiReady !== false`, so a failed build, a 5xx status poll, a
  // sidecar that never came up or a runtime that never resolved all left it on
  // "Starting canvas…" forever.
  const {
    phase,
    running,
    apiReady,
    statusErrors,
    lastStatusError,
    startError,
    noProject,
    retry,
    retryNonce,
  } = usePreviewPhase(agentUrl, canvasBaseUrl);

  const nativeBaseReady = nativeCanvasBaseReady({
    native: Platform.OS !== "web",
    agentUrl,
    previewUrl,
    canvasBaseUrl,
  });

  const apiGateKey = previewStatusPollBase(agentUrl, canvasBaseUrl);
  const [apiLatchedState, setApiLatched] = useState(() => isApiGateLatched(apiGateKey));
  const apiLatched = apiLatchedState || isApiGateLatched(apiGateKey);
  useEffect(() => {
    if (apiReady || nativeBaseReady) {
      latchApiGate(apiGateKey);
      setApiLatched(true);
    }
  }, [apiReady, nativeBaseReady, apiGateKey]);

  const baseReady = nativeBaseReady || (!!agentUrl && running);
  const { baseTimedOut, apiWaitElapsed } = usePreviewGateTimers({
    baseReady,
    apiLatched,
    apiGateKey,
    resetKey: retryNonce,
  });

  const gate = resolveCanvasGate({
    agentUrl,
    phase,
    running,
    apiReady,
    apiLatched,
    nativeBaseReady,
    baseTimedOut,
    apiWaitElapsed,
    noProject,
  });

  const retryAll = () => {
    retry();
    if (!agentUrl) onRetryRuntime?.();
  };

  if (gate === "no-project") {
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

  if (gate === "ready" && agentUrl) {
    return (
      <CanvasWebView
        agentUrl={agentUrl}
        canvasBaseUrl={canvasBaseUrl}
        previewUrl={previewUrl}
      />
    );
  }

  if (gate === "failed") {
    return (
      <GateMessage
        title="Preview failed to start"
        detail={
          startError ??
          "The project couldn't finish building. Check the build logs, or ask the agent to diagnose and fix the error."
        }
        onRetry={retryAll}
      />
    );
  }

  if (gate === "timed-out") {
    const detail = !agentUrl
      ? "The agent runtime could not be reached. This may be a temporary issue — try Retry, or come back later."
      : lastStatusError
        ? `The live preview did not become ready (${lastStatusError}). Try Retry, or send a chat message and open Previews again.`
        : startError
          ? `The live preview did not start (${startError}). Try Retry, or send a chat message and open Previews again.`
          : "The live preview did not become ready. Try Retry, or send a chat message and open Previews again.";
    return <GateMessage title="Connection timed out" detail={detail} onRetry={retryAll} />;
  }

  if (gate === "waiting-runtime") {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <ActivityIndicator size="large" />
        <Text className="mt-3 text-center text-sm text-muted-foreground">
          Connecting to agent runtime…
        </Text>
      </View>
    );
  }

  // `starting`: the runtime is up but the preview isn't serveable yet. Show
  // what it is actually doing, and name a failing status poll so a 5xx is not
  // an anonymous spinner.
  const phaseLabel =
    phase && phase !== "idle"
      ? PHASE_LABELS[phase] ?? "Preparing preview..."
      : "Starting canvas…";
  return (
    <View className="flex-1 items-center justify-center px-6">
      <ActivityIndicator size="large" />
      <Text className="mt-3 text-center text-sm text-muted-foreground">{phaseLabel}</Text>
      {statusErrors >= 2 && lastStatusError && (
        <Text className="mt-2 text-center text-xs text-muted-foreground/70">
          Preview status: {lastStatusError}
        </Text>
      )}
    </View>
  );
}

export const ProjectSurfaceView = observer(function ProjectSurfaceView({
  projectId,
  surface = "canvas",
  header,
  headerHeight = 0,
}: {
  projectId: string | undefined;
  surface?: ProjectSurface;
  /** Rendered above the surface, below the status bar inset. */
  header?: ReactNode;
  /** Height of a floating header, so the surface starts below the glass. */
  headerHeight?: number;
}) {
  const {
    agentUrl,
    canvasBaseUrl,
    previewUrl,
    budgetNotice,
    dismissBudgetNotice,
    retry: retryRuntime,
  } = useAgentUrl(API_URL ?? "", projectId ?? "");
  useWorkspaceBudgetToast(budgetNotice, dismissBudgetNotice);

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
          <ScrollView
            className="flex-1"
            contentContainerClassName="px-5 pb-32 pt-3"
            keyboardShouldPersistTaps="handled"
          >
            <ProjectSettingsContent projectId={projectId} />
          </ScrollView>
        );
      case "canvas":
      default:
        return (
          <ProjectCanvasSurface
            agentUrl={agentUrl}
            canvasBaseUrl={canvasBaseUrl}
            previewUrl={previewUrl}
            onRetryRuntime={retryRuntime}
          />
        );
    }
  }, [agentUrl, canvasBaseUrl, previewUrl, projectId, surface, retryRuntime]);

  if (!projectId) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {header}
      {/* The files panel is absolutely filled, so it needs a parent of its own
          for the padding above to apply. A floating header sits over the
          content, so the content clears it here. */}
      <View className="flex-1" style={headerHeight ? { paddingTop: headerHeight } : undefined}>
        {panel}
      </View>
    </View>
  );
});
