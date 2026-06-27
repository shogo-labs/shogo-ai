// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AppSidebar - Responsive navigation sidebar matching staging design
 *
 * Wide screens (>= 768px): persistent sidebar pinned to the left (w-64, collapsible to w-16)
 * Narrow screens (< 768px): slide-over drawer with backdrop overlay
 *
 * Sections:
 *  - Logo row: gradient "S" badge + "Shogo" text + collapse toggle
 *  - Primary nav: Home + Search (Cmd+K) [+ Meetings in local mode]
 *  - PROJECTS tree: every project, each expandable to reveal its chats
 *  - Upgrade to Pro CTA
 *  - Consolidated account button (workspace switcher + resource links +
 *    user/profile/sign-out) anchored at the bottom
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Linking,
  TextInput,
  Modal,
  useWindowDimensions,
  Platform,
  ActivityIndicator,
  type GestureResponderEvent,
} from 'react-native'
import { usePostHogSafe } from '../../contexts/posthog'
import { useTheme } from '../../contexts/theme'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { formatModKey } from '../../lib/keyboard-shortcuts'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import { usePathname, useRouter, useLocalSearchParams } from 'expo-router'
import { defaultTabForProject } from '../../lib/project-preview-tab'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import {
  Home,
  Search,
  Star,
  Users,
  User,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  Folder,
  MessageSquare,
  Plus,
  X,
  LogOut,
  Sun,
  Moon,
  Monitor,
  Laptop,
  Settings,
  Zap,
  Check,
  Inbox,
  Shield,
  Key,
  Store,
  Mic,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
  Loader2,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Avatar } from '@shogo/shared-ui/primitives'
import { CommandPalette, useCommandPalette } from './CommandPalette'
import { SidebarContextMenu, type SidebarMenuEntry } from './SidebarContextMenu'
import { useActiveInstance } from '../../contexts/active-instance'
import { ShogoWordmark } from '../branding/ShogoWordmark'
import { useAuth } from '../../contexts/auth'
import {
  useProjectCollection,
  useWorkspaceCollection,
  useDomainActions,
  useDomainHttp,
} from '../../contexts/domain'
import { useBillingData } from '@shogo/shared-app/hooks'
import { getPlanDisplayName } from '../../lib/billing-config'
import { CompactUsageWindows } from '../billing/UsageWindows'
import { NotificationBell } from '../notifications/NotificationBell'
import { api } from '../../lib/api'
import { trackPurchase } from '../../lib/tracking'
import { getActiveWorkspaceId, setActiveWorkspaceId } from '../../lib/workspace-store'
import { workspaceProjectFilter } from '../../lib/project-load'
import { usePlatformConfig } from '../../lib/platform-config'
import { invitationEvents } from '../../lib/invitation-events'
import { chatSessionEvents, chatActivityEvents } from '../../lib/chat-session-events'
import {
  getPinnedProjectIds,
  setPinnedProjectIds,
  getProjectFilter,
  setProjectFilter,
  type ProjectSort,
  type ProjectScope,
} from '../../lib/project-prefs-store'

function getInitials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

// ─── NavItem ───────────────────────────────────────────────

interface NavItemProps {
  icon: React.ElementType
  label: string
  href?: string
  externalHref?: string
  active?: boolean
  collapsed?: boolean
  onPress?: () => void
  shortcut?: string
  onNavPress?: () => void
}

