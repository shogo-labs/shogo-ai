// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Quick profile card for an agent in team chat: its buddy, what it is for,
 * who owns it and the channels it works in, with links to its full profile and
 * its project. Opened by tapping an agent's avatar or name.
 */
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ExternalLink, FolderOpen, PanelRight, X } from 'lucide-react-native'
import { AgentAvatar } from './AgentAvatar'
import { AgentProfileBody, triggerLabel, useAgentCard } from './AgentProfileBody'

// Kept here so existing imports keep working.
export { AgentAvatar, triggerLabel }

export interface AgentProfileCardProps {
  workspaceId: string
  projectId: string | null
  /** Shown while the card loads, and if it fails to. */
  name: string
  iconUrl?: string | null
  onClose: () => void
  onOpenChannel?: (conversationId: string) => void
  /** Show the agent's project beside the conversation. Only passed where there is room. */
  onOpenProjectPane?: (projectId: string, name: string) => void
}

export function AgentProfileCard({ workspaceId, projectId, name, iconUrl, onClose, onOpenChannel, onOpenProjectPane }: AgentProfileCardProps) {
  const router = useRouter()
  const { card, failed, toggleMute } = useAgentCard(workspaceId, projectId)
  const displayName = card?.name ?? name

  const go = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center p-6">
        <Pressable className="absolute inset-0 bg-black/30" onPress={onClose} accessibilityLabel="Close agent profile" />
        <View className="w-full max-w-[360px] rounded-xl border border-border bg-card p-4" testID="agent-profile-card">
          <View className="flex-row items-start gap-3">
            <AgentAvatar name={displayName} projectId={projectId} workspaceId={workspaceId} iconUrl={card?.iconUrl ?? iconUrl} size={48} />
            <View className="min-w-0 flex-1">
              <Text className="text-base font-semibold text-foreground" numberOfLines={2}>{displayName}</Text>
              <View className="mt-0.5 self-start rounded bg-primary/10 px-1.5 py-px">
                <Text className="text-[10px] font-medium text-primary">AGENT</Text>
              </View>
            </View>
            <Pressable onPress={onClose} accessibilityLabel="Close" className="rounded p-1 active:bg-muted">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>

          <View className="mt-3 flex-row flex-wrap gap-2">
            <CardButton
              label="View profile"
              icon={<ExternalLink size={13} className="text-foreground" />}
              onPress={go(() => router.push({ pathname: '/(app)/agents/[key]', params: { key: projectId ?? 'ws' } } as any))}
            />
            {projectId ? (
              <CardButton
                label="Open project"
                icon={<FolderOpen size={13} className="text-foreground" />}
                onPress={go(() => router.push({ pathname: '/(app)/projects/[id]', params: { id: projectId } } as any))}
              />
            ) : null}
            {projectId && onOpenProjectPane ? (
              <CardButton
                label="Side panel"
                icon={<PanelRight size={13} className="text-foreground" />}
                onPress={go(() => onOpenProjectPane(projectId, displayName))}
              />
            ) : null}
          </View>

          {!card && !failed ? <ActivityIndicator className="mt-4" /> : null}
          {failed ? <Text className="mt-3 text-xs text-muted-foreground">Couldn’t load this agent’s details.</Text> : null}

          {card ? (
            <View className="mt-3">
              <AgentProfileBody
                card={card}
                onToggleMute={toggleMute}
                onOpenChannel={onOpenChannel ? (id) => { onClose(); onOpenChannel(id) } : undefined}
              />
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  )
}

function CardButton({ label, icon, onPress }: { label: string; icon: React.ReactNode; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="flex-row items-center gap-1.5 rounded-md border border-border px-2.5 py-1 active:bg-muted"
    >
      {icon}
      <Text className="text-xs font-medium text-foreground">{label}</Text>
    </Pressable>
  )
}
