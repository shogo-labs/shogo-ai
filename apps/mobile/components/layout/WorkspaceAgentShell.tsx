// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop-first shell for the staged Workspace Agent rollout.
 *
 * It deliberately renders existing routes as children. This makes the shell a
 * visual/navigation migration rather than a second application surface, so
 * project, billing, permissions, and deep-link behavior remain unchanged.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import {
  Activity,
  Bot,
  Boxes,
  CirclePlus,
  FolderKanban,
  LayoutTemplate,
  ListTodo,
  Search,
  Settings,
  Target,
} from 'lucide-react-native'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import {
  getKnownPrimaryWorkspaceSession,
  subscribePrimaryWorkspaceSession,
} from '../workspace/workspace-agent-session-bus'
import { api } from '../../lib/api'
import { cn } from '@shogo/shared-ui/primitives'

interface NavItem {
  label: string
  href: string
  icon: typeof Bot
}

const primaryNav: NavItem[] = [
  { label: 'Chat', href: '/(app)', icon: Bot },
  { label: 'Projects', href: '/(app)/projects', icon: FolderKanban },
  { label: 'Tasks', href: '/(app)/tasks', icon: ListTodo },
  { label: 'Goals', href: '/(app)/goals', icon: Target },
  { label: 'Activity', href: '/(app)/activity', icon: Activity },
  { label: 'Canvases', href: '/(app)/canvases', icon: Boxes },
  { label: 'Explore', href: '/(app)/marketplace', icon: LayoutTemplate },
]

function routeIsActive(pathname: string, href: string): boolean {
  if (href === '/(app)') return pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'
  const normalized = href.replace('/(app)', '')
  return pathname === normalized || pathname.startsWith(`${normalized}/`)
}