function NavItem({
  icon: Icon,
  label,
  href,
  externalHref,
  active,
  collapsed,
  onPress,
  shortcut,
  onNavPress,
}: NavItemProps) {
  const router = useRouter()

  const handlePress = useCallback(() => {
    if (onPress) {
      onPress()
      return
    }
    if (externalHref) {
      Linking.openURL(externalHref)
      return
    }
    if (href) {
      router.push(href as any)
      onNavPress?.()
    }
  }, [href, externalHref, onPress, router, onNavPress])

  return (
    <Pressable
      onPress={handlePress}
      role={href || externalHref ? 'link' : 'button'}
      accessibilityLabel={label}
      className={cn(
        'flex-row items-center gap-2 rounded-md px-2 py-1',
        active
          ? 'bg-accent'
          : 'active:bg-accent/50',
        collapsed && 'justify-center px-2'
      )}
    >
      <Icon
        size={12}
        className={cn(
          active ? 'text-foreground' : 'text-muted-foreground'
        )}
      />
      {!collapsed && (
        <Text
          className={cn(
            'text-xs flex-1',
            active ? 'text-foreground' : 'text-muted-foreground'
          )}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
      {!collapsed && shortcut && Platform.OS === 'web' && (
        <View className="ml-auto rounded border border-border bg-muted py-0.5">
          <Text className="text-[10px] font-mono text-muted-foreground">{shortcut}</Text>
        </View>
      )}
    </Pressable>
  )
}

// ─── ChatTreeItem (a single chat nested under a project) ────

function chatLabel(session: any): string {
  const name = typeof session.name === 'string' ? session.name.trim() : ''
  if (name) return name
  if (session.inferredName) return session.inferredName
  const created = session.createdAt ? new Date(session.createdAt) : new Date()
  return `Chat · ${created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

function ChatTreeItem({
  session,
  active,
  isStreaming,
  isCompleted,
  onSelect,
  onTogglePin,
  onRename,
  onToggleArchive,
  onRequestDelete,
}: {
  session: any
  active?: boolean
  isStreaming?: boolean
  isCompleted?: boolean
  onSelect: (sessionId: string) => void
  onTogglePin: (sessionId: string, next: boolean) => void
  onRename: (sessionId: string, name: string) => void
  onToggleArchive: (sessionId: string, next: boolean) => void
  onRequestDelete: (sessionId: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  // Web-only right-click menu anchor (viewport coords).
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const startEdit = useCallback(() => {
    setEditValue(chatLabel(session))
    setEditing(true)
  }, [session])

  const saveEdit = useCallback(() => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== chatLabel(session)) onRename(session.id, trimmed)
    setEditing(false)
  }, [editValue, session, onRename])

  // Swallow the row's select press so tapping an action icon doesn't also
  // open the chat (RN-Web bubbles the nested Pressable's click to the row).
  const stop = (e: GestureResponderEvent) => e.stopPropagation?.()

  const handleContextMenu = useCallback((e: any) => {
    e?.preventDefault?.()
    const ne = e?.nativeEvent ?? e
    setMenu({ x: ne?.clientX ?? 0, y: ne?.clientY ?? 0 })
  }, [])

  const menuItems: SidebarMenuEntry[] = [
    {
      label: 'Rename',
      icon: <Pencil size={14} className="text-muted-foreground" />,
      onSelect: startEdit,
    },
    {
      label: session.isPinned ? 'Unpin' : 'Pin',
      icon: session.isPinned ? (
        <PinOff size={14} className="text-muted-foreground" />
      ) : (
        <Pin size={14} className="text-muted-foreground" />
      ),
      onSelect: () => onTogglePin(session.id, !session.isPinned),
    },
    {
      label: session.isArchived ? 'Unarchive' : 'Archive',
      icon: session.isArchived ? (
        <ArchiveRestore size={14} className="text-muted-foreground" />
      ) : (
        <Archive size={14} className="text-muted-foreground" />
      ),
      onSelect: () => onToggleArchive(session.id, !session.isArchived),
    },
    { separator: true },
    {
      label: 'Delete',
      danger: true,
      icon: <Trash2 size={14} className="text-destructive" />,
      onSelect: () => onRequestDelete(session.id),
    },
  ]

  if (editing) {
    return (
      <View className="flex-row items-center gap-1 rounded-md px-1 py-1">
        <TextInput
          value={editValue}
          onChangeText={setEditValue}
          onSubmitEditing={saveEdit}
          onBlur={saveEdit}
          autoFocus
          className="flex-1 h-6 px-1 text-xs rounded border border-border bg-background text-foreground"
        />
        <Pressable onPress={saveEdit} className="p-0.5" accessibilityLabel="Save name">
          <Check size={12} className="text-primary" />
        </Pressable>
        <Pressable onPress={() => setEditing(false)} className="p-0.5" accessibilityLabel="Cancel rename">
          <X size={12} className="text-muted-foreground" />
        </Pressable>
      </View>
    )
  }

  return (
    <>
    <Pressable
      onPress={() => onSelect(session.id)}
      role="link"
      accessibilityLabel={`Chat: ${chatLabel(session)}`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex-row items-center gap-1 rounded-md px-1 py-1.5',
        active ? 'bg-accent' : 'active:bg-accent/50',
      )}
      {...(Platform.OS === 'web' ? ({ onContextMenu: handleContextMenu } as any) : {})}
    >
      {isStreaming ? (
        <Loader2 size={11} className="text-primary animate-spin shrink-0" accessibilityLabel="Chat running" />
      ) : isCompleted ? (
        <View className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" accessibilityLabel="Chat has new activity" />
      ) : session.isPinned ? (
        <Pin size={10} className="text-muted-foreground shrink-0" />
      ) : null}
      <Text
        className={cn('text-xs flex-1', active ? 'text-foreground' : 'text-muted-foreground')}
        numberOfLines={1}
      >
        {chatLabel(session)}
      </Text>
      {/* Hover-reveal actions (web). Always mounted; visibility is purely
          CSS-driven via the row's `group` + `group-hover:flex` so moving the
          cursor between icons never tears down the hover target. */}
      <View className="hidden group-hover:flex flex-row items-center gap-0.5 shrink-0">
        <Pressable
          onPress={(e) => { stop(e); onTogglePin(session.id, !session.isPinned) }}
          className="p-0.5"
          accessibilityLabel={session.isPinned ? `Unpin ${chatLabel(session)}` : `Pin ${chatLabel(session)}`}
        >
          {session.isPinned ? (
            <PinOff size={11} className="text-muted-foreground" />
          ) : (
            <Pin size={11} className="text-muted-foreground" />
          )}
        </Pressable>
        <Pressable
          onPress={(e) => { stop(e); onToggleArchive(session.id, !session.isArchived) }}
          className="p-0.5"
          accessibilityLabel={session.isArchived ? `Unarchive ${chatLabel(session)}` : `Archive ${chatLabel(session)}`}
        >
          {session.isArchived ? (
            <ArchiveRestore size={11} className="text-muted-foreground" />
          ) : (
            <Archive size={11} className="text-muted-foreground" />
          )}
        </Pressable>
        <Pressable
          onPress={(e) => { stop(e); startEdit() }}
          className="p-0.5"
          accessibilityLabel={`Rename ${chatLabel(session)}`}
        >
          <Pencil size={11} className="text-muted-foreground" />
        </Pressable>
      </View>
    </Pressable>
      {menu && (
        <SidebarContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

// ─── ProjectTreeItem (a project + its nested chats) ─────────

// Cap the per-project chat list; pinned + the active chat always show, the
// rest collapse behind a "More" toggle.
const MAX_VISIBLE_CHATS = 5

// Cap the projects list; pinned + the open project always show, the rest
// collapse behind a "More" toggle.
const MAX_VISIBLE_PROJECTS = 5

const ProjectTreeItem = observer(function ProjectTreeItem({
  project,
  collapsed,
  onNavPress,
  isPinned,
  onTogglePin,
}: {
  project: any
  collapsed?: boolean
  onNavPress?: () => void
  isPinned?: boolean
  onTogglePin?: (projectId: string, next: boolean) => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useLocalSearchParams<{ chatSessionId?: string }>()
  const http = useDomainHttp()
  const actions = useDomainActions()
  const [expanded, setExpanded] = useState(false)
  // Per-project "show all chats" toggle (defaults to the capped view).
  const [showAllChats, setShowAllChats] = useState(false)
  // Chats are fetched directly into local state (rather than the shared
  // chat-session collection) because the collection's loaders prune items
  // from other contexts — expanding a second project would otherwise wipe
  // the first project's chats out of the cache.
  const [sessions, setSessions] = useState<any[]>([])
  const [loaded, setLoaded] = useState(false)
  const seededRef = useRef(false)
  // Collapsible "Archived" subsection (in-memory; defaults to collapsed).
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  // Live streaming / new-activity state mirrored from the open project
  // workspace (the only one mounted) via the activity event bus.
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set())
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())
  // Inline project rename state (mirrors ChatTreeItem's editor).
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  // Web-only right-click menu anchor (viewport coords) for the project row.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Delete confirmation, shared by this project and its chats.
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: 'project' | 'chat'; id: string; label: string } | null
  >(null)

  const isActive = pathname.includes(project.id)
  const routeChatId = Array.isArray(params.chatSessionId)
    ? params.chatSessionId[0]
    : params.chatSessionId
  // The project workspace selects new chats via local state (no URL change),
  // so the route param alone can't tell us which chat is active. An override,
  // fed by chat-session events, keeps the highlight in sync.
  const [activeOverride, setActiveOverride] = useState<string | undefined>(routeChatId)
  const activeChatId = activeOverride ?? routeChatId

  useEffect(() => {
    if (routeChatId) setActiveOverride(routeChatId)
  }, [routeChatId])

  const loadChats = useCallback(async () => {
    if (seededRef.current || !http) return
    seededRef.current = true
    try {
      const res = await http.get<{ ok: boolean; items?: any[] }>(
        `/api/chat-sessions?contextId=${encodeURIComponent(project.id)}&limit=50`,
      )
      const items = Array.isArray(res.data?.items) ? res.data!.items! : []
      const normalized = items
        .map((s: any) => ({
          id: s.id,
          name: typeof s.name === 'string' ? s.name : '',
          inferredName: s.inferredName ?? '',
          createdAt: s.createdAt ? new Date(s.createdAt).getTime() : 0,
          activity: new Date(s.lastActiveAt || s.updatedAt || s.createdAt || 0).getTime(),
          isPinned: !!s.isPinned,
          isArchived: !!s.isArchived,
        }))
        .sort((a, b) => b.activity - a.activity)
      setSessions(normalized)
    } catch (e) {
      console.error('[AppSidebar] Failed to load chats:', e)
      seededRef.current = false
    } finally {
      setLoaded(true)
    }
  }, [http, project.id])

  // Force a re-fetch even if this project's chats were already seeded.
  const refreshChats = useCallback(() => {
    seededRef.current = false
    void loadChats()
  }, [loadChats])

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev
      if (next) void loadChats()
      return next
    })
  }, [loadChats])

  // The project workspace creates / renames / deletes chats and switches the
  // active chat without touching this sidebar's local state or the URL. Listen
  // so the tree re-fetches (on create/rename/delete) and always re-highlights
  // the active chat immediately.
  useEffect(() => {
    return chatSessionEvents.subscribe(({ projectId, activeSessionId, refresh }) => {
      if (projectId !== project.id) return
      if (refresh) {
        setExpanded(true)
        refreshChats()
      }
      if (activeSessionId) setActiveOverride(activeSessionId)
    })
  }, [project.id, refreshChats])

  // Mirror the open workspace's live streaming / new-activity state so chat
  // rows can show a spinner / activity dot. Decoupled from the refresh events
  // above so a stream tick never triggers a chat-list re-fetch.
  useEffect(() => {
    return chatActivityEvents.subscribe(({ projectId, streamingSessionIds, completedSessionIds }) => {
      if (projectId !== project.id) return
      setStreamingIds(new Set(streamingSessionIds))
      setCompletedIds(new Set(completedSessionIds))
    })
  }, [project.id])

  // When this project is the one open in the content pane, reveal its chats
  // automatically so the active chat is visible without a manual expand.
  useEffect(() => {
    if (isActive && !collapsed) {
      setExpanded(true)
      void loadChats()
    }
  }, [isActive, collapsed, loadChats])

  const openProject = useCallback(() => {
    // Clicking a project name is an explicit "take me to this project's main
    // surface" intent: Canvas for canvas-capable projects, fullscreen Chat
    // for chat-only agents, the external preview for folder-linked projects.
    // We pass it as a `tab` param the project layout applies (with precedence
    // over the saved last-tab). `tabNonce` forces re-application when the
    // project is already open and the tab value is unchanged.
    const tab = defaultTabForProject(project)
    if (!isActive) {
      router.push({
        pathname: '/(app)/projects/[id]',
        params: { id: project.id, tab },
      } as any)
    } else {
      // Already on this project — re-pushing remounts the workspace and
      // flashes, so switch the tab in place via params instead.
      router.setParams({ tab, tabNonce: String(Date.now()) } as any)
    }
    onNavPress?.()
  }, [router, project, onNavPress, isActive])

  // Select a chat. If its project is already open, switch IN PLACE via the
  // event bus (no navigation / remount). Otherwise navigate to the project
  // with the chat deep-linked.
  const handleSelectChat = useCallback(
    (sessionId: string) => {
      if (sessionId === activeChatId) {
        onNavPress?.()
        return
      }
      if (isActive) {
        setActiveOverride(sessionId)
        chatSessionEvents.requestSelect({ projectId: project.id, sessionId })
      } else {
        router.push({
          pathname: '/(app)/projects/[id]',
          params: { id: project.id, chatSessionId: sessionId },
        } as any)
      }
      onNavPress?.()
    },
    [activeChatId, isActive, project.id, router, onNavPress],
  )

  // Create a new chat for this project and land on it. Session creation
  // (workspace-runtime vs project scope) is non-trivial and lives in the
  // project layout's `handleCreateNewSession`, so reuse it: when the project
  // is already open, ask it to mint one in place via the event bus; otherwise
  // navigate in with a one-shot `newChat` param the layout consumes on mount.
  const handleCreateChat = useCallback(() => {
    if (isActive) {
      setExpanded(true)
      chatSessionEvents.requestNewChat({ projectId: project.id })
    } else {
      router.push({
        pathname: '/(app)/projects/[id]',
        params: { id: project.id, newChat: '1', newChatNonce: String(Date.now()) },
      } as any)
    }
    onNavPress?.()
  }, [isActive, project.id, router, onNavPress])

  // Pin / rename / archive operate against the domain collection and update
  // local state optimistically (the sidebar fetches chats over HTTP, so it
  // isn't auto-synced to the collection). On failure we re-fetch to reconcile.
  const handleTogglePin = useCallback(
    async (sessionId: string, next: boolean) => {
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, isPinned: next } : s)))
      try {
        await actions.updateChatSession(sessionId, { isPinned: next })
      } catch (e) {
        console.error('[AppSidebar] Failed to toggle pin:', e)
        refreshChats()
      }
    },
    [actions, refreshChats],
  )

  const handleToggleArchive = useCallback(
    async (sessionId: string, next: boolean) => {
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, isArchived: next } : s)))
      try {
        await actions.updateChatSession(sessionId, { isArchived: next })
      } catch (e) {
        console.error('[AppSidebar] Failed to toggle archive:', e)
        refreshChats()
      }
    },
    [actions, refreshChats],
  )

  const handleRename = useCallback(
    async (sessionId: string, name: string) => {
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, name } : s)))
      try {
        await actions.updateChatSession(sessionId, { name })
      } catch (e) {
        console.error('[AppSidebar] Failed to rename chat:', e)
        refreshChats()
      }
    },
    [actions, refreshChats],
  )

  // Delete a chat: drop it locally first, reconcile on failure. The owning
  // project handles the confirm flow, so this runs only after confirmation.
  const handleDeleteChat = useCallback(
    async (sessionId: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      try {
        await actions.deleteChatSession(sessionId)
      } catch (e) {
        console.error('[AppSidebar] Failed to delete chat:', e)
        refreshChats()
      }
    },
    [actions, refreshChats],
  )

  // Inline project rename. The project row is a MobX observer over the project
  // collection, so updateProject's optimistic write re-renders the new name.
  const startEditProject = useCallback(() => {
    setEditValue(project.name || '')
    setEditing(true)
  }, [project.name])

  const saveEditProject = useCallback(async () => {
    const trimmed = editValue.trim()
    setEditing(false)
    if (!trimmed || trimmed === (project.name || '')) return
    try {
      await actions.updateProject(project.id, { name: trimmed })
    } catch (e) {
      console.error('[AppSidebar] Failed to rename project:', e)
    }
  }, [editValue, project.id, project.name, actions])

  const handleContextMenu = useCallback((e: any) => {
    e?.preventDefault?.()
    const ne = e?.nativeEvent ?? e
    setMenu({ x: ne?.clientX ?? 0, y: ne?.clientY ?? 0 })
  }, [])

  // Run the confirmed delete for either the project or one of its chats.
  const performDelete = useCallback(async () => {
    const target = confirmDelete
    setConfirmDelete(null)
    if (!target) return
    if (target.kind === 'chat') {
      await handleDeleteChat(target.id)
      return
    }
    try {
      await actions.deleteProject(target.id)
    } catch (e) {
      console.error('[AppSidebar] Failed to delete project:', e)
    }
  }, [confirmDelete, handleDeleteChat, actions])

  if (collapsed) {
    return ("")
  }

  const projectMenuItems: SidebarMenuEntry[] = [
    {
      label: 'New chat',
      icon: <Plus size={14} className="text-muted-foreground" />,
      onSelect: handleCreateChat,
    },
    {
      label: 'Rename',
      icon: <Pencil size={14} className="text-muted-foreground" />,
      onSelect: startEditProject,
    },
    {
      label: isPinned ? 'Unpin' : 'Pin',
      icon: isPinned ? (
        <PinOff size={14} className="text-muted-foreground" />
      ) : (
        <Pin size={14} className="text-muted-foreground" />
      ),
      onSelect: () => onTogglePin?.(project.id, !isPinned),
    },
    { separator: true },
    {
      label: 'Delete',
      danger: true,
      icon: <Trash2 size={14} className="text-destructive" />,
      onSelect: () =>
        setConfirmDelete({ kind: 'project', id: project.id, label: project.name || 'Untitled' }),
    },
  ]

  return (
    <View>
      {editing ? (
        <View className="flex-row items-center gap-1.5 rounded-md px-2 py-1.5">
          <Folder size={12} className="text-muted-foreground" />
          <TextInput
            value={editValue}
            onChangeText={setEditValue}
            onSubmitEditing={saveEditProject}
            onBlur={saveEditProject}
            autoFocus
            selectTextOnFocus
            className="flex-1 h-6 px-1 text-xs rounded border border-border bg-background text-foreground"
          />
          <Pressable onPress={saveEditProject} className="p-0.5" accessibilityLabel="Save name">
            <Check size={12} className="text-primary" />
          </Pressable>
          <Pressable onPress={() => setEditing(false)} className="p-0.5" accessibilityLabel="Cancel rename">
            <X size={12} className="text-muted-foreground" />
          </Pressable>
        </View>
      ) : (
        <View
          className={cn(
            'group flex-row items-center gap-1.5 rounded-md pr-1 py-1.5',
            isActive ? 'bg-accent' : 'active:bg-accent/50',
          )}
        >

          <Pressable
            onPress={openProject}
            role="link"
            accessibilityLabel={`Project: ${project.name || 'Untitled'}`}
            className="flex-1 flex-row items-center gap-2 px-2 active:opacity-70 min-w-0"
            {...(Platform.OS === 'web' ? ({ onContextMenu: handleContextMenu } as any) : {})}
          >
            <Folder size={12} className={isActive ? 'text-foreground' : 'text-muted-foreground'} />
            <Text
              className={cn('text-xs flex-1', isActive ? 'text-foreground' : 'text-foreground')}
              numberOfLines={1}
            >
              {project.name || 'Untitled'}
            </Text>
          </Pressable>
          {/* Persistent pin glyph when pinned (hidden while hovering so the
              hover actions can take its place). */}
          {isPinned && (
            <View className="group-hover:hidden pr-1 shrink-0">
              <Pin size={10} className="text-muted-foreground" />
            </View>
          )}
          {/* Hover-reveal actions (web). Siblings of the project Pressable, so
              tapping one never triggers the project-open press. */}
          <View className="hidden group-hover:flex flex-row items-center gap-0.5 shrink-0">
            <Pressable
              onPress={handleCreateChat}
              className="p-0.5"
              accessibilityLabel={`New chat in ${project.name || 'Untitled'}`}
            >
              <Plus size={12} className="text-muted-foreground" />
            </Pressable>
            <Pressable
              onPress={() => onTogglePin?.(project.id, !isPinned)}
              className="p-0.5"
              accessibilityLabel={isPinned ? `Unpin ${project.name || 'Untitled'}` : `Pin ${project.name || 'Untitled'}`}
            >
              {isPinned ? (
                <PinOff size={11} className="text-muted-foreground" />
              ) : (
                <Pin size={11} className="text-muted-foreground" />
              )}
            </Pressable>
          </View>
        </View>
      )}
      {expanded && (() => {
        const activeSessions = sessions
          .filter((s: any) => !s.isArchived)
          // Pinned float to the top; the sort is stable so the activity order
          // (sessions is already sorted by activity desc) holds within groups.
          .sort((a: any, b: any) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0))
        const archivedSessions = sessions.filter((s: any) => s.isArchived)
        // Cap the visible chats. Pinned + the active chat always show even when
        // they sort past the cap; everything else collapses behind "more".
        let visibleSessions = activeSessions
        if (!showAllChats && activeSessions.length > MAX_VISIBLE_CHATS) {
          const head = activeSessions.slice(0, MAX_VISIBLE_CHATS)
          const headIds = new Set(head.map((s: any) => s.id))
          const forced = activeSessions.filter(
            (s: any) =>
              !headIds.has(s.id) &&
              (s.isPinned || (isActive && s.id === activeChatId)),
          )
          visibleSessions = [...head, ...forced]
        }
        const hiddenChatCount = activeSessions.length - visibleSessions.length
        const renderChat = (s: any) => (
          <ChatTreeItem
            key={s.id}
            session={s}
            active={isActive && s.id === activeChatId}
            isStreaming={streamingIds.has(s.id)}
            isCompleted={completedIds.has(s.id)}
            onSelect={handleSelectChat}
            onTogglePin={handleTogglePin}
            onRename={handleRename}
            onToggleArchive={handleToggleArchive}
            onRequestDelete={(id) =>
              setConfirmDelete({ kind: 'chat', id, label: chatLabel(s) })
            }
          />
        )
        return (
          <View className="ml-6 mt-0.5">
            {sessions.length === 0 ? (
              <View className="px-2 py-1.5">
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                  {loaded ? 'No chats yet' : 'Loading…'}
                </Text>
              </View>
            ) : (
              <>
                {visibleSessions.map(renderChat)}
                {activeSessions.length > MAX_VISIBLE_CHATS && (hiddenChatCount > 0 || showAllChats) && (
                  <Pressable
                    onPress={() => setShowAllChats((v) => !v)}
                    accessibilityLabel={showAllChats ? 'Show fewer chats' : 'Show all chats'}
                    className="flex-row items-center gap-1 px-1 pt-1 pb-0.5 active:opacity-70"
                  >
                    {showAllChats ? (
                      <ChevronDown size={10} className="text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight size={10} className="text-muted-foreground shrink-0" />
                    )}
                    <Text className="text-[11px] text-muted-foreground flex-1">
                      {showAllChats ? 'Show less' : `${hiddenChatCount} more`}
                    </Text>
                  </Pressable>
                )}
                {archivedSessions.length > 0 && (
                  <>
                    <Pressable
                      onPress={() => setArchivedExpanded((v) => !v)}
                      accessibilityLabel={`${archivedExpanded ? 'Collapse' : 'Expand'} archived chats`}
                      className="flex-row items-center gap-1 px-1 pt-2 pb-0.5 active:opacity-70"
                    >
                      {archivedExpanded ? (
                        <ChevronDown size={10} className="text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight size={10} className="text-muted-foreground shrink-0" />
                      )}
                      <Text className="text-[10px] uppercase tracking-wide text-muted-foreground flex-1">
                        Archived
                      </Text>
                      <Text className="text-[10px] text-muted-foreground shrink-0">
                        {archivedSessions.length}
                      </Text>
                    </Pressable>
                    {archivedExpanded && archivedSessions.map(renderChat)}
                  </>
                )}
              </>
            )}
          </View>
        )
      })()}
      {menu && (
        <SidebarContextMenu
          x={menu.x}
          y={menu.y}
          items={projectMenuItems}
          onClose={() => setMenu(null)}
        />
      )}
      <Modal
        visible={!!confirmDelete}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmDelete(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setConfirmDelete(null)}
        >
          <Pressable
            className="bg-card rounded-xl p-6 w-80 border border-border"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="flex-row items-center justify-between mb-1">
              <Text className="text-base font-semibold text-foreground">
                {confirmDelete?.kind === 'project' ? 'Delete project' : 'Delete chat'}
              </Text>
              <Pressable onPress={() => setConfirmDelete(null)} className="p-1" accessibilityLabel="Close">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
            <Text className="text-sm text-muted-foreground mb-4">
              {confirmDelete?.kind === 'project'
                ? `Permanently delete "${confirmDelete?.label}" and all of its chats? This can't be undone.`
                : `Permanently delete "${confirmDelete?.label}"? This can't be undone.`}
            </Text>
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setConfirmDelete(null)}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={performDelete}
                className="px-4 py-2 rounded-md bg-destructive active:bg-destructive/80"
              >
                <Text className="text-sm text-destructive-foreground">Delete</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
})

