// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useLocalSearchParams } from "expo-router";
import type { InteractionMode } from "../../../components/chat/ChatInput";
import { ProjectChatView } from "../../../components/project/ProjectChatView";
import { SessionBreadcrumb } from "../../../components/team-chat/SessionBreadcrumb";

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

export default function ProjectChatScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    chatSessionId?: string | string[];
    chatScope?: string | string[];
    initialMessage?: string | string[];
    initialInteractionMode?: string | string[];
    newChatNonce?: string | string[];
    fromConversation?: string | string[];
    fromLabel?: string | string[];
    fromThread?: string | string[];
    fromAgent?: string | string[];
  }>();

  return (
    <ProjectChatView
      projectId={firstParam(params.id)}
      chatSessionId={firstParam(params.chatSessionId)}
      newChatNonce={firstParam(params.newChatNonce)}
      chatScope={firstParam(params.chatScope) === "workspace" ? "workspace" : "project"}
      initialMessage={firstParam(params.initialMessage)}
      initialInteractionMode={initialInteractionMode(params.initialInteractionMode)}
      // Opened from a team chat message: show where from, and the way back.
      header={<SessionBreadcrumb params={params} />}
    />
  );
}
