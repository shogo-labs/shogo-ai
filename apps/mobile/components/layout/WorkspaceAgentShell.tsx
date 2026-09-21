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
import { Modal, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import {
  Activity,
  Bot,
  Boxes,
  CirclePlus,
  FolderKanban,
  ListTodo,
  MessageSquare,
  Search,
  Settings,
  Store,
  Target,
  X,
} from 'lucide-react-native'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import {
  getKnownPrimaryWorkspaceSession,
  subscribePrimaryWorkspaceSession,
} from '../workspace/workspace-agent-session-bus'
import { api } from '../../lib/api'
import { ShogoLogoMark } from '../branding/ShogoLogoMark'
import SettingsPage from '../../app/(app)/settings'
import { CommandPalette } from './CommandPalette'
import { cn } from '@shogo/shared-ui/primitives'

interface NavItem {
  label: string
  href?: string
  icon: typeof Bot
  action?: 'search'
}

const primaryNav: NavItem[] = [
  { label: 'Chat', href: '/(app)', icon: MessageSquare },
  { label: 'Search', icon: Search, action: 'search' },
  { label: 'Projects', href: '/(app)/projects', icon: FolderKanban },
  { label: 'Tasks', href: '/(app)/tasks', icon: ListTodo },
  { label: 'Goals', href: '/(app)/goals', icon: Target },
  { label: 'Activity', href: '/(app)/activity', icon: Activity },
  { label: 'Canvases', href: '/(app)/canvases', icon: Boxes },
  { label: 'Marketplace', href: '/(app)/marketplace', icon: Store },
]

function routeIsActive(pathname: string, href: string): boolean {
  if (href === '/(app)') return pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'
  const normalized = href.replace('/(app)', '')
  return pathname === normalized || pathname.startsWith(`${normalized}/`)
}

export function WorkspaceAgentShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { width, height } = useWindowDimensions()
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

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

  const openSettings = () => {
    setSettingsOpen(true)
  }

  const openSearch = () => {
    // On web, mounting a full-screen modal during the rail button's press can
    // let the new backdrop receive that same interaction and dismiss itself.
    // Open on the next frame once the originating press has fully finished.
    requestAnimationFrame(() => setSearchOpen(true))
  }

  const closeSearch = () => {
    setSearchOpen(false)
  }

  return (
    <View className="relative flex-row flex-1 bg-background">
      <View className="w-14 shrink-0 items-center border-r border-border/70 bg-card py-3">
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Shogo home"
          onPress={() => router.push('/(app)' as any)}
          className="mb-5 h-9 w-9 items-center justify-center rounded-xl active:bg-muted"
        >
          <ShogoLogoMark className="h-6 w-6" />
        </Pressable>
        <View className="flex-1 items-center justify-center">
          <View className="items-center gap-2">
            {primaryNav.map(({ href, label, icon: Icon, action }) => {
              const active = action === 'search'
                ? searchOpen
                : href ? routeIsActive(pathname, href) : false
              return (
                <Pressable
                  key={href ?? action}
                  accessibilityRole={action ? 'button' : 'link'}
                  accessibilityLabel={label}
                  accessibilityState={{ selected: active }}
                  onPress={() => action === 'search' ? openSearch() : router.push(href as any)}
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
        </View>
        <View className="items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open settings"
            onPress={openSettings}
            className={cn(
              'h-9 w-9 items-center justify-center rounded-lg',
              settingsOpen ? 'bg-primary/12' : 'active:bg-muted',
            )}
          >
            <Settings
              size={18}
              className={settingsOpen ? 'text-primary' : 'text-muted-foreground'}
            />
          </Pressable>
        </View>
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
      </View>

      <View className="min-w-0 flex-1 bg-background">{children}</View>

      <CommandPalette visible={searchOpen} onClose={closeSearch} />

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <View className="flex-1 items-center justify-center bg-black/45 p-6">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close settings"
            onPress={() => setSettingsOpen(false)}
            className="absolute inset-0"
          />
          <View
            accessibilityViewIsModal
            className="overflow-hidden rounded-[28px] border border-border bg-background"
            style={{
              width: Math.min(width - 48, 1000),
              height: Math.min(height - 48, 760),
              shadowColor: '#000',
              shadowOpacity: 0.24,
              shadowRadius: 30,
              elevation: 20,
            }}
          >
            <SettingsPage />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close settings"
              onPress={() => setSettingsOpen(false)}
              className="absolute right-4 top-4 h-9 w-9 items-center justify-center rounded-full bg-background/90 active:bg-muted"
            >
              <X size={18} className="text-foreground" />
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  )
}