// ─── UserMenuContent (user section of the account menu) ────

interface UserMenuProps {
  user: { name?: string | null; email?: string | null; image?: string | null } | null
  onSignOut: () => void
  onNavigate: (href: string) => void
  isSuperAdmin?: boolean
  isWide?: boolean
  bottomInset?: number
  collapsed?: boolean
}

function UserMenuContent({
  user,
  onSignOut,
  onNavigate,
  isSuperAdmin,
  onClose,
}: UserMenuProps & { onClose: () => void }) {
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const { theme, setTheme } = useTheme()
  const { localMode, shogoKeyConnected } = usePlatformConfig()
  // The Creator hub (marketplace publishing + referrals) is cloud-backed, so
  // it only appears in local/desktop mode once signed in to Shogo Cloud.
  const showCreator = !localMode || !!shogoKeyConnected

  return (
    <>
      {/* Menu items */}
      <View role="menu" className="py-1">
        <Pressable
          onPress={() => { onNavigate('/(app)/profile'); onClose() }}
          role="menuitem"
          accessibilityLabel="Profile"
          className="flex-row items-center gap-3 px-4 py-3 active:bg-muted"
        >
          <User size={18} className="text-muted-foreground" />
          <Text className="text-sm text-foreground">Profile</Text>
        </Pressable>

        {showCreator && (
          <Pressable
            onPress={() => { onNavigate('/(app)/creator'); onClose() }}
            role="menuitem"
            accessibilityLabel="Creator"
            className="flex-row items-center gap-3 px-4 py-3 active:bg-muted"
          >
            <Store size={18} className="text-muted-foreground" />
            <Text className="text-sm text-foreground">Creator</Text>
          </Pressable>
        )}

        <Pressable
          onPress={() => setAppearanceOpen(!appearanceOpen)}
          role="menuitem"
          accessibilityLabel="Appearance"
          accessibilityState={{ expanded: appearanceOpen }}
          className="flex-row items-center gap-3 px-4 py-3 active:bg-muted"
        >
          <Monitor size={18} className="text-muted-foreground" />
          <Text className="text-sm text-foreground flex-1">Appearance</Text>
          {appearanceOpen ? (
            <ChevronDown size={14} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={14} className="text-muted-foreground" />
          )}
        </Pressable>

        {appearanceOpen && (
          <View role="radiogroup" accessibilityLabel="Theme options" className="pl-11 pr-4 py-1">
            {([
              { value: 'light' as const, label: 'Light', Icon: Sun },
              { value: 'dark' as const, label: 'Dark', Icon: Moon },
              { value: 'system' as const, label: 'System', Icon: Monitor },
            ] as const).map(({ value, label, Icon }) => (
              <Pressable
                key={value}
                onPress={() => setTheme(value)}
                role="radio"
                accessibilityLabel={label}
                accessibilityState={{ checked: theme === value }}
                className="flex-row items-center gap-3 py-2.5 active:bg-muted rounded-md px-2"
              >
                <Icon size={16} className={theme === value ? 'text-primary' : 'text-muted-foreground'} />
                <Text className={cn('text-sm flex-1', theme === value ? 'text-primary' : 'text-foreground')}>
                  {label}
                </Text>
                {theme === value && <Check size={16} className="text-primary" />}
              </Pressable>
            ))}
          </View>
        )}

        {isSuperAdmin && (
          <Pressable
            onPress={() => { onNavigate('/(admin)'); onClose() }}
            role="menuitem"
            accessibilityLabel="Admin panel"
            className="flex-row items-center gap-3 px-4 py-3 active:bg-muted"
          >
            <Shield size={18} className="text-primary" />
            <Text className="text-sm text-foreground">Admin</Text>
          </Pressable>
        )}
      </View>

      {!localMode && (
        <>
          <View className="h-px bg-border" />

          <View role="menu" className="py-1">
            <Pressable
              onPress={() => { onSignOut(); onClose() }}
              role="menuitem"
              accessibilityLabel="Sign out"
              className="flex-row items-center gap-3 px-4 py-3 active:bg-muted"
            >
              <LogOut size={18} className="text-muted-foreground" />
              <Text className="text-sm text-foreground">Sign Out</Text>
            </Pressable>
          </View>
        </>
      )}
    </>
  )
}

