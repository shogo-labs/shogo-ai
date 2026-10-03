// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CommandPalette - Global search command palette
 *
 * Opens with ⌘+K (Mac) or Ctrl+K (Windows/Linux).
 * Provides quick navigation to features, projects, pages, and actions.
 * In team workspaces it also jumps to channels, DMs, and people, and hands
 * the typed text to message search or "ask the workspace".
 *
 * React Native port of the web CommandPalette from staging.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  Platform,
  Modal,
} from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  Search,
  Home,
  LayoutGrid,
  Star,
  Users,
  CreditCard,
  User,
  ArrowRight,
  X,
  BarChart3,
  Key,
  Store,
  Hash,
  Lock,
  MessageSquare,
  Bot,
  Inbox,
  Sparkles,
  Radio,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useProjectCollection } from '../../contexts/domain'
import { usePlatformConfig } from '../../lib/platform-config'
import { useIsNativePhoneLayout } from '../../lib/native-phone-layout'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useConversationList, useMentionables, useMyUserId } from '../../hooks/useTeamChat'
import { conversationTitle, teamChatApi, type ConversationSummary } from '../../lib/team-chat-api'

// ─── Types ────────────────────────────────────────────────

type CommandCategory = 'chat' | 'navigation' | 'projects' | 'settings'

interface CommandItem {
  id: string
  label: string
  description?: string
  icon: React.ElementType
  href: string
  category: CommandCategory
  keywords?: string[]
  /** Runs instead of navigating to `href`. */
  run?: () => void | Promise<void>
}

const CATEGORY_ORDER: CommandCategory[] = ['chat', 'navigation', 'projects', 'settings']
const MAX_CHAT_ITEMS = 8

function chatIcon(c: ConversationSummary): React.ElementType {
  if (c.kind === 'activity') return Radio
  if (c.kind === 'private') return Lock
  if (c.kind === 'public') return Hash
  if ((c.participants ?? []).some((p) => p.type === 'agent')) return Bot
  return MessageSquare
}

/** Chat entries for the palette: conversations, people, and search/ask for the typed text. */
function useChatCommands(query: string, visible: boolean): CommandItem[] {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId = visible && experience.kind === 'team' ? workspace?.id ?? null : null
  const { list } = useConversationList(workspaceId)
  const mentionables = useMentionables(workspaceId)
  const me = useMyUserId()

  return useMemo(() => {
    if (!workspaceId) return []
    const q = query.trim().toLowerCase()
    const conversations = list
      .filter((c) => !c.archivedAt && (c.joined || c.kind === 'dm' || c.kind === 'group_dm'))
      .map((c): CommandItem & { at: number } => {
        const channel = c.kind === 'public' || c.kind === 'private' || c.kind === 'activity'
        const label = channel ? `#${c.name ?? c.slug ?? 'channel'}` : conversationTitle(c)
        return {
          id: `chat-${c.id}`,
          label,
          description: channel ? (c.topic || 'Channel') : 'Direct message',
          icon: chatIcon(c),
          href: `/(app)/c/${encodeURIComponent(c.id)}`,
          category: 'chat',
          keywords: [c.name, c.slug, ...(c.participants ?? []).map((p) => p.name)].filter(Boolean).map((k) => String(k).toLowerCase()),
          at: c.lastMessageAt ? Date.parse(c.lastMessageAt) : 0,
        }
      })
      .sort((a, b) => b.at - a.at)
    const dmPeers = new Set(
      list.filter((c) => c.kind === 'dm').flatMap((c) => (c.participants ?? []).map((p) => (p.type === 'user' ? p.id : ''))),
    )
    const people: CommandItem[] = (mentionables?.people ?? [])
      .filter((p) => p.id !== me && !dmPeers.has(p.id))
      .map((p) => ({
        id: `chat-person-${p.id}`,
        label: p.name,
        description: `Message ${p.email}`,
        icon: User,
        href: '/(app)/c',
        category: 'chat',
        keywords: [p.name.toLowerCase(), p.email.toLowerCase()],
        run: async () => {
          const c = await teamChatApi().openDm(workspaceId, [p.id])
          router.push(`/(app)/c/${encodeURIComponent(c.id)}` as any)
        },
      }))
    const matches = (cmd: CommandItem) =>
      !q || cmd.label.toLowerCase().includes(q) || cmd.keywords?.some((k) => k.includes(q))
    const items: CommandItem[] = [...conversations, ...(q ? people : [])].filter(matches).slice(0, MAX_CHAT_ITEMS)
    if (!q) {
      items.push({ id: 'chat-inbox', label: 'Inbox', description: 'Mentions, replies, and reminders', icon: Inbox, href: '/(app)/c/inbox', category: 'chat' })
    } else {
      const raw = query.trim()
      items.push(
        {
          id: 'chat-search', label: `Search messages for “${raw}”`, icon: Search, category: 'chat',
          href: `/(app)/c/search?q=${encodeURIComponent(raw)}`,
        },
        {
          id: 'chat-ask', label: `Ask the workspace: “${raw}”`, icon: Sparkles, category: 'chat',
          href: `/(app)/c/search?mode=ask&q=${encodeURIComponent(raw)}`,
        },
      )
    }
    return items
  }, [workspaceId, list, mentionables, me, query, router])
}

