// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { observer } from "mobx-react-lite";
import { useAuth } from "../../../contexts/auth";
import { useActiveWorkspace } from "../../../hooks/useActiveWorkspace";
import { useWorkspaceExperience } from "../../../hooks/useWorkspaceExperience";
import { ChatPanel } from "../../../components/chat/ChatPanel";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default observer(function ProjectChatScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    chatSessionId?: string | string[];
  }>();
  const projectId = firstParam(params.id);
  const chatSessionId = firstParam(params.chatSessionId);
  const { user } = useAuth();
  const workspace = useActiveWorkspace();
  const experience = useWorkspaceExperience();

  if (!projectId || !chatSessionId) return null;

  return (
    <View className="min-h-0 flex-1 bg-background">
      <ChatPanel
        featureId={projectId}
        featureName="Project chat"
        phase={null}
        workspaceId={workspace?.id}
        userId={user?.id}
        projectId={projectId}
        chatScope="project"
        chatSessionId={chatSessionId}
        onChatSessionChange={() => {}}
        composer={experience.composer}
        presentation="agent"
        className="flex-1"
        isActive
      />
    </View>
  );
});