// ─── WorkspaceMenuSection (workspace block inside the account menu) ─

interface WorkspaceMenuSectionProps {
  workspaces: any[]
  currentWorkspace: any
  billingData: any
  workspacePlan: { planId: string; status: string | null } | null
  allPlans: Record<string, { planId: string; status: string | null }>
  showBilling: boolean
  onNavigate: (href: string) => void
  onSwitchWorkspace: (workspaceId: string) => void
  onCreateWorkspace: () => void
  localMode?: boolean
  onClose: () => void
}

function WorkspaceMenuSection({
  workspaces,
  currentWorkspace,
  billingData,
  workspacePlan,
  allPlans,
  showBilling,
  onNavigate,
  onSwitchWorkspace,
  onCreateWorkspace,
  localMode,
  onClose,
}: WorkspaceMenuSectionProps) {
  const posthog = usePostHogSafe()

  const wsInitial = currentWorkspace?.name?.[0]?.toUpperCase() ?? 'W'
  const resolvedPlanId = (billingData.hasActiveSubscription && billingData.subscription?.planId)
    || workspacePlan?.planId
    || 'free'
  const planType = getPlanDisplayName(resolvedPlanId !== 'free' ? resolvedPlanId : undefined)

  return (
    <>
      {currentWorkspace && (
        <View className="px-4 py-3">
          <View className="flex-row items-start gap-3">
            <View className="h-10 w-10 rounded-lg bg-primary/10 items-center justify-center">
              <Text className="text-sm font-medium text-primary">{wsInitial}</Text>
            </View>
            <View className="flex-1 min-w-0">
              <Text className="font-medium text-foreground" numberOfLines={1}>
                {currentWorkspace.name}
              </Text>
              {showBilling && (
                <Text className="text-xs text-muted-foreground">
                  {planType} Plan {'\u00B7'} 1 member
                </Text>
              )}
            </View>
          </View>
        </View>
      )}

      {currentWorkspace && (
        <View className="px-3 pb-2 flex-row gap-2">
          <Pressable
            onPress={() => { onNavigate('/(app)/settings'); onClose() }}
            className="flex-1 flex-row items-center justify-center gap-1.5 h-8 rounded-md border border-border active:bg-muted"
          >
            <Settings size={14} className="text-muted-foreground" />
            <Text className="text-xs text-foreground">Settings</Text>
          </Pressable>
          {!localMode && (
            <Pressable
              onPress={() => { onNavigate('/(app)/settings?tab=people'); onClose() }}
              className="flex-1 flex-row items-center justify-center gap-1.5 h-8 rounded-md border border-border active:bg-muted"
            >
              <Users size={14} className="text-muted-foreground" />
              <Text className="text-xs text-foreground">Invite</Text>
            </Pressable>
          )}
        </View>
      )}

      {showBilling && currentWorkspace && (
        <>
          <View className="h-px bg-border" />
          <View className="px-4 py-3 gap-2">
            <Text className="text-sm text-muted-foreground">Usage</Text>
            <CompactUsageWindows
              windows={billingData.usageWindows}
              overage={billingData.effectiveBalance
                ? { enabled: billingData.effectiveBalance.overageEnabled, accumulatedUsd: billingData.effectiveBalance.overageAccumulatedUsd }
                : undefined}
            />
          </View>
        </>
      )}

      {showBilling && currentWorkspace && planType === 'Free' && (
        <View className="px-3 py-2">
          <Pressable
            onPress={() => { trackEvent(posthog, EVENTS.UPGRADE_CLICKED); onNavigate('/(app)/billing'); onClose() }}
            className="flex-row items-center justify-center gap-2 h-9 rounded-md"
            style={Platform.OS === 'web'
              ? { backgroundImage: 'linear-gradient(to right, #3b82f6, #9333ea)' } as any
              : { backgroundColor: '#7c3aed' }}
          >
            <Zap size={16} className="text-white" />
            <Text className="text-sm font-medium text-white">Upgrade to Pro</Text>
          </Pressable>
        </View>
      )}

      <View className="h-px bg-border" />

      <View className="py-1">
        <Text className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          All workspaces
        </Text>
        {workspaces.map((ws: any) => {
          const isCurrent = ws.id === currentWorkspace?.id
          return (
            <Pressable
              key={ws.id}
              onPress={() => {
                if (!isCurrent) {
                  onSwitchWorkspace(ws.id)
                }
                onClose()
              }}
              className="flex-row items-center gap-2 px-4 py-2 active:bg-muted"
            >
              <View className="h-6 w-6 rounded bg-primary/10 items-center justify-center">
                <Text className="text-[10px] font-medium text-primary">
                  {ws.name?.[0]?.toUpperCase() ?? 'W'}
                </Text>
              </View>
              <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                {ws.name}
              </Text>
              {showBilling && (() => {
                const wsPlanId = (allPlans[ws.id]?.planId
                  ?? (ws.id === currentWorkspace?.id && billingData.subscription?.planId))
                  || 'free'
                const isPaid = wsPlanId !== 'free'
                const label = isPaid
                  ? wsPlanId.charAt(0).toUpperCase() + wsPlanId.slice(1)
                  : 'Free'
                return (
                  <View className={cn('rounded px-1.5 py-0.5', isPaid ? 'bg-primary/10' : 'bg-muted')}>
                    <Text className={cn('text-[10px]', isPaid ? 'text-primary font-medium' : 'text-muted-foreground')}>{label}</Text>
                  </View>
                )
              })()}
              {isCurrent && (
                <Check size={16} className="text-primary" />
              )}
            </Pressable>
          )
        })}

        {!localMode && (
          <Pressable
            onPress={() => { onClose(); onCreateWorkspace() }}
            className="flex-row items-center gap-2 px-4 py-2 rounded-md active:bg-muted"
          >
            <Plus size={16} className="text-muted-foreground" />
            <Text className="text-sm text-foreground">Create new workspace</Text>
          </Pressable>
        )}
      </View>
    </>
  )
}

