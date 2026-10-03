// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team Home on a phone. It leads with the work: ask the workspace agent,
 * see what agents are doing right now, and what needs you. Below that sit
 * the places you work in: unread conversations, projects, channels and
 * agents, each its own section.
 */
import { useMemo } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ChevronDown, Folder, Sparkles } from 'lucide-react-native'
import { useProjectCollection } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useHomeSignals } from '../../hooks/useHomeSignals'
import { RunningNow } from '../activity/ActivityFeed'
import { ChannelsPanel } from '../team-chat/panels/ChannelsPanel'
import { AgentsPanel } from '../team-chat/panels/AgentsPanel'
import { ConversationRow, PanelSection } from '../team-chat/ConversationRows'
import { TabScreen } from '../layout/TabScreenHeader'
import { recentProjects } from './recentProjects'

function useFocused(): boolean {
  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, []),
  )
  return focused
}

export const MobileHomeFeed = observer(function MobileHomeFeed() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const projects = useProjectCollection()
  const focused = useFocused()
  const { chat, activity, running, failed, mentions, starred, unread, openEntry, needsYou } = useHomeSignals({ polling: focused })
  const workspaceId = chat.workspaceId
  const recent = useMemo(() => recentProjects(projects.all as any[], workspace?.id), [projects.all, workspace?.id])

  return (
    <TabScreen
      testID="mobile-home-feed"
        title={workspace?.name ?? 'Home'}
        titleSlot={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${workspace?.name ?? 'Workspace'}, switch workspace`}
            onPress={() => router.push('/(app)/account' as any)}
            className="flex-row items-center gap-1"
          >
            <Text className="shrink text-[28px] font-bold leading-9 text-foreground" numberOfLines={1}>{workspace?.name ?? 'Home'}</Text>
            <ChevronDown size={18} className="text-muted-foreground" />
          </Pressable>
        }
    >
      <ScrollView
        contentContainerClassName="pb-36"
        refreshControl={<RefreshControl refreshing={activity.refreshing} onRefresh={() => void activity.refresh({ manual: true })} />}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ask the workspace agent"
          onPress={() => router.push('/(app)/agent' as any)}
          className="mx-4 mb-3 mt-1 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 active:bg-accent/50"
        >
          <Sparkles size={18} className="text-primary" />
          <Text className="flex-1 text-base text-muted-foreground">Ask the workspace agent…</Text>
        </Pressable>

        {running.length > 0 && <RunningNow entries={running} onOpen={openEntry} />}

        {needsYou > 0 && (
          <View className="mt-3 px-2">
            <PanelSection label="Needs you">
              {failed.map((entry) => (
                <Pressable
                  key={entry.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${entry.title}, failed`}
                  onPress={() => openEntry(entry)}
                  className="rounded-md px-2 py-2 active:bg-accent/50"
                >
                  <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{entry.title}</Text>
                  <Text className="text-xs text-destructive" numberOfLines={1}>{`Failed · ${entry.context.replace('Agent task in ', '')}`}</Text>
                </Pressable>
              ))}
              {workspaceId && mentions.map((c) => <ConversationRow key={c.id} conversation={c} workspaceId={workspaceId} active={false} onPress={chat.openConversation} />)}
            </PanelSection>
          </View>
        )}

        {workspaceId && (starred.length > 0 || unread.length > 0) && (
          <View className="mt-3 px-2">
            <PanelSection label={unread.length > 0 ? 'Unread conversations' : 'Starred'}>
              {[...unread, ...(unread.length > 0 ? [] : starred)].map((c) => (
                <ConversationRow key={c.id} conversation={c} workspaceId={workspaceId} active={false} onPress={chat.openConversation} />
              ))}
            </PanelSection>
          </View>
        )}

        <View className="mt-3 px-2">
          <PanelSection label="Projects" addLabel="New project" onAdd={() => router.push('/(app)/new-project' as any)}>
            {recent.map((project: any) => (
              <Pressable
                key={project.id}
                accessibilityRole="link"
                accessibilityLabel={project.name}
                onPress={() => router.push({ pathname: '/(app)/projects/[id]', params: { id: project.id } } as any)}
                className="flex-row items-center gap-2.5 rounded-md px-2 py-2 active:bg-accent/50"
              >
                <Folder size={16} className="text-muted-foreground" />
                <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>{project.name}</Text>
              </Pressable>
            ))}
            {recent.length === 0 && <Text className="px-2 py-1 text-sm text-muted-foreground">No projects yet.</Text>}
          </PanelSection>
        </View>

        {chat.enabled && (
          <View className="mt-3">
            <ChannelsPanel />
            <AgentsPanel />
          </View>
        )}
      </ScrollView>
    </TabScreen>
  )
})
