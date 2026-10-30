// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team Home on a phone. It leads with the work: ask the workspace agent,
 * see what agents are doing right now, and what needs you. Below that sit
 * the places you work in: unread conversations, projects, channels and
 * agents, each its own section.
 *
 * Everything below the header is one virtualized list, so a workspace with
 * hundreds of channels and projects mounts only the rows on screen.
 */
import { memo, useCallback, useMemo, useState } from 'react'
import { Platform, Pressable, RefreshControl, SectionList, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { Folder, Sparkles, type LucideIcon } from 'lucide-react-native'
import { useProjectCollection } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useHomeSignals } from '../../hooks/useHomeSignals'
import { useAgentRows } from '../../hooks/useAgentRows'
import { WORKSPACE_AGENT_KEY } from '../../lib/agent-urgency'
import type { ActivityEntry } from '../../lib/activity-feed'
import type { ConversationSummary } from '../../lib/team-chat-api'
import { usePhoneLayout } from '../../lib/native-phone-layout'
import { AgentsSection } from './AgentsSection'
import { AgentsPanel } from '../team-chat/panels/AgentsPanel'
import { useChannelPanelSections } from '../team-chat/panels/ChannelsPanel'
import { ConversationRowView, PanelLink, PanelSectionHeader } from '../team-chat/ConversationRows'
import { TabScreen, useTabScreenScroll } from '../layout/TabScreenHeader'
import { WorkspaceSidebarAvatar } from '../layout/WorkspaceSidebarAvatar'
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

type HomeRow =
  | { key: string; kind: 'agents-section' }
  | { key: string; kind: 'agents-panel' }
  | { key: string; kind: 'failed'; entry: ActivityEntry }
  | { key: string; kind: 'conversation'; conversation: ConversationSummary }
  | { key: string; kind: 'project'; project: { id: string; name: string } }
  | { key: string; kind: 'link'; icon: LucideIcon; label: string; onPress: () => void }
  | { key: string; kind: 'empty'; text: string }

interface HomeSection {
  key: string
  label?: string
  addLabel?: string
  onAdd?: () => void
  fixed?: boolean
  defaultCollapsed?: boolean
  /** SectionList reads `data`; the rest of the fields are the header's. */
  data: HomeRow[]
}

/** A project in Home's list. Memoized so scrolling does not rebuild the tree. */
const ProjectRow = memo(function ProjectRow({
  project,
  onOpen,
}: {
  project: { id: string; name: string }
  onOpen: (project: { id: string; name: string }) => void
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={project.name}
      onPress={() => onOpen(project)}
      className="flex-row items-center gap-3 rounded-md px-3 py-2 active:bg-accent/50"
    >
      <Folder size={16} className="text-muted-foreground" />
      <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
        {project.name}
      </Text>
    </Pressable>
  )
})