// ─── AccountNavLinks (resources/links moved into the account menu) ─

function AccountNavLinks({
  localMode,
  onNavigate,
  onClose,
}: {
  localMode?: boolean
  onNavigate: (href: string) => void
  onClose: () => void
}) {
  const items: Array<{ icon: React.ElementType; label: string; href: string }> = [
    // { icon: Star, label: 'Starred', href: '/(app)/starred' },
    // ...(!localMode ? [{ icon: Users, label: 'Shared with me', href: '/(app)/shared' }] : []),
    ...(!localMode ? [{ icon: Key, label: 'API Keys', href: '/(app)/api-keys' }] : []),
  ]

  return (
    <View role="menu" className="py-1">
      {items.map(({ icon: Icon, label, href }) => (
        <Pressable
          key={label}
          onPress={() => { onNavigate(href); onClose() }}
          role="menuitem"
          accessibilityLabel={label}
          className="flex-row items-center gap-3 px-4 py-3 active:bg-muted"
        >
          <Icon size={18} className="text-muted-foreground" />
          <Text className="text-sm text-foreground">{label}</Text>
        </Pressable>
      ))}
      <Pressable
        onPress={() => { Linking.openURL('https://docs.shogo.ai/'); onClose() }}
        role="menuitem"
        accessibilityLabel="Docs"
        className="flex-row items-center gap-3 px-4 py-3 active:bg-muted"
      >
        <ExternalLink size={18} className="text-muted-foreground" />
        <Text className="text-sm text-foreground">Docs</Text>
      </Pressable>
      <Pressable
        onPress={() => { Linking.openURL('https://docs.shogo.ai/changelog'); onClose() }}
        role="menuitem"
        accessibilityLabel="What's New"
        className="flex-row items-center gap-3 px-4 py-3 active:bg-muted"
      >
        <Sparkles size={18} className="text-muted-foreground" />
        <Text className="text-sm text-foreground">What's New</Text>
      </Pressable>
    </View>
  )
}

// ─── AccountMenu (consolidated workspace + user button) ─────

interface AccountMenuProps extends UserMenuProps {
  workspaces: any[]
  currentWorkspace: any
  billingData: any
  workspacePlan: { planId: string; status: string | null } | null
  allPlans: Record<string, { planId: string; status: string | null }>
  showBilling: boolean
  onSwitchWorkspace: (workspaceId: string) => void
  onCreateWorkspace: () => void
  localMode?: boolean
}

function AccountMenu({
  user,
  onSignOut,
  onNavigate,
  isSuperAdmin,
  isWide = true,
  bottomInset = 0,
  collapsed,
  workspaces,
  currentWorkspace,
  billingData,
  workspacePlan,
  allPlans,
  showBilling,
  onSwitchWorkspace,
  onCreateWorkspace,
  localMode,
}: AccountMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const close = useCallback(() => setIsOpen(false), [])

  const triggerInner = (
    <>
      <View className="h-7 w-7 rounded bg-primary/20 items-center justify-center">
        <Text className="text-[11px] font-bold text-primary">
          {currentWorkspace?.name?.[0]?.toUpperCase() || 'W'}
        </Text>
      </View>
      {!collapsed && (
        <View className="flex-1 min-w-0">
          <Text className="text-sm text-foreground" numberOfLines={1} ellipsizeMode="tail">
            {currentWorkspace?.name || 'Workspace'}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1} ellipsizeMode="tail">
            {user?.name || 'User'}
          </Text>
        </View>
      )}
      {!collapsed && (
        <Avatar fallback={getInitials(user?.name)} src={user?.image} size="sm" />
      )}
    </>
  )

  const menuSections = (
    <>
      <WorkspaceMenuSection
        workspaces={workspaces}
        currentWorkspace={currentWorkspace}
        billingData={billingData}
        workspacePlan={workspacePlan}
        allPlans={allPlans}
        showBilling={showBilling}
        onNavigate={onNavigate}
        onSwitchWorkspace={onSwitchWorkspace}
        onCreateWorkspace={onCreateWorkspace}
        localMode={localMode}
        onClose={close}
      />
      <View className="h-px bg-border" />
      <AccountNavLinks
        localMode={localMode}
        onNavigate={onNavigate}
        onClose={close}
      />
      <View className="h-px bg-border" />
      <UserMenuContent
        user={user}
        onSignOut={onSignOut}
        onNavigate={onNavigate}
        isSuperAdmin={isSuperAdmin}
        onClose={close}
      />
    </>
  )

  if (isWide) {
    return (
      <Popover
        placement="top"
        size="sm"
        className="flex-1 min-w-0 w-auto h-auto items-stretch"
        isOpen={isOpen}
        onOpen={() => setIsOpen(true)}
        onClose={close}
        trigger={(triggerProps) => (
          <Pressable
            {...triggerProps}
            role="button"
            accessibilityLabel={`${currentWorkspace?.name || 'Workspace'}, ${user?.name || 'User'} — open account menu`}
            accessibilityHint="Opens menu to switch workspace, navigate, and manage your account"
            accessibilityState={{ expanded: isOpen }}
            className={cn(
              'flex-row items-center gap-2 active:opacity-80 flex-1 min-w-0',
              collapsed && 'justify-center',
            )}
          >
            {triggerInner}
          </Pressable>
        )}
      >
        <PopoverBackdrop />
        <PopoverContent className="w-[300px] max-w-[340px] p-0">
          <PopoverBody>
            <ScrollView
              className="max-h-[520px]"
              showsVerticalScrollIndicator={false}
              bounces={false}
              overScrollMode="never"
            >
              {menuSections}
            </ScrollView>
          </PopoverBody>
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <>
      <Pressable
        onPress={() => setIsOpen(true)}
        role="button"
        accessibilityLabel={`${currentWorkspace?.name || 'Workspace'}, ${user?.name || 'User'} — open account menu`}
        accessibilityHint="Opens menu to switch workspace, navigate, and manage your account"
        accessibilityState={{ expanded: isOpen }}
        className={cn(
          'flex-row items-center gap-2 active:opacity-80 flex-1 min-w-0',
          collapsed && 'justify-center',
        )}
      >
        {triggerInner}
      </Pressable>
      <Modal
        visible={isOpen}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={close}
      >
        <Pressable className="flex-1 bg-black/50 justify-end" onPress={close}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-card border-t border-border rounded-t-2xl shadow-2xl"
            style={{ paddingBottom: bottomInset }}
          >
            <View className="items-center pt-2 pb-1">
              <View className="w-10 h-1 rounded-full bg-muted-foreground/30" />
            </View>
            <ScrollView className="max-h-[480px]" showsVerticalScrollIndicator={false}>
              {menuSections}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

// ─── CreateWorkspaceModal (free — first workspace only) ────

function CreateWorkspaceModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give your workspace a name to continue.')
      return
    }
    onSubmit(trimmed)
    setName('')
    setError(null)
    onClose()
  }, [name, onSubmit, onClose])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50 items-center justify-center" onPress={onClose}>
        <Pressable
          className="bg-card rounded-xl p-6 w-80 border border-border"
          onPress={(e) => e.stopPropagation()}
        >
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-base font-semibold text-foreground">Create new workspace</Text>
            <Pressable onPress={onClose} className="p-1">
              <X size={20} className="text-muted-foreground" />
            </Pressable>
          </View>
          <Text className="text-sm text-muted-foreground mb-4">
            Create a new workspace for your team or projects
          </Text>
          <Text className="text-sm font-medium text-foreground mb-1.5">
            Workspace name
          </Text>
          <TextInput
            value={name}
            onChangeText={(t) => { setName(t); if (error) setError(null) }}
            placeholder="e.g. My Team, Acme Corp"
            placeholderTextColor="#9ca3af"
            className="border border-border rounded-md px-3 py-2 text-sm text-foreground bg-background"
            autoFocus={Platform.OS === 'web'}
            onSubmitEditing={handleSubmit}
          />
          <Text className="text-xs text-muted-foreground mt-1.5 mb-3">
            You can rename it later in settings.
          </Text>
          {error && (
            <Text className="text-xs text-destructive mb-3">{error}</Text>
          )}
          <View className="flex-row gap-2 justify-end">
            <Pressable
              onPress={onClose}
              className="px-4 py-2 rounded-md border border-border active:bg-muted"
            >
              <Text className="text-sm text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSubmit}
              className="px-4 py-2 rounded-md bg-primary active:bg-primary/80"
            >
              <Text className="text-sm text-primary-foreground">
                Create workspace
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

