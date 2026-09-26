// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { observer } from "mobx-react-lite";
import { useAuth } from "../../../contexts/auth";
import { useDomainActions } from "@shogo/shared-app/domain";
import { useActiveWorkspace } from "../../../hooks/useActiveWorkspace";
import { useMobileWorkspaceChrome } from "../../../components/layout/MobileWorkspaceChromeContext";
import { useWorkspaceExperience } from "../../../hooks/useWorkspaceExperience";
import { ChatPanel } from "../../../components/chat/ChatPanel";
import type { InteractionMode } from "../../../components/chat/ChatInput";
import { consumePendingFiles } from "../../../lib/pending-image-store";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function initialInteractionMode(
  value: string | string[] | undefined
): InteractionMode | undefined {
  const mode = firstParam(value);
  return mode === "agent" || mode === "ask" || mode === "plan"
    ? mode
    : undefined;
}

export default observer(function ProjectChatScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    chatSessionId?: string | string[];
    chatScope?: string | string[];
    initialMessage?: string | string[];
    initialInteractionMode?: string | string[];
    newChatNonce?: string | string[];
  }>();
  const projectId = firstParam(params.id);
  const requestedSessionId = firstParam(params.chatSessionId);
  const newChatNonce = firstParam(params.newChatNonce);
  const requestedChatScope =
    firstParam(params.chatScope) === "workspace" ? "workspace" : "project";
  const { user } = useAuth();
  const workspace = useActiveWorkspace();
  const experience = useWorkspaceExperience();
  const usesMobileWorkspaceChrome = useMobileWorkspaceChrome();
  const actions = useDomainActions();
  // Initial creation arrives here directly on native. Capture one-shot values
  // so a route re-render cannot resend the prompt or lose pending attachments.
  const [capturedInitialMessage] = useState(() => firstParam(params.initialMessage));
  const [capturedInitialInteractionMode] = useState(() =>
    initialInteractionMode(params.initialInteractionMode)
  );
  const [capturedInitialFiles] = useState(() => consumePendingFiles());
  const [chatSessionId, setChatSessionId] = useState<string | null>(
    requestedSessionId ?? null
  );
  // Personal main and side chats intentionally stay Agent-only. A project
  // chat has its own model/runtime, so mobile exposes Ask and Plan from the
  // existing composer plus-sheet without changing desktop presentation.
  const composer = useMemo(
    () =>
      usesMobileWorkspaceChrome
        ? {
            ...experience.composer,
            showInteractionModes: true,
            forcedMode: undefined,
          }
        : experience.composer,
    [experience.composer, usesMobileWorkspaceChrome]
  );

  useEffect(() => {
    setChatSessionId(requestedSessionId ?? null);
  }, [requestedSessionId]);

  useEffect(() => {
    if (newChatNonce) setChatSessionId(null);
  }, [newChatNonce]);

  useEffect(() => {
    if (!projectId || (requestedSessionId && !newChatNonce) || chatSessionId)
      return;
    let cancelled = false;
    void actions
      .createChatSession({
        inferredName: "Untitled",
        contextType: "project",
        contextId: projectId,
      })
      .then((session) => {
        if (!cancelled && session?.id) setChatSessionId(session.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [actions, chatSessionId, newChatNonce, projectId, requestedSessionId]);

  if (!projectId) return null;

  if (!chatSessionId) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View className="min-h-0 flex-1 bg-background">
      <ChatPanel
        featureId={projectId}
        featureName="Project chat"
        phase={null}
        workspaceId={workspace?.id}
        userId={user?.id}
        projectId={projectId}
        chatScope={requestedChatScope}
        chatSessionId={chatSessionId}
        onChatSessionChange={setChatSessionId}
        initialMessage={capturedInitialMessage}
        initialFiles={capturedInitialFiles}
        initialInteractionMode={capturedInitialInteractionMode}
        composer={composer}
        presentation="agent"
        className="flex-1"
        isActive
      />
    </View>
  );
});