export function WorkspaceAgentShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const sideChatMatch = pathname.match(/\/side-chats\/([^/]+)/)
  const sideChatId = sideChatMatch?.[1] ? decodeURIComponent(sideChatMatch[1]) : null
  const isWorkspaceChatRoute = routeIsActive(pathname, '/(app)') || sideChatId !== null
  const workspaceName = (workspace as any)?.name || (experience.kind === 'personal' ? 'Personal workspace' : 'Workspace')
  const [primarySessionId, setPrimarySessionId] = useState<string | null>(null)
  const [sideChats, setSideChats] = useState<Array<{
    id: string
    name?: string | null
    inferredName?: string | null
    isPrimary?: boolean
  }>>([])
  const [creatingSideChat, setCreatingSideChat] = useState(false)

  useEffect(() => {
    if (!workspace?.id || !isWorkspaceChatRoute) {
      setPrimarySessionId(null)
      setSideChats([])
      return
    }
    let cancelled = false
    const loadChatChrome = async (publishedPrimaryId?: string | null) => {
      try {
        const sessions = await api.listWorkspaceSessions(http, workspace.id)
        const activeSessionId = sideChatId
          ?? publishedPrimaryId
          ?? sessions.find((session) => session.isPrimary)?.id
          ?? null
        if (cancelled) return
        setPrimarySessionId(activeSessionId)
        setSideChats(sessions.filter((session) => !session.isPrimary))
      } catch {
        if (!cancelled) {
          setPrimarySessionId(null)
          setSideChats([])
        }
      }
    }

    void loadChatChrome(getKnownPrimaryWorkspaceSession(workspace.id))
    const unsubscribe = subscribePrimaryWorkspaceSession(workspace.id, (sessionId) => {
      void loadChatChrome(sessionId)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [http, isWorkspaceChatRoute, sideChatId, workspace?.id])

  const startSideChat = async () => {
    if (!workspace?.id || creatingSideChat) return
    try {
      setCreatingSideChat(true)
      const session = await api.createWorkspaceSession(http, workspace.id)
      router.push({ pathname: '/(app)/side-chats/[id]', params: { id: session.id } } as any)
    } finally {
      setCreatingSideChat(false)
    }
  }

  const visibleNav = primaryNav.filter((item) => {
    if (item.href === '/(app)/marketplace') return experience.showMarketplace
    return true
  })

  return (
    <View className="flex-row flex-1 bg-background">
      <View className="w-14 shrink-0 items-center border-r border-border/70 bg-card py-3">
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Workspace Agent Chat"
          onPress={() => router.push('/(app)' as any)}
          className="mb-5 h-9 w-9 items-center justify-center rounded-xl bg-primary"
        >
          <Bot size={18} color="#fff" />
        </Pressable>
        <View className="items-center gap-2">
          {visibleNav.map(({ href, label, icon: Icon }) => {
            const active = routeIsActive(pathname, href)
            return (
              <Pressable
                key={href}
                accessibilityRole="link"
                accessibilityLabel={label}
                accessibilityState={{ selected: active }}
                onPress={() => router.push(href as any)}
                className={cn(
                  'h-9 w-9 items-center justify-center rounded-lg',
                  active ? 'bg-primary/12' : 'active:bg-muted',
                )}
              >
                <Icon size={18} className={active ? 'text-primary' : 'text-muted-foreground'} />
              </Pressable>
            )
          })}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Search"
          onPress={() => router.push('/(app)/search' as any)}
          className="mt-auto h-9 w-9 items-center justify-center rounded-lg active:bg-muted"
        >
          <Search size={18} className="text-muted-foreground" />
        </Pressable>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="More settings"
          onPress={() => router.push('/(app)/settings' as any)}
          className={cn(
            'mt-2 h-9 w-9 items-center justify-center rounded-lg',
            routeIsActive(pathname, '/(app)/settings') ? 'bg-primary/12' : 'active:bg-muted',
          )}
        >
          <Settings
            size={18}
            className={routeIsActive(pathname, '/(app)/settings') ? 'text-primary' : 'text-muted-foreground'}
          />
        </Pressable>
      </View>

      <View className="w-60 shrink-0 border-r border-border/70 bg-card/60 px-3 py-4">
        <View className="mb-5 px-2">
          <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Workspace</Text>
          <Text className="mt-1 text-sm font-semibold text-foreground" numberOfLines={1}>
            {workspaceName}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create a new project"
          onPress={() => router.push({
            pathname: '/(app)/new-project',
            params: primarySessionId ? { chatSessionId: primarySessionId } : {},
          } as any)}
          className="mb-5 flex-row items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 active:opacity-85"
        >
          <CirclePlus size={16} color="#fff" />
          <Text className="text-sm font-semibold text-primary-foreground">New project</Text>
        </Pressable>
        <Text className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Conversations
        </Text>
        <Pressable
          accessibilityRole="link"
          accessibilityState={{ selected: routeIsActive(pathname, '/(app)') }}
          accessibilityLabel="Workspace Agent Chat"
          onPress={() => router.push('/(app)' as any)}
          className={cn(
            'rounded-lg px-2.5 py-2',
            routeIsActive(pathname, '/(app)') ? 'bg-primary/10' : 'active:bg-muted',
          )}
        >
          <Text className="text-sm font-medium text-foreground">Workspace Agent Chat</Text>
          <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
            Your primary conversation
          </Text>
        </Pressable>
        {experience.workspaceAgent.sideChats ? (
          <>
            {sideChats.slice(0, 4).map((session) => (
              <Pressable
                key={session.id}
                accessibilityRole="link"
                accessibilityLabel={`Open side chat ${session.name || session.inferredName || 'Untitled'}`}
                onPress={() => router.push({ pathname: '/(app)/side-chats/[id]', params: { id: session.id } } as any)}
                className="mt-1 rounded-lg px-2.5 py-2 active:bg-muted"
              >
                <Text className="text-sm text-muted-foreground" numberOfLines={1}>
                  {session.name || session.inferredName || 'Untitled side chat'}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start a new side chat"
              disabled={creatingSideChat}
              onPress={() => void startSideChat()}
              className="mt-1 rounded-lg px-2.5 py-2 active:bg-muted disabled:opacity-50"
            >
              <Text className="text-sm text-primary">
                {creatingSideChat ? 'Starting…' : '+ New side chat'}
              </Text>
            </Pressable>
          </>
        ) : null}
        <View className="mt-auto border-t border-border/70 pt-3">
          <Text className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">More</Text>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Workspace settings"
            onPress={() => router.push('/(app)/settings' as any)}
            className="rounded-lg px-2.5 py-2 active:bg-muted"
          >
            <Text className="text-sm text-muted-foreground">Settings & integrations</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Workspace billing"
            onPress={() => router.push('/(app)/billing' as any)}
            className="rounded-lg px-2.5 py-2 active:bg-muted"
          >
            <Text className="text-sm text-muted-foreground">Billing</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Account"
            onPress={() => router.push('/(app)/account' as any)}
            className="rounded-lg px-2.5 py-2 active:bg-muted"
          >
            <Text className="text-sm text-muted-foreground">Account</Text>
          </Pressable>
        </View>
      </View>

      <View className="min-w-0 flex-1 bg-background">{children}</View>
    </View>
  )
}
