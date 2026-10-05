// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project settings: how this project's agent looks in chat. The project owner
 * and workspace admins get the buddy customizer right on the page; everyone
 * else sees the agent's buddy and who can change it.
 */
import { View } from "react-native";
import { ShogoBuddy } from "../island/buddy/ShogoBuddy";
import { BuddyLookEditor } from "../personal/BuddyLookSheet";
import { useAgentCard } from "../team-chat/AgentProfileBody";
import { buddyAvatarColor } from "../team-chat/BuddyAvatar";
import { useAgentLookEditor } from "../team-chat/useAgentLookEditor";
import { useAgentLook } from "../../hooks/useTeamChat";
import { Text } from "./account-sheet-chrome";

export function ProjectAgentLookSection({
  workspaceId,
  projectId,
  projectName,
  flush,
}: {
  workspaceId: string;
  projectId: string;
  projectName: string;
  /** Drop the top margin when the section is the first thing on its page. */
  flush?: boolean;
}) {
  const { card } = useAgentCard(workspaceId, projectId);
  const look = useAgentLook(workspaceId, projectId);
  const { save, error } = useAgentLookEditor(workspaceId, projectId, look, card?.buddyLook ?? null);
  const name = card?.name ?? projectName;
  const canEdit = !!card?.canEdit;

  return (
    <View className={flush ? "" : "mt-8"} testID="project-agent-look">
      <Text className="mb-1 text-xs font-medium text-muted-foreground">
        AGENT LOOK
      </Text>
      <Text className="mb-3 text-xs text-muted-foreground">
        {canEdit
          ? `How ${name} appears in chats and mentions.`
          : "Only the project owner and workspace admins can change this."}
      </Text>
      {canEdit ? (
        <BuddyLookEditor
          target={{
            look,
            onChange: save,
            error,
            onReset: () => save(null),
          }}
        />
      ) : (
        <View className="flex-row items-center gap-4 rounded-xl border border-border bg-card p-3">
          <View style={{ width: 72, height: 72, alignItems: "center", justifyContent: "flex-end", overflow: "visible" }}>
            <ShogoBuddy
              size={64}
              state="idle"
              color={buddyAvatarColor(look)}
              look={look}
              interactive
              accessibilityLabel={`${name} avatar`}
            />
          </View>
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
        </View>
      )}
    </View>
  );
}