/** A failed agent turn that has no agent row of its own. */
const FailedRow = memo(function FailedRow({ entry, onOpen }: { entry: ActivityEntry; onOpen: (entry: ActivityEntry) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.title}, failed`}
      onPress={() => onOpen(entry)}
      className="rounded-md px-3 py-2 active:bg-accent/50"
    >
      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
        {entry.title}
      </Text>
      <Text className="text-xs text-destructive" numberOfLines={1}>{`Failed · ${entry.context.replace('Agent task in ', '')}`}</Text>
    </Pressable>
  )
})

export const MobileHomeFeed = observer(function MobileHomeFeed() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const projects = useProjectCollection()
  const focused = useFocused()
  const comfortable = usePhoneLayout()
  const scroll = useTabScreenScroll()
  const { chat, activity, failed, mentions, starred, unread, openEntry } = useHomeSignals({ polling: focused })
  const workspaceId = chat.workspaceId
  const recent = useMemo(() => recentProjects(projects.all as any[], workspace?.id), [projects.all, workspace?.id])
  const { rows, refreshApprovals } = useAgentRows({
    workspaceId,
    agents: chat.mentionables?.agents,
    tasks: activity.tasks,
    activeChats: activity.activeChats,
    polling: focused,
  })
  // Failures of agents without a row of their own (not in the directory) stay listed below.
  const unlisted = useMemo(() => {
    const shown = new Set(rows.map((r) => r.key))
    return failed.filter((entry) => !shown.has(entry.agent?.task?.projectId ?? WORKSPACE_AGENT_KEY))
  }, [failed, rows])
  const channels = useChannelPanelSections()

  // Collapsed sections keep their header and drop their rows, the way the
  // stacked panels behave.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const toggle = useCallback((key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] })), [])

  const openProject = useCallback(
    (project: { id: string; name: string }) =>
      router.push({
        pathname: '/(app)/projects/[id]',
        // Native phones always land on the project chat.
        params: Platform.OS === 'web' ? { id: project.id } : { id: project.id, tab: 'chat-fullscreen' },
      } as any),
    [router],
  )
  const openConversation = chat.openConversation
  const activeId = chat.activeId

  const sections = useMemo<HomeSection[]>(() => {
    const list: HomeSection[] = []
    if (workspaceId && rows.length > 0) {
      list.push({ key: 'agents-section', data: [{ key: 'agents-section', kind: 'agents-section' }] })
    }
    const needsYou: HomeRow[] = [
      ...unlisted.map((entry) => ({ key: `failed:${entry.id}`, kind: 'failed' as const, entry })),
      ...(workspaceId ? mentions.map((c) => ({ key: `mention:${c.id}`, kind: 'conversation' as const, conversation: c })) : []),
    ]
    if (needsYou.length > 0) list.push({ key: 'needs-you', label: 'Needs you', data: needsYou })
    const inbox: HomeRow[] =
      workspaceId && (starred.length > 0 || unread.length > 0)
        ? [...unread, ...(unread.length > 0 ? [] : starred)].map((c) => ({
            key: `inbox:${c.id}`,
            kind: 'conversation' as const,
            conversation: c,
          }))
        : []
    if (inbox.length > 0) {
      list.push({ key: 'inbox', label: unread.length > 0 ? 'Unread conversations' : 'Starred', data: inbox })
    }
    list.push({
      key: 'projects',
      label: 'Projects',
      addLabel: 'New project',
      onAdd: () => router.push('/(app)/new-project' as any),
      data:
        recent.length > 0
          ? recent.map((project: any) => ({ key: `project:${project.id}`, kind: 'project' as const, project }))
          : [{ key: 'projects-empty', kind: 'empty' as const, text: 'No projects yet.' }],
    })
    if (chat.enabled) {
      for (const section of channels) {
        list.push({
          key: `channels-${section.key}`,
          label: section.label,
          addLabel: section.addLabel,
          onAdd: section.onAdd,
          fixed: section.fixed,
          defaultCollapsed: section.defaultCollapsed,
          data: [
            ...section.conversations.map((c) => ({ key: `c:${c.id}`, kind: 'conversation' as const, conversation: c })),
            ...section.links.map((link) => ({
              key: `link:${section.key}:${link.key}`,
              kind: 'link' as const,
              icon: link.icon,
              label: link.label,
              onPress: link.onPress,
            })),
          ],
        })
      }
      list.push({ key: 'agents-panel', data: [{ key: 'agents-panel', kind: 'agents-panel' }] })
    }
    return list
  }, [workspaceId, rows.length, unlisted, mentions, starred, unread, recent, router, chat.enabled, channels])

  // A collapsed section keeps its header and hands the list no rows.
  const visibleSections = useMemo<HomeSection[]>(
    () =>
      sections.map((section) =>
        section.label && !section.fixed && (collapsed[section.key] ?? section.defaultCollapsed ?? false)
          ? { ...section, data: [] }
          : section,
      ),
    [sections, collapsed],
  )

  const renderItem = useCallback(
    ({ item }: { item: HomeRow }) => {
      switch (item.kind) {
        case 'agents-section':
          return workspaceId ? <AgentsSection rows={rows} workspaceId={workspaceId} /> : null
        case 'agents-panel':
          return <AgentsPanel />
        case 'failed':
          return <FailedRow entry={item.entry} onOpen={openEntry} />
        case 'conversation':
          return (
            <ConversationRowView
              conversation={item.conversation}
              workspaceId={workspaceId!}
              active={activeId === item.conversation.id}
              onPress={openConversation}
              comfortable={comfortable}
            />
          )
        case 'project':
          return <ProjectRow project={item.project} onOpen={openProject} />
        case 'link':
          return <PanelLink icon={item.icon} label={item.label} onPress={item.onPress} />
        case 'empty':
          return <Text className="px-3 py-1 text-sm text-muted-foreground">{item.text}</Text>
      }
    },
    [workspaceId, rows, openEntry, activeId, openConversation, comfortable, openProject],
  )

  const renderSectionHeader = useCallback(
    ({ section }: { section: HomeSection }) => {
      if (!section.label) return null
      const isCollapsed = section.fixed ? false : collapsed[section.key] ?? section.defaultCollapsed ?? false
      return (
        <View className="px-2 pt-3">
          <PanelSectionHeader
            label={section.label}
            addLabel={section.addLabel}
            onAdd={section.onAdd}
            fixed={section.fixed}
            expanded={!isCollapsed}
            onToggle={section.fixed ? undefined : () => toggle(section.key)}
            comfortable={comfortable}
          />
        </View>
      )
    },
    [collapsed, toggle, comfortable],
  )

  const keyExtractor = useCallback((item: HomeRow) => item.key, [])

  return (
    <TabScreen
      testID="mobile-home-feed"
      title={workspace?.name ?? 'Home'}
      leading={<WorkspaceSidebarAvatar workspaceName={workspace?.name} />}
    >
      <SectionList
        testID="home-sections"
        sections={visibleSections}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        stickySectionHeadersEnabled={false}
        contentContainerClassName="px-1 pb-36"
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        {...scroll}
        ListHeaderComponent={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ask the workspace agent"
            onPress={() => router.push('/(app)/agent' as any)}
            className="mx-3 mb-3 mt-1 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 active:bg-accent/50"
          >
            <Sparkles size={18} className="text-primary" />
            <Text className="flex-1 text-base text-muted-foreground">Ask the workspace agent…</Text>
          </Pressable>
        }
        refreshControl={
          <RefreshControl
            refreshing={activity.refreshing}
            onRefresh={() => {
              void activity.refresh({ manual: true })
              void refreshApprovals()
            }}
          />
        }
      />
    </TabScreen>
  )
})
