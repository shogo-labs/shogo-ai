// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A single side chat: the same workspace-scoped `ChatPanel` the primary
 * companion chat uses (same merged-root runtime, same tools), just pointed
 * at a non-primary `ChatSession`. See `SideChatsScreen` for the list this
 * is opened from.
 */
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { observer } from "mobx-react-lite";
import { useAuth } from "../../contexts/auth";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience";
import { ChatPanel } from "../chat/ChatPanel";

export const SideChatScreen = observer(function SideChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const workspace = useActiveWorkspace();
  const experience = useWorkspaceExperience();
  const workspaceId = workspace?.id;

  if (!workspaceId || !id) return null;

  return (
    <View className="flex-1 bg-background">
      <View className="min-h-0 flex-1">
        <ChatPanel
          featureId={null}
          featureName="Side chat"
          phase={null}
          workspaceId={workspaceId}
          userId={user?.id}
          chatScope="workspace"
          chatSessionId={id}
          onChatSessionChange={() => {}}
          composer={experience.composer}
          presentation="agent"
          className="flex-1"
          isActive
        />
      </View>
    </View>
  );
});