// ─── Props ────────────────────────────────────────────────

interface CommandPaletteProps {
  visible: boolean
  onClose: () => void
}

// ─── Component ────────────────────────────────────────────

export const CommandPalette = observer(function CommandPalette({
  visible,
  onClose,
}: CommandPaletteProps) {
  const router = useRouter()
  const isNativePhone = useIsNativePhoneLayout()
  const projects = useProjectCollection()
  const { localMode, features } = usePlatformConfig()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<TextInput>(null)

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      {
        id: 'nav-home',
        label: 'Home',
        description: 'Go to home page',
        icon: Home,
        href: '/(app)',
        category: 'navigation',
        keywords: ['home', 'dashboard'],
      },
      {
        id: 'nav-projects',
        label: 'All Projects',
        description: 'View all projects',
        icon: LayoutGrid,
        href: '/(app)/projects',
        category: 'navigation',
        keywords: ['projects', 'all'],
      },
      {
        id: 'nav-starred',
        label: 'Starred',
        description: 'View starred projects',
        icon: Star,
        href: '/(app)/starred',
        category: 'navigation',
        keywords: ['starred', 'favorites'],
      },
      !localMode && {
        id: 'nav-shared',
        label: 'Shared with me',
        description: 'View shared projects',
        icon: Users,
        href: '/(app)/shared',
        category: 'navigation',
        keywords: ['shared', 'team'],
      },
      !isNativePhone && features.marketplace && {
        id: 'nav-marketplace',
        label: 'Marketplace',
        description: 'Browse agents and templates',
        icon: Store,
        href: '/(app)/marketplace',
        category: 'navigation',
        keywords: ['marketplace', 'templates', 'agents', 'starter', 'install'],
      },
      {
        id: 'nav-api-keys',
        label: 'API Keys',
        description: 'Create and manage API keys',
        icon: Key,
        href: '/(app)/api-keys',
        category: 'navigation',
        keywords: ['api', 'keys', 'token', 'secret', 'local', 'connect'],
      },
      {
        id: 'settings-billing',
        label: 'Plans & Billing',
        description: 'Manage subscription and usage',
        icon: CreditCard,
        href: '/(app)/billing',
        category: 'settings',
        keywords: ['billing', 'plans', 'subscription', 'usage', 'upgrade'],
      },
      {
        id: 'settings-profile',
        label: 'Profile',
        description: 'View your profile',
        icon: User,
        href: '/(app)/profile',
        category: 'settings',
        keywords: ['profile', 'account', 'settings'],
      },
      {
        id: 'settings-members',
        label: 'Members',
        description: 'Manage workspace members',
        icon: Users,
        href: '/(app)/settings?tab=people',
        category: 'settings',
        keywords: ['members', 'team', 'invite'],
      },
      !localMode && {
        id: 'settings-analytics',
        label: 'Workspace Analytics',
        description: 'View usage metrics and spend',
        icon: BarChart3,
        href: '/(app)/settings?tab=analytics',
        category: 'settings',
        keywords: ['analytics', 'usage', 'spend', 'metrics', 'stats'],
      },
    ].filter(Boolean) as CommandItem[]

    let projectList: any[] = []
    try { projectList = projects?.all?.slice() ?? [] } catch { projectList = [] }

    for (const p of projectList) {
      items.push({
        id: `project-${p.id}`,
        label: p.name,
        description: 'Project',
        icon: LayoutGrid,
        href: `/(app)/projects/${p.id}`,
        category: 'projects',
        keywords: [p.name?.toLowerCase()],
      })
    }

    return items
  }, [projects?.all, localMode, features.marketplace, isNativePhone])

  const chatCommands = useChatCommands(query, visible)

  const filteredCommands = useMemo(() => {
    const matched = !query.trim() ? commands : (() => {
      const lowerQuery = query.toLowerCase()
      return commands.filter((cmd) => {
        const labelMatch = cmd.label.toLowerCase().includes(lowerQuery)
        const descMatch = cmd.description?.toLowerCase().includes(lowerQuery)
        const keywordMatch = cmd.keywords?.some((k) => k.includes(lowerQuery))
        return labelMatch || descMatch || keywordMatch
      })
    })()
    return [...chatCommands, ...matched]
  }, [commands, chatCommands, query])

  const groupedCommands = useMemo(() => {
    const groups: Record<CommandCategory, CommandItem[]> = {
      chat: [],
      navigation: [],
      projects: [],
      settings: [],
    }
    filteredCommands.forEach((cmd) => {
      groups[cmd.category].push(cmd)
    })
    return groups
  }, [filteredCommands])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    if (!visible) return
    void projects.loadAll().catch(() => undefined)
  }, [projects, visible])

  useEffect(() => {
    if (!visible) {
      setQuery('')
      setSelectedIndex(0)
    } else {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [visible])

  const navigateTo = useCallback(
    (cmd: CommandItem) => {
      onClose()
      if (cmd.run) void Promise.resolve(cmd.run()).catch(() => undefined)
      else router.push(cmd.href as any)
    },
    [router, onClose],
  )

  const getFlatIndex = useCallback(
    (category: CommandCategory, indexInCategory: number): number => {
      let flatIndex = 0
      for (const cat of CATEGORY_ORDER) {
        if (cat === category) return flatIndex + indexInCategory
        flatIndex += groupedCommands[cat].length
      }
      return flatIndex
    },
    [groupedCommands],
  )

  // Stable refs so the keyboard handler doesn't re-register on every state change
  const stateRef = useRef({ filteredCommands, selectedIndex, navigateTo, onClose })
  useEffect(() => {
    stateRef.current = { filteredCommands, selectedIndex, navigateTo, onClose }
  })

  // Keyboard navigation — attach to the focused input element directly
  // so events work inside the Modal portal on web.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return
    const el =inputRef.current as any
    const node: HTMLElement | null =
      el && typeof el.addEventListener === 'function' ? el : ( el?._node ?? null)
    if (!node) return

    const handler = (e: KeyboardEvent) => {
      const { filteredCommands: cmds, selectedIndex: idx, navigateTo: nav, onClose: close } = stateRef.current
      const total = cmds.length || 1
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % total)
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + total) % total)
          break
        case 'Enter':
          e.preventDefault()
          if (cmds[idx]) nav(cmds[idx])
          break
        case 'Escape':
          e.preventDefault()
          close()
          break
      }
    }

    node.addEventListener('keydown', handler)
    return () => node.removeEventListener('keydown', handler)
  }, [visible])

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View className="flex-1 items-center justify-center px-4">
        {/* Backdrop */}
        <Pressable onPress={onClose} className="absolute inset-0 bg-black/50" />

        {/* Panel */}
        <View
          className={cn(
            'bg-card border border-border rounded-xl shadow-lg overflow-hidden z-10 w-full',
            Platform.OS === 'web' ? 'max-w-xl' : 'max-w-lg',
          )}
        >
          {/* Search input */}
          <View className={cn('flex-row items-center border-b border-border', isNativePhone ? 'min-h-14 gap-3 px-4 py-3.5' : 'gap-3 px-4 py-3')}>
            <Search size={isNativePhone ? 22 : 20} className="text-muted-foreground" />
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder="Jump to a channel, person, page, or project…"
              placeholderTextColor="#9ca3af"
              autoCapitalize="none"
              autoCorrect={false}
              className={cn('flex-1 text-foreground web:outline-none no-focus-ring', isNativePhone ? 'text-lg' : 'text-base')}
              returnKeyType="go"
              onSubmitEditing={() => {
                if (filteredCommands[selectedIndex]) {
                  navigateTo(filteredCommands[selectedIndex])
                }
              }}
            />
            {Platform.OS === 'web' ? (
              <Pressable
                onPress={onClose}
                className="rounded border border-border bg-muted px-1.5 py-0.5"
              >
                <Text className="text-[10px] font-mono text-muted-foreground">ESC</Text>
              </Pressable>
            ) : (
              <Pressable onPress={onClose} className={cn('rounded-md active:bg-muted', isNativePhone ? 'h-11 w-11 items-center justify-center' : 'p-1')}>
                <X size={isNativePhone ? 22 : 16} className="text-muted-foreground" />
              </Pressable>
            )}
          </View>

          {/* Results */}
          <ScrollView className="max-h-96" keyboardShouldPersistTaps="handled">
            {filteredCommands.length === 0 ? (
              <View className="items-center py-8">
                <Text className="text-sm text-muted-foreground">
                  No results found for "{query}"
                </Text>
              </View>
            ) : (
              <View className="py-2">
                {CATEGORY_ORDER.map((category) => {
                  const items = groupedCommands[category]
                  if (items.length === 0) return null

                  return (
                    <View key={category}>
                      {items.map((cmd, idx) => {
                        const flatIndex = getFlatIndex(category, idx)
                        const isSelected = flatIndex === selectedIndex
                        const Icon = cmd.icon

                        return (
                          <Pressable
                            key={cmd.id}
                            onPress={() => navigateTo(cmd)}
                            onHoverIn={() => setSelectedIndex(flatIndex)}
                            className={cn(
                              'flex-row items-center w-full',
                              isNativePhone ? 'min-h-14 gap-3 px-4 py-3.5' : 'gap-3 px-4 py-2.5',
                              isSelected
                                ? 'bg-accent'
                                : 'active:bg-accent/50',
                            )}
                          >
                            <Icon size={isNativePhone ? 22 : 16} className="text-muted-foreground" />
                            <View className="flex-1 min-w-0">
                              <Text className={cn('font-medium text-foreground', isNativePhone ? 'text-base' : 'text-sm')} numberOfLines={1}>
                                {cmd.label}
                              </Text>
                              {cmd.description && (
                                <Text className={cn('text-muted-foreground', isNativePhone ? 'text-sm' : 'text-xs')} numberOfLines={1}>
                                  {cmd.description}
                                </Text>
                              )}
                            </View>
                            {isSelected && (
                              <ArrowRight size={isNativePhone ? 20 : 16} className="text-muted-foreground" />
                            )}
                          </Pressable>
                        )
                      })}
                    </View>
                  )
                })}
              </View>
            )}
          </ScrollView>

        </View>
      </View>
    </Modal>
  )
})

/**
 * Hook to manage command palette state and keyboard shortcut.
 * Mirrors the web useCommandPalette() hook from staging.
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (Platform.OS !== 'web') return
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  return { open, setOpen }
}
