// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { observer } from "mobx-react-lite";
import { useAuth } from "../../contexts/auth";
import { useDomainActions } from "@shogo/shared-app/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { useMobileWorkspaceChrome } from "../layout/MobileWorkspaceChromeContext";
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience";
import { ChatPanel } from "../chat/ChatPanel";
import type { InteractionMode } from "../chat/ChatInput";
import { consumePendingFiles } from "../../lib/pending-image-store";
import { resolveChatScope } from "../../lib/chat-scope";
import {
  useProjectChatUrlMirror,
  type ChatUrlParams,
} from "../../lib/project-chat-url";
import { useAgentLook } from "../../hooks/useTeamChat";
import { buddyAvatarColor } from "../team-chat/BuddyAvatar";
import { AgentBackdrop } from "../ui/AgentBackdrop";

export interface ProjectChatViewProps {
  projectId: string | undefined;
  /** Resume this session instead of starting a new one. */
  chatSessionId?: string;
  /** Changing this starts a fresh session. */
  newChatNonce?: string;
  chatScope?: "workspace" | "project";
  initialMessage?: string;
  initialInteractionMode?: InteractionMode;
  /** Rendered above the chat (for example a breadcrumb). */
  header?: ReactNode;
  /**
   * `?chatSessionId=` as the route sees it, plus the writer for it. Both are
   * supplied by the standalone project-chat route so switching chats in place
   * names the chat in the URL; omitted where there is no URL to mirror (the
   * team-chat side pane).
   */
  urlChatSessionId?: string;
  /** Arrival-only params still in the URL (`newChatNonce`, `initialMessage`, …). */
  hasOneShotUrlParams?: boolean;
  onChatSessionUrlChange?: (params: ChatUrlParams) => void;
}


/** A project's own chat: finds or creates a session, then renders `ChatPanel`. */
export const ProjectChatView = observer(function ProjectChatView({
  projectId,
  chatSessionId: requestedSessionId,
  newChatNonce,
  chatScope,
  initialMessage,
  initialInteractionMode,
  header,
  urlChatSessionId,
  hasOneShotUrlParams,
  onChatSessionUrlChange,
}: ProjectChatViewProps) {
  const requestedChatScope = resolveChatScope({
    surface: "project-chat",
    requestedScope: chatScope === "workspace" ? "workspace" : "project",
  });
  const { user } = useAuth();
  const workspace = useActiveWorkspace();
  const experience = useWorkspaceExperience();
  const usesMobileWorkspaceChrome = useMobileWorkspaceChrome();
  const actions = useDomainActions();
  const agentColor = buddyAvatarColor(useAgentLook(workspace?.id, projectId ?? null));
  // Initial creation arrives here directly on native. Capture one-shot values
  // so a route re-render cannot resend the prompt or lose pending attachments.
  const [capturedInitialMessage] = useState(() => initialMessage);
  const [capturedInitialInteractionMode] = useState(() => initialInteractionMode);
  const [capturedInitialFiles] = useState(() => consumePendingFiles());
  const [chatSessionId, setChatSessionId] = useState<string | null>(
    requestedSessionId ?? null
  );
  // The chat the URL named when this view mounted: only that one keeps the
  // workspace hand-off scope (see `planChatUrlWrite`).
  const [initialRequestedSessionId] = useState(
    () => requestedSessionId ?? null
  );
  // Keep the open chat's id in `?chatSessionId=` (the route passes the writer)
  // so this chat is shareable and survives a reload.
  useProjectChatUrlMirror({
    chatSessionId,
    currentParam: urlChatSessionId,
    chatScope: chatScope === "workspace" ? "workspace" : "project",
    initialPropsSessionId: initialRequestedSessionId,
    oneShotPresent: hasOneShotUrlParams === true,
    enabled: !!onChatSessionUrlChange,
    setParams: onChatSessionUrlChange,
  });
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
      {/* The agent's colour, glowing softly from the top; the chat is transparent over it. */}
      <AgentBackdrop color={agentColor} />
      {header}
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
