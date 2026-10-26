// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useLocalSearchParams, useRouter } from "expo-router";
import { ProjectChatView } from "../../../components/project/ProjectChatView";
import { SessionBreadcrumb } from "../../../components/team-chat/SessionBreadcrumb";
import {
  firstChatSessionParam,
  hasChatUrlOneShotParams,
} from "../../../lib/project-chat-url";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function ProjectChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    id?: string | string[];
    chatSessionId?: string | string[];
    chatScope?: string | string[];
    initialMessage?: string | string[];
    newChatNonce?: string | string[];
    newChat?: string | string[];
    startEzMode?: string | string[];
    autoStartVoice?: string | string[];
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
      // Name the open chat in the URL, so this chat is shareable and a reload
      // comes back to it rather than to a blank create-on-open chat.
      urlChatSessionId={firstChatSessionParam(params.chatSessionId)}
      hasOneShotUrlParams={hasChatUrlOneShotParams(params)}
      onChatSessionUrlChange={(next) => router.setParams(next as any)}
      // Opened from a team chat message: show where from, and the way back.
      header={<SessionBreadcrumb params={params} />}
    />
  );
}