// ─── Main AppSidebar ───────────────────────────────────────

interface AppSidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

export const AppSidebar = observer(function AppSidebar({ isOpen, onClose }: AppSidebarProps) {
  const { width } = useWindowDimensions()
  const pathname = usePathname()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const isWide = width >= 768
  const { features, localMode } = usePlatformConfig()

  const { user, signOut } = useAuth()
  const posthog = usePostHogSafe()
  const projects = useProjectCollection()
  const workspaces = useWorkspaceCollection()
  const actions = useDomainActions()
  const http = useDomainHttp()

  const [pendingInvites, setPendingInvites] = useState<any[]>([])
  const [processingInvite, setProcessingInvite] = useState<{ id: string; action: 'accept' | 'decline' } | null>(null)
  const [inboxOpen, setInboxOpen] = useState(false)

  // True for full super admins AND partial admins (users granted >=1 scope),
  // so both see the admin-portal entry. The portal itself filters surfaces.
  const [hasAdminAccess, setHasAdminAccess] = useState(false)

  useEffect(() => {
    if (!user?.id || !http) return
    let cancelled = false
    api.getMe(http)
      .then((data) => {
        if (cancelled || !data?.ok) return
        const role = data.data?.role
        const scopes = Array.isArray(data.data?.adminScopes) ? data.data!.adminScopes! : []
        if (role === 'super_admin' || scopes.length > 0) {
          setHasAdminAccess(true)
        }
      })
      .catch((e) => console.error('[AppSidebar] Failed to fetch user role:', e))
    return () => { cancelled = true }
  }, [user?.id, http])

  useEffect(() => {
    // Chain projects after workspaces so that, on a fresh first load where
    // no active workspace has been persisted yet, we can still scope to
    // the first workspace the user belongs to.
    workspaces
      .loadAll()
      .then(() => {
        const wsId = getActiveWorkspaceId() ?? (workspaces.all?.[0] as any)?.id
        const filter = workspaceProjectFilter(wsId)
        if (filter) {
          projects.loadAll(filter).catch((e) => console.error('[AppSidebar] Failed to load projects:', e))
        }
      })
      .catch((e) => console.error('[AppSidebar] Failed to load workspaces:', e))
  }, [])

  const loadInvites = useCallback(() => {
    if (!http || !user?.email) return
    api.getReceivedInvitations(http, user.email)
      .then(setPendingInvites)
      .catch((e) => console.error('[AppSidebar] Failed to load invitations:', e))
  }, [http, user?.email])

  useEffect(() => { loadInvites() }, [loadInvites])

  useEffect(() => invitationEvents.subscribe(loadInvites), [loadInvites])

  // Detect return from Stripe checkout: verify payment, provision subscription, reload
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const checkout = params.get('checkout')
    const wsId = params.get('workspace')
    const sessionId = params.get('session_id')
    if ((checkout === 'workspace_created' || checkout === 'success') && wsId && sessionId) {
      const provision = async () => {
        try {
          const result = await api.verifyCheckout(http, sessionId)
          trackPurchase({ planId: result.planId, workspaceId: wsId, sessionId })
        } catch { /* webhook will handle it */ }
        window.location.href = `/?workspace=${wsId}`
      }
      provision()
    } else if (params.get('workspace') && !params.get('checkout')) {
      const targetWs = params.get('workspace')!
      workspaces.loadAll().then(() => {
        setSelectedWorkspaceId(targetWs)
        setActiveWorkspaceId(targetWs)
        projects.loadAll({ workspaceId: targetWs }).catch((e) => console.error('[AppSidebar] Failed to load projects for workspace:', e))
      })
      window.history.replaceState({}, '', '/')
    }
  }, [])

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    () => getActiveWorkspaceId()
  )

  let currentWorkspace: any
  try {
    if (selectedWorkspaceId) {
      currentWorkspace = workspaces?.all?.find((w: any) => w.id === selectedWorkspaceId)
    } else {
      currentWorkspace = workspaces?.all?.[0]
    }
  } catch {
    currentWorkspace = undefined
  }

  const activeWorkspaceId = currentWorkspace?.id ?? selectedWorkspaceId

  const billingData = useBillingData(features.billing ? currentWorkspace?.id : undefined)

  const [allPlans, setAllPlans] = useState<Record<string, { planId: string; status: string | null }>>({})

  // Device-local projects-list prefs (pins + filter) seeded from storage.
  const [pinnedProjectIds, setPinnedProjectIdsState] = useState<Set<string>>(
    () => new Set(getPinnedProjectIds()),
  )
  const [projectFilter, setProjectFilterState] = useState(() => getProjectFilter())
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)

  const handleToggleProjectPin = useCallback((projectId: string, next: boolean) => {
    setPinnedProjectIdsState((prev) => {
      const updated = new Set(prev)
      if (next) updated.add(projectId)
      else updated.delete(projectId)
      setPinnedProjectIds(Array.from(updated))
      return updated
    })
  }, [])

  const updateProjectFilter = useCallback(
    (patch: Partial<{ sort: ProjectSort; scope: ProjectScope }>) => {
      setProjectFilterState((prev) => {
        const next = { ...prev, ...patch }
        setProjectFilter(next)
        return next
      })
    },
    [],
  )

  let workspaceProjects: any[]
  try {
    const all = projects?.all ?? []
    const workspaceScoped = activeWorkspaceId
      ? all.filter((p: any) => p.workspaceId === activeWorkspaceId)
      : all
    const scopeFiltered =
      projectFilter.scope === 'mine' && user?.id
        ? workspaceScoped.filter((p: any) => p.createdBy === user.id)
        : workspaceScoped
    const sorted = [...scopeFiltered].sort((a: any, b: any) => {
      if (projectFilter.sort === 'name') {
        return String(a.name || '').localeCompare(String(b.name || ''))
      }
      const aTime = a.lastMessageAt || a.updatedAt || 0
      const bTime = b.lastMessageAt || b.updatedAt || 0
      return bTime - aTime
    })
    // Float pinned projects to the top. Array.sort is stable, so the chosen
    // sort order is preserved within the pinned / unpinned groups.
    workspaceProjects = sorted.sort((a: any, b: any) => {
      const ap = pinnedProjectIds.has(a.id) ? 1 : 0
      const bp = pinnedProjectIds.has(b.id) ? 1 : 0
      return bp - ap
    })
  } catch {
    workspaceProjects = []
  }

  // Cap the list to MAX_VISIBLE_PROJECTS. Pinned + the currently open project
  // always show even when they sort past the cap; everything else collapses
  // behind the "More" toggle.
  const visibleProjects = (() => {
    if (showAllProjects || workspaceProjects.length <= MAX_VISIBLE_PROJECTS) {
      return workspaceProjects
    }
    const head = workspaceProjects.slice(0, MAX_VISIBLE_PROJECTS)
    const headIds = new Set(head.map((p: any) => p.id))
    const forced = workspaceProjects.filter(
      (p: any) =>
        !headIds.has(p.id) && (pinnedProjectIds.has(p.id) || pathname.includes(p.id)),
    )
    return [...head, ...forced]
  })()
  const hiddenProjectCount = workspaceProjects.length - visibleProjects.length

  const [collapsed, setCollapsed] = useState(false)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const { open: commandPaletteOpen, setOpen: setCommandPaletteOpen } = useCommandPalette()
  const { instance: activeRemoteInstance } = useActiveInstance()

  let allWorkspaces: any[]
  try { allWorkspaces = workspaces?.all?.slice() ?? [] } catch { allWorkspaces = [] }

  useEffect(() => {
    if (!features.billing || !allWorkspaces.length) return
    let cancelled = false
    const ids = allWorkspaces.map((w: any) => w.id)
    api.getWorkspacePlans(http, ids)
      .then((plans) => { if (!cancelled) setAllPlans(plans) })
      .catch((e) => console.error('[AppSidebar] Failed to load workspace plans:', e))
    return () => { cancelled = true }
  }, [features.billing, allWorkspaces.length, http, billingData.subscription?.planId])

  const workspacePlan = currentWorkspace?.id ? (allPlans[currentWorkspace.id] ?? null) : null
  const isPaidPlan = billingData.hasActiveSubscription || (workspacePlan?.planId !== 'free' && workspacePlan?.status === 'active')

  const toggleCollapse = useCallback(() => setCollapsed((c) => !c), [])

  const handleSwitchWorkspace = useCallback(
    (workspaceId: string) => {
      trackEvent(posthog, EVENTS.WORKSPACE_SWITCHED)
      setSelectedWorkspaceId(workspaceId)
      setActiveWorkspaceId(workspaceId)
      projects.clear()
      projects
        .loadAll({ workspaceId })
        .catch((e) =>
          console.error('[AppSidebar] Failed to load projects after workspace switch:', e),
        )
    },
    [projects, posthog]
  )

  const handleCreateWorkspace = useCallback(
    () => {
      if (allWorkspaces.length >= 1) {
        router.push('/(app)/new-workspace' as any)
        if (!isWide) onClose?.()
      } else {
        setCreateWorkspaceOpen(true)
        if (!isWide) onClose?.()
      }
    },
    [allWorkspaces.length, router, isWide, onClose]
  )

  const handleCreateWorkspaceSubmit = useCallback(
    async (name: string) => {
      if (!user?.id) return
      try {
        const newWorkspace = await actions.createWorkspace(name, undefined, user.id)
        if (newWorkspace?.id) {
          trackEvent(posthog, EVENTS.WORKSPACE_CREATED)
          setSelectedWorkspaceId(newWorkspace.id)
          setActiveWorkspaceId(newWorkspace.id)
          await workspaces.loadAll()
          projects.clear()
          await projects.loadAll({ workspaceId: newWorkspace.id })
        }
      } catch (e) {
        console.warn('Failed to create workspace:', e)
      }
    },
    [actions, user?.id, workspaces, projects, posthog]
  )

  const handleSignOut = useCallback(async () => {
    trackEvent(posthog, EVENTS.SIGN_OUT)
    try {
      await signOut()
    } catch {}
  }, [signOut, posthog])

  const onNavPress = useCallback(() => {
    if (!isWide) onClose?.()
  }, [isWide, onClose])

  const handleSearchPress = useCallback(() => {
    setCommandPaletteOpen(true)
  }, [setCommandPaletteOpen])

  const isHomePage = pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'
  const isMeetingsPage = pathname.startsWith('/meetings') || pathname.startsWith('/(app)/meetings')
  const isMarketplacePage = pathname.startsWith('/marketplace') || pathname.startsWith('/(app)/marketplace')

  const sidebarContent = (
    <View role="navigation" accessibilityLabel="App sidebar" className={cn('flex-1 bg-card border-r border-border', collapsed ? 'w-16' : 'w-64')}>
      {/* ── Logo Row ── */}
      <View
        className={cn(
          'h-10 border-b border-border flex-row items-center',
          collapsed ? 'justify-center px-2' : 'justify-between px-3'
        )}
      >
        {!collapsed && (
          <>
            <Pressable
              onPress={() => { router.push('/(app)' as any); onNavPress() }}
              role="link"
              accessibilityLabel="Shogo Home"
              className="flex-row items-center"
            >
              <ShogoWordmark className="text-xl" />
            </Pressable>
            <Pressable onPress={toggleCollapse} className="h-8 w-8 items-center justify-center rounded-md active:bg-muted">
              <PanelLeftClose size={12} className="text-muted-foreground" />
            </Pressable>
          </>
        )}
        {collapsed && (
          <Pressable
            onPress={toggleCollapse}
            accessibilityLabel="Expand sidebar"
          >
            <ShogoWordmark compact className="text-2xl" />
          </Pressable>
        )}
      </View>

      {/* ── Remote instance indicator ── */}
      {activeRemoteInstance && !collapsed && (
        <View className="px-3 py-1.5 bg-primary/10 border-b border-primary/20">
          <View className="flex-row items-center gap-2">
            <Laptop size={12} className="text-primary" />
            <Text className="text-[11px] text-primary font-medium flex-1" numberOfLines={1}>
              Controlling: {activeRemoteInstance.name}
            </Text>
          </View>
        </View>
      )}

      {/* ── Main Navigation (scrollable) ── */}
      <ScrollView className="flex-1 pt-2" showsVerticalScrollIndicator={false}>
        {/* Primary nav */}
        <View className="px-2">
          <NavItem
            icon={Home}
            label="Home"
            href="/(app)"
            active={isHomePage}
            collapsed={collapsed}
            onNavPress={onNavPress}
          />
          {features.marketplace && (
            <NavItem
              icon={Store}
              label="Marketplace"
              href="/(app)/marketplace"
              active={isMarketplacePage}
              collapsed={collapsed}
              onNavPress={onNavPress}
            />
          )}
          <NavItem
            icon={Search}
            label="Search"
            collapsed={collapsed}
            shortcut={formatModKey('k')}
            onPress={handleSearchPress}
          />
          {localMode && (
            <NavItem
              icon={Mic}
              label="Meetings"
              href="/(app)/meetings"
              active={isMeetingsPage}
              collapsed={collapsed}
              onNavPress={onNavPress}
            />
          )}
        </View>

        {/* PROJECTS tree — each project expands to show its chats */}
        <View className="mt-4 px-2">
          {!collapsed && (
            <View className="flex-row items-center justify-between px-1 pb-1">
              <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Projects
              </Text>
              <Popover
                placement="bottom right"
                size="sm"
                isOpen={filterMenuOpen}
                onOpen={() => setFilterMenuOpen(true)}
                onClose={() => setFilterMenuOpen(false)}
                trigger={(triggerProps) => (
                  <Pressable
                    {...triggerProps}
                    role="button"
                    accessibilityLabel="Filter and sort projects"
                    accessibilityState={{ expanded: filterMenuOpen }}
                    className="h-6 w-6 items-center justify-center rounded-md active:bg-muted"
                  >
                    <SlidersHorizontal size={13} className="text-muted-foreground" />
                  </Pressable>
                )}
              >
                <PopoverBackdrop />
                <PopoverContent className="w-[200px] p-0">
                  <PopoverBody>
                    <View className="py-1">
                      <Text className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Sort by
                      </Text>
                      {([
                        { value: 'recent' as const, label: 'Recent' },
                        { value: 'name' as const, label: 'Name' },
                      ]).map((opt) => (
                        <Pressable
                          key={opt.value}
                          onPress={() => updateProjectFilter({ sort: opt.value })}
                          role="menuitemradio"
                          accessibilityState={{ checked: projectFilter.sort === opt.value }}
                          className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
                        >
                          <Text
                            className={cn(
                              'text-sm flex-1',
                              projectFilter.sort === opt.value ? 'text-foreground' : 'text-muted-foreground',
                            )}
                          >
                            {opt.label}
                          </Text>
                          {projectFilter.sort === opt.value && <Check size={14} className="text-primary" />}
                        </Pressable>
                      ))}
                      <View className="h-px bg-border my-1" />
                      <Text className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Show
                      </Text>
                      {([
                        { value: 'all' as const, label: 'All projects' },
                        { value: 'mine' as const, label: 'My projects' },
                      ]).map((opt) => (
                        <Pressable
                          key={opt.value}
                          onPress={() => updateProjectFilter({ scope: opt.value })}
                          role="menuitemradio"
                          accessibilityState={{ checked: projectFilter.scope === opt.value }}
                          className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
                        >
                          <Text
                            className={cn(
                              'text-sm flex-1',
                              projectFilter.scope === opt.value ? 'text-foreground' : 'text-muted-foreground',
                            )}
                          >
                            {opt.label}
                          </Text>
                          {projectFilter.scope === opt.value && <Check size={14} className="text-primary" />}
                        </Pressable>
                      ))}
                    </View>
                  </PopoverBody>
                </PopoverContent>
              </Popover>
            </View>
          )}
          {workspaceProjects.length === 0 ? (
            !collapsed && (
              <View className="px-2 py-2">
                <Text className="text-xs text-muted-foreground">
                  {projectFilter.scope === 'mine' ? 'No projects you created' : 'No projects yet'}
                </Text>
              </View>
            )
          ) : (
            <>
              {visibleProjects.map((project: any) => (
                <ProjectTreeItem
                  key={project.id}
                  project={project}
                  collapsed={collapsed}
                  onNavPress={onNavPress}
                  isPinned={pinnedProjectIds.has(project.id)}
                  onTogglePin={handleToggleProjectPin}
                />
              ))}
              {!collapsed && workspaceProjects.length > MAX_VISIBLE_PROJECTS && (hiddenProjectCount > 0 || showAllProjects) && (
                <Pressable
                  onPress={() => setShowAllProjects((v) => !v)}
                  accessibilityLabel={showAllProjects ? 'Show fewer projects' : 'Show all projects'}
                  className="flex-row items-center gap-1.5 rounded-md px-2 py-1.5 active:bg-accent/50"
                >
                  {showAllProjects ? (
                    <ChevronDown size={12} className="text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight size={12} className="text-muted-foreground shrink-0" />
                  )}
                  <Text className="text-xs text-muted-foreground flex-1">
                    {showAllProjects ? 'Show less' : `${hiddenProjectCount} more`}
                  </Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      </ScrollView>

      {/* ── Bottom Section ── */}
      <View className="border-t border-border" style={{ paddingBottom: insets.bottom }}>
        {/* Upgrade to Pro CTA */}
        {features.billing && !collapsed && !isPaidPlan && (
          <View className="px-2 pt-2">
            <Pressable
              onPress={() => { router.push('/(app)/billing' as any); onNavPress() }}
              className="flex-row items-center gap-2 px-3 py-2 rounded-md"
              style={Platform.OS === 'web'
                ? { backgroundImage: 'linear-gradient(to right, rgba(59,130,246,0.1), rgba(168,85,247,0.1))' } as any
                : { backgroundColor: 'rgba(59,130,246,0.1)' }}
            >
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">Upgrade to Pro</Text>
                <Text className="text-xs text-muted-foreground">
                  Unlock more benefits
                </Text>
              </View>
              <Plus size={16} className="text-primary" />
            </Pressable>
          </View>
        )}

        {/* Consolidated workspace + user row */}
        <View
          className={cn(
            'flex-row items-center gap-2 p-2 border-t border-border',
            collapsed ? 'justify-center' : 'px-3'
          )}
        >
          <View className={cn('min-w-0', !collapsed && 'flex-1')}>
            <AccountMenu
              user={user}
              onSignOut={handleSignOut}
              onNavigate={(href) => { if (!isWide) onClose?.(); router.push(href as any); onNavPress() }}
              isSuperAdmin={hasAdminAccess}
              isWide={isWide}
              bottomInset={insets.bottom}
              collapsed={collapsed}
              workspaces={allWorkspaces}
              currentWorkspace={currentWorkspace}
              billingData={billingData}
              workspacePlan={workspacePlan}
              allPlans={allPlans}
              showBilling={features.billing}
              onSwitchWorkspace={handleSwitchWorkspace}
              onCreateWorkspace={handleCreateWorkspace}
              localMode={localMode}
            />
          </View>

          {!collapsed && <NotificationBell size={18} />}

          {!collapsed && (
            <Pressable
              onPress={() => setInboxOpen(true)}
              className="relative shrink-0 p-1.5 rounded-md active:bg-muted"
            >
              <Inbox size={18} className="text-muted-foreground" />
              {pendingInvites.length > 0 && (
                <View className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-destructive items-center justify-center">
                  <Text className="text-[9px] font-bold text-white">{pendingInvites.length}</Text>
                </View>
              )}
            </Pressable>
          )}
        </View>
      </View>

      {/* Inbox Panel — bottom sheet on mobile, anchored popover on desktop */}
      <Modal
        visible={inboxOpen}
        transparent
        animationType={isWide ? 'none' : 'slide'}
        statusBarTranslucent
        onRequestClose={() => setInboxOpen(false)}
      >
        <Pressable
          className={cn(
            'flex-1',
            isWide ? '' : 'bg-black/50 justify-end'
          )}
          onPress={() => setInboxOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className={cn(
              'bg-card border border-border shadow-2xl',
              isWide
                ? 'absolute bottom-16 left-[220px] w-[340px] rounded-xl'
                : 'w-full rounded-t-2xl border-b-0'
            )}
            style={!isWide ? { paddingBottom: insets.bottom } : undefined}
          >
            {/* Drag indicator (mobile only) */}
            {!isWide && (
              <View className="items-center pt-2 pb-1">
                <View className="w-10 h-1 rounded-full bg-muted-foreground/30" />
              </View>
            )}

            <View className="flex-row items-center justify-between px-4 pt-4 pb-2">
              <Text className="text-base font-semibold text-card-foreground">Inbox</Text>
              <Pressable onPress={() => setInboxOpen(false)} className="p-1 rounded-md active:bg-muted">
                <X size={16} className="text-muted-foreground" />
              </Pressable>
            </View>

            {pendingInvites.length === 0 ? (
              <View className="px-4 pb-5 pt-6 items-center gap-2">
                <Inbox size={28} className="text-muted-foreground" />
                <Text className="text-sm font-medium text-card-foreground">No messages or invites pending.</Text>
                <Text className="text-xs text-muted-foreground text-center">
                  Workspace and project invitations will appear here
                </Text>
              </View>
            ) : (
              <ScrollView className="max-h-[300px]">
                <Text className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 pb-1.5 pt-1">
                  Pending invitations
                </Text>
                {pendingInvites.map((inv: any) => (
                  <Pressable key={inv.id} onPress={(e) => e.stopPropagation()}>
                    <View className="px-4 py-3 border-t border-border">
                      <View className="flex-row items-center justify-between mb-0.5">
                        <Text className="text-sm font-medium text-card-foreground">
                          {inv.workspace?.name || inv.workspaceName || 'Workspace'}
                        </Text>
                        <View className="px-1.5 py-0.5 rounded bg-muted">
                          <Text className="text-[10px] text-muted-foreground capitalize">{inv.role}</Text>
                        </View>
                      </View>
                      <Text className="text-xs text-muted-foreground mb-2.5">Invited to join this workspace</Text>
                      <View className="flex-row gap-2">
                        <Pressable
                          disabled={processingInvite?.id === inv.id}
                          onPress={async () => {
                            setProcessingInvite({ id: inv.id, action: 'accept' })
                            try {
                              await actions.acceptInvitation(inv.id, user?.id || '', {
                                workspaceId: inv.workspaceId,
                                role: inv.role,
                                projectId: inv.projectId,
                              })
                              setPendingInvites((prev) => prev.filter((i: any) => i.id !== inv.id))
                            } catch {}
                            loadInvites()
                            invitationEvents.emit()
                            workspaces.loadAll().catch((e) => console.error('[AppSidebar] Failed to reload workspaces:', e))
                            setProcessingInvite(null)
                          }}
                          className={cn('flex-1 h-8 bg-primary rounded-md items-center justify-center', processingInvite?.id === inv.id && 'opacity-50')}
                        >
                          {processingInvite?.id === inv.id && processingInvite.action === 'accept' ? (
                            <ActivityIndicator size="small" color="white" />
                          ) : (
                            <Text className="text-xs font-medium text-primary-foreground">Accept</Text>
                          )}
                        </Pressable>
                        <Pressable
                          disabled={processingInvite?.id === inv.id}
                          onPress={async () => {
                            setProcessingInvite({ id: inv.id, action: 'decline' })
                            try {
                              await actions.declineInvitation(inv.id)
                              setPendingInvites((prev) => prev.filter((i: any) => i.id !== inv.id))
                            } catch {}
                            loadInvites()
                            invitationEvents.emit()
                            setProcessingInvite(null)
                          }}
                          className={cn('flex-1 h-8 border border-border rounded-md items-center justify-center', processingInvite?.id === inv.id && 'opacity-50')}
                        >
                          {processingInvite?.id === inv.id && processingInvite.action === 'decline' ? (
                            <ActivityIndicator size="small" />
                          ) : (
                            <Text className="text-xs font-medium text-card-foreground">Decline</Text>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Modals (true dialogs that are fine as centered overlays) */}
      <CreateWorkspaceModal
        visible={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        onSubmit={handleCreateWorkspaceSubmit}
      />
      <CommandPalette
        visible={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />

    </View>
  )

  if (isWide) {
    return (
      <View className="h-full">
        {sidebarContent}
      </View>
    )
  }

  if (!isOpen) return null

  return (
    <View className="absolute inset-0 z-50 flex-row" style={{ paddingTop: insets.top }}>
      <Pressable onPress={onClose} className="absolute inset-0 bg-black/50" />
      <View className="w-72 h-full z-10">
        {sidebarContent}
      </View>
    </View>
  )
})
