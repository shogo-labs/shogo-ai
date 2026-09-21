// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Conversation-first companion sidebar for the desktop Workspace Agent shell.
 *
 * Workspace side chats are deliberately distinct from project chats: they use
 * the merged-root Workspace Agent, while each project chat opens that project's
 * own agent/runtime.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  MessageCircle,
  Plus,
  Search,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp, useProjectCollection } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { api } from '../../lib/api'
import {
  fetchProjectChatSessions,
  PROJECT_CHAT_PAGE_SIZE,
  projectChatLabel,
  visibleProjectChatItems,
  type ProjectChatListItem,
} from '../../lib/project-chat-sessions'
import {
  getKnownPrimaryWorkspaceSession,
  subscribePrimaryWorkspaceSession,
} from '../workspace/workspace-agent-session-bus'

const PROJECT_CHAT_INITIAL_COUNT = PROJECT_CHAT_PAGE_SIZE

type WorkspaceSession = {
  id: string
  workspaceId: string
  isPrimary?: boolean
  name?: string | null
  inferredName?: string | null
  lastActiveAt?: string
}

type ProjectChatState = {
  sessions: ProjectChatListItem[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
}

function sidebarSessionLabel(session: WorkspaceSession) {
  return session.name || session.inferredName || 'New side chat'
}

function routeIsActive(pathname: string, href: string): boolean {
  if (href === '/(app)') return pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'
  const normalized = href.replace('/(app)', '')
  return pathname === normalized || pathname.startsWith(`${normalized}/`)
}

export function WorkspaceConversationSidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const projects = useProjectCollection()
  const experience = useWorkspaceExperience()
  const sideChatMatch = pathname.match(/\/side-chats\/([^/]+)/)
  const sideChatId = sideChatMatch?.[1] ? decodeURIComponent(sideChatMatch[1]) : null

  const [sessions, setSessions] = useState<WorkspaceSession[]>([])
  const [primarySessionId, setPrimarySessionId] = useState<string | null>(null)
  const [creatingSideChat, setCreatingSideChat] = useState(false)
  const [chatQuery, setChatQuery] = useState('')
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())
  const [projectChats, setProjectChats] = useState<Record<string, ProjectChatState>>({})

  const loadWorkspaceSessions = useCallback(async (publishedPrimaryId?: string | null) => {
    if (!workspace?.id) return
    const nextSessions = await api.listWorkspaceSessions(http, workspace.id)
    setSessions(nextSessions)
    setPrimarySessionId(
      publishedPrimaryId
      ?? nextSessions.find((session) => session.isPrimary)?.id
      ?? null,
    )
  }, [http, workspace?.id])

  useEffect(() => {
    if (!workspace?.id) {
      setSessions([])
      setPrimarySessionId(null)
      setProjectChats({})
      setExpandedProjectIds(new Set())
      return
    }

    setProjectChats({})
    setExpandedProjectIds(new Set())
    void loadWorkspaceSessions(getKnownPrimaryWorkspaceSession(workspace.id)).catch(() => {
      setSessions([])
      setPrimarySessionId(null)
    })
    void projects.loadAll({ workspaceId: workspace.id }).catch(() => undefined)

    return subscribePrimaryWorkspaceSession(workspace.id, (sessionId) => {
      void loadWorkspaceSessions(sessionId).catch(() => undefined)
    })
  }, [loadWorkspaceSessions, projects, workspace?.id])

  const sideChats = useMemo(
    () => sessions
      .filter((session) => !session.isPrimary)
      .sort((a, b) => (
        new Date(b.lastActiveAt || 0).getTime() - new Date(a.lastActiveAt || 0).getTime()
      )),
    [sessions],
  )
  const normalizedChatQuery = chatQuery.trim().toLowerCase()
  const matchingSideChats = useMemo(
    () => sideChats.filter((session) => (
      !normalizedChatQuery || sidebarSessionLabel(session).toLowerCase().includes(normalizedChatQuery)
    )),
    [normalizedChatQuery, sideChats],
  )
  const workspaceProjects = useMemo(
    () => projects.all
      .filter((project: any) => project.workspaceId === workspace?.id)
      .sort((a: any, b: any) => (
        String(a.name || '').localeCompare(String(b.name || ''))
      )),
    [projects.all, workspace?.id],
  )

  const startSideChat = async () => {
    if (!workspace?.id || creatingSideChat) return
    try {
      setCreatingSideChat(true)
      // Side chats always talk to the Workspace/Shogo agent. Project agent
      // sessions are created only from a project's own chat history below.
      const session = await api.createWorkspaceSession(http, workspace.id)
      await loadWorkspaceSessions()
      router.push({ pathname: '/(app)/side-chats/[id]', params: { id: session.id } } as any)
    } finally {
      setCreatingSideChat(false)
    }
  }

  const loadProjectChats = useCallback(async (projectId: string, offset = 0) => {
    const isFirstPage = offset === 0
    setProjectChats((current) => ({
      ...current,
      [projectId]: {
        sessions: current[projectId]?.sessions ?? [],
        loading: isFirstPage,
        loadingMore: !isFirstPage,
        hasMore: current[projectId]?.hasMore ?? false,
      },
    }))
    try {
      const result = await fetchProjectChatSessions(
        http,
        projectId,
        PROJECT_CHAT_INITIAL_COUNT,
        offset,
      )
      setProjectChats((current) => ({
        ...current,
        [projectId]: {
          sessions: visibleProjectChatItems(
            isFirstPage
              ? result.sessions
              : [...(current[projectId]?.sessions ?? []), ...result.sessions],
          ),
          loading: false,
          loadingMore: false,
          hasMore: result.hasMore,
        },
      }))
    } catch {
      setProjectChats((current) => ({
        ...current,
        [projectId]: {
          sessions: current[projectId]?.sessions ?? [],
          loading: false,
          loadingMore: false,
          hasMore: false,
        },
      }))
    }
  }, [http])

  useEffect(() => {
    if (!normalizedChatQuery) return
    workspaceProjects.forEach((project: any) => {
      if (!projectChats[project.id]) {
        void loadProjectChats(project.id)
      }
    })
  }, [loadProjectChats, normalizedChatQuery, projectChats, workspaceProjects])

  const toggleProject = (projectId: string) => {
    const isExpanded = expandedProjectIds.has(projectId)
    setExpandedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
    if (!isExpanded && !projectChats[projectId]) {
      void loadProjectChats(projectId)
    }
  }

  return (
    <View className="w-64 shrink-0 border-r border-border/70 bg-card/60">
      <View className="border-b border-border/70 px-3 py-3">
        <View className="flex-row items-center gap-2 rounded-2xl border border-border/70 bg-background px-3 py-2">
          <Search size={16} className="text-muted-foreground" />
          <TextInput
            value={chatQuery}
            onChangeText={setChatQuery}
            placeholder="Search chats"
            placeholderTextColor="#8a8a8a"
            className="min-w-0 flex-1 text-sm text-foreground"
            accessibilityLabel="Search side chats and project chats"
          />
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-3 py-3"
        showsVerticalScrollIndicator
      >
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open Main Chat"
          accessibilityState={{ selected: routeIsActive(pathname, '/(app)') }}
          onPress={() => router.push('/(app)' as any)}
          className={cn(
            'rounded-xl px-3 py-2.5',
            routeIsActive(pathname, '/(app)') ? 'bg-primary/10' : 'active:bg-muted',
          )}
        >
          <Text className="text-sm font-medium text-foreground">Main Chat</Text>
        </Pressable>

        {experience.workspaceAgent.sideChats ? (
          <View className="mt-5">
            <View className="mb-1 flex-row items-center justify-between px-2">
              <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Side chats</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Start a new Shogo side chat"
                disabled={creatingSideChat}
                onPress={() => void startSideChat()}
                className="h-7 w-7 items-center justify-center rounded-lg border border-border/70 active:bg-muted disabled:opacity-50"
              >
                {creatingSideChat ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Plus size={15} className="text-foreground" />
                )}
              </Pressable>
            </View>
            <ScrollView
              nestedScrollEnabled
              showsVerticalScrollIndicator={sideChats.length > 5}
              style={{ maxHeight: 184 }}
            >
              {matchingSideChats.map((session) => {
                const active = session.id === sideChatId
                return (
                  <Pressable
                    key={session.id}
                    accessibilityRole="link"
                    accessibilityLabel={`Open side chat ${sidebarSessionLabel(session)}`}
                    accessibilityState={{ selected: active }}
                    onPress={() => router.push({
                      pathname: '/(app)/side-chats/[id]',
                      params: { id: session.id },
                    } as any)}
                    className={cn(
                      'mt-0.5 flex-row items-center gap-2 rounded-lg px-2.5 py-2',
                      active ? 'bg-primary/10' : 'active:bg-muted',
                    )}
                  >
                    <MessageCircle size={15} className={active ? 'text-primary' : 'text-muted-foreground'} />
                    <Text
                      className={cn('flex-1 text-sm', active ? 'font-medium text-foreground' : 'text-muted-foreground')}
                      numberOfLines={1}
                    >
                      {sidebarSessionLabel(session)}
                    </Text>
                  </Pressable>
                )
              })}
            </ScrollView>
            {matchingSideChats.length === 0 ? (
              <Text className="px-2 py-2 text-xs text-muted-foreground">
                {normalizedChatQuery ? 'No matching side chats.' : 'No side chats yet.'}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View className="mt-5 border-t border-border/70 pt-4">
          <View className="mb-2 flex-row items-center justify-between px-2">
            <View className="flex-row items-center gap-2">
              <Folder size={16} className="text-muted-foreground" />
              <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Projects</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create a new project"
              onPress={() => router.push({
                pathname: '/(app)/new-project',
                params: primarySessionId ? { chatSessionId: primarySessionId } : {},
              } as any)}
              className="h-7 w-7 items-center justify-center rounded-lg border border-border/70 active:bg-muted"
            >
              <Plus size={15} className="text-foreground" />
            </Pressable>
          </View>
          {workspaceProjects.map((project: any) => {
            const chats = projectChats[project.id]
            const matchingProjectChats = chats?.sessions.filter((chat) => (
              !normalizedChatQuery || projectChatLabel(chat).toLowerCase().includes(normalizedChatQuery)
            )) ?? []
            const projectNameMatches = String(project.name || '').toLowerCase().includes(normalizedChatQuery)
            const projectMatches = !normalizedChatQuery
              || projectNameMatches
              || matchingProjectChats.length > 0
              || chats?.loading
            if (!projectMatches) return null
            const expanded = expandedProjectIds.has(project.id)
              || (!!normalizedChatQuery && !!chats)
            const visibleChats = normalizedChatQuery ? matchingProjectChats : chats?.sessions
            return (
              <View key={project.id} className="mb-1">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} chats for ${project.name || 'Untitled project'}`}
                  accessibilityState={{ expanded }}
                  onPress={() => toggleProject(project.id)}
                  className="flex-row items-center gap-2 rounded-lg px-2.5 py-2 active:bg-muted"
                >
                  {expanded ? (
                    <ChevronDown size={15} className="text-muted-foreground" />
                  ) : (
                    <ChevronRight size={15} className="text-muted-foreground" />
                  )}
                  <Folder size={16} className="text-primary" />
                  <Text className="min-w-0 flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
                    {project.name || 'Untitled project'}
                  </Text>
                </Pressable>
                {expanded ? (
                  <View className="ml-5 border-l border-border/70 pl-2">
                    {chats?.loading ? (
                      <View className="items-start px-2 py-2">
                        <ActivityIndicator size="small" />
                      </View>
                    ) : visibleChats?.length ? (
                      <ScrollView
                        nestedScrollEnabled
                        showsVerticalScrollIndicator={visibleChats.length > 5}
                        style={{ maxHeight: 154 }}
                        scrollEventThrottle={16}
                        onScroll={({ nativeEvent }) => {
                          const reachedEnd = (
                            nativeEvent.contentOffset.y + nativeEvent.layoutMeasurement.height
                            >= nativeEvent.contentSize.height - 24
                          )
                          if (reachedEnd && chats.hasMore && !chats.loadingMore) {
                            void loadProjectChats(project.id, chats.sessions.length)
                          }
                        }}
                      >
                        {visibleChats.map((chat) => (
                          <Pressable
                            key={chat.id}
                            accessibilityRole="link"
                            accessibilityLabel={`Open project chat ${projectChatLabel(chat)}`}
                            onPress={() => router.push({
                              pathname: '/(app)/projects/[id]',
                              params: { id: project.id, chatSessionId: chat.id },
                            } as any)}
                            className="flex-row items-center gap-2 rounded-md px-2 py-1.5 active:bg-muted"
                          >
                            <MessageCircle size={14} className="text-muted-foreground" />
                            <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
                              {projectChatLabel(chat)}
                            </Text>
                          </Pressable>
                        ))}
                        {chats.loadingMore ? (
                          <View className="items-center py-2">
                            <ActivityIndicator size="small" />
                          </View>
                        ) : null}
                      </ScrollView>
                    ) : (
                      <Text className="px-2 py-2 text-xs text-muted-foreground">
                        {normalizedChatQuery ? 'No matching chats.' : 'No project chats yet.'}
                      </Text>
                    )}
                  </View>
                ) : null}
              </View>
            )
          })}
          {workspaceProjects.length === 0 ? (
            <Text className="px-2 py-2 text-xs text-muted-foreground">No projects yet.</Text>
          ) : null}
          {normalizedChatQuery && workspaceProjects.length > 0 && !workspaceProjects.some((project: any) => (
            String(project.name || '').toLowerCase().includes(normalizedChatQuery)
            || projectChats[project.id]?.sessions.some((chat) => (
              projectChatLabel(chat).toLowerCase().includes(normalizedChatQuery)
            ))
            || projectChats[project.id]?.loading
          )) ? (
            <Text className="px-2 py-2 text-xs text-muted-foreground">No matching project chats.</Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  )
}
