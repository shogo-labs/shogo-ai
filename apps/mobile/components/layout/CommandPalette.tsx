// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CommandPalette - Global search command palette
 *
 * Opens with ⌘+K (Mac) or Ctrl+K (Windows/Linux).
 * Provides quick navigation to features, projects, pages, and actions.
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
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  Search,
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
  MessageSquare,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useProjectCollection } from '../../contexts/domain'
import { usePlatformConfig } from '../../lib/platform-config'
import { getActiveWorkspaceId } from '../../lib/workspace-store'
import { searchWorkspaceChats, type ChatSearchConversationDto, type ChatSearchHitDto } from '../../lib/chat-search-api'

// ─── Types ────────────────────────────────────────────────

type CommandCategory = 'navigation' | 'projects' | 'chat' | 'settings'
type ActiveCategory = 'all' | CommandCategory

interface CommandItem {
  id: string
  label: string
  description?: string
  icon: React.ElementType
  href: string
  category: CommandCategory
  keywords?: string[]
  chatHit?: ChatSearchHitDto
}

const CATEGORY_ORDER: CommandCategory[] = ['navigation', 'projects', 'chat', 'settings']
const CATEGORY_TABS: Array<{ value: ActiveCategory; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'navigation', label: 'Pages' },
  { value: 'projects', label: 'Projects' },
  { value: 'chat', label: 'Chat' },
  { value: 'settings', label: 'Settings' },
]

const CHAT_SEARCH_DEBOUNCE_MS = 200
const CHAT_SEARCH_PAGE_SIZE = 10
const CHAT_SEARCH_LOAD_MORE_THRESHOLD_PX = 96

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
  const projects = useProjectCollection()
  const { localMode, features } = usePlatformConfig()
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<ActiveCategory>('all')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [chatResults, setChatResults] = useState<ChatSearchConversationDto[]>([])
  const [chatSearchNextOffset, setChatSearchNextOffset] = useState<number | null>(null)
  const [isLoadingChatSearch, setIsLoadingChatSearch] = useState(false)
  const inputRef = useRef<TextInput>(null)

  const workspaceId = useMemo(() => {
    const active = getActiveWorkspaceId()
    if (active) return active
    try {
      return projects?.all?.[0]?.workspaceId ?? null
    } catch {
      return null
    }
  }, [projects?.all])

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
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
      features.marketplace && {
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

    for (const result of chatResults) {
      const projectId = result.projectId
      if (!projectId) continue
      const hit = result.hits.find((item) => item.field === 'message') ?? result.hits[0]
      const params = new URLSearchParams({
        chatSessionId: result.conversationId,
        chatScope: result.contextType === 'workspace' ? 'workspace' : 'project',
      })
      if (hit?.messageId) params.set('searchMessageId', hit.messageId)

      items.push({
        id: `chat-${result.conversationId}-${hit?.messageId ?? hit?.field ?? 'conversation'}`,
        label: result.title,
        description: formatChatResultDescription(result, hit),
        icon: MessageSquare,
        href: `/(app)/projects/${projectId}?${params.toString()}`,
        category: 'chat',
        keywords: [result.title, result.projectName ?? '', hit?.snippet ?? ''].map((value) => value.toLowerCase()),
        chatHit: hit,
      })
    }

    return items
  }, [projects?.all, localMode, features.marketplace, chatResults])

  useEffect(() => {
    const q = query.trim()
    if (!visible || !workspaceId || q.length === 0 || (activeCategory !== 'all' && activeCategory !== 'chat')) {
      setChatResults([])
      setChatSearchNextOffset(null)
      setIsLoadingChatSearch(false)
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      setIsLoadingChatSearch(true)
      searchWorkspaceChats({ workspaceId, query: q, limit: CHAT_SEARCH_PAGE_SIZE, offset: 0, signal: controller.signal })
        .then((data) => {
          setChatResults(data.conversations)
          setChatSearchNextOffset(data.nextOffset)
        })
        .catch((err) => {
          if (!controller.signal.aborted) {
            console.warn('[CommandPalette] Chat search failed:', err)
            setChatResults([])
            setChatSearchNextOffset(null)
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoadingChatSearch(false)
        })
    }, CHAT_SEARCH_DEBOUNCE_MS)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [activeCategory, query, visible, workspaceId])

  const filteredCommands = useMemo(() => {
    const q = query.trim()
    const categoryFiltered = commands.filter((cmd) => {
      if (!q && cmd.category === 'projects') return false
      if (!q && cmd.id === 'nav-projects') return false
      return activeCategory === 'all' || cmd.category === activeCategory
    })

    if (!q) return categoryFiltered
    const lowerQuery = query.toLowerCase()
    return categoryFiltered.filter((cmd) => {
      const labelMatch = cmd.label.toLowerCase().includes(lowerQuery)
      const descMatch = cmd.description?.toLowerCase().includes(lowerQuery)
      const keywordMatch = cmd.keywords?.some((k) => k.includes(lowerQuery))
      return labelMatch || descMatch || keywordMatch
    })
  }, [commands, query, activeCategory])

  const groupedCommands = useMemo(() => {
    const groups: Record<CommandCategory, CommandItem[]> = {
      navigation: [],
      projects: [],
      chat: [],
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
    if (!visible) {
      setQuery('')
      setActiveCategory('all')
      setSelectedIndex(0)
    } else {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [visible])

  const navigateTo = useCallback(
    (href: string) => {
      onClose()
      router.push(href as any)
    },
    [router, onClose],
  )

  const loadMoreChatResults = useCallback(() => {
    const q = query.trim()
    if (
      !visible ||
      !workspaceId ||
      !q ||
      chatSearchNextOffset == null ||
      isLoadingChatSearch ||
      (activeCategory !== 'all' && activeCategory !== 'chat')
    ) return

    const controller = new AbortController()
    setIsLoadingChatSearch(true)
    searchWorkspaceChats({
      workspaceId,
      query: q,
      limit: CHAT_SEARCH_PAGE_SIZE,
      offset: chatSearchNextOffset,
      signal: controller.signal,
    })
      .then((data) => {
        setChatResults((prev) => mergeChatSearchResults(prev, data.conversations))
        setChatSearchNextOffset(data.nextOffset)
      })
      .catch((err) => {
        if (!controller.signal.aborted) console.warn('[CommandPalette] Chat search load more failed:', err)
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingChatSearch(false)
      })
  }, [activeCategory, chatSearchNextOffset, isLoadingChatSearch, query, visible, workspaceId])

  const handleResultsScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent
    const distanceFromBottom = contentSize.height - (layoutMeasurement.height + contentOffset.y)
    if (distanceFromBottom <= CHAT_SEARCH_LOAD_MORE_THRESHOLD_PX) {
      loadMoreChatResults()
    }
  }, [loadMoreChatResults])

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
    const el = (inputRef.current as any)
    const node: HTMLElement | null =
      el && typeof el.addEventListener === 'function' ? el : el?._node ?? null
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
          if (cmds[idx]) nav(cmds[idx].href)
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
          <View className="flex-row items-center gap-3 px-4 py-3">
            <Search size={20} className="text-muted-foreground" />
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder="Search pages, projects, chats..."
              placeholderTextColor="#9ca3af"
              autoCapitalize="none"
              autoCorrect={false}
              className="flex-1 text-base text-foreground web:outline-none no-focus-ring"
              returnKeyType="go"
              onSubmitEditing={() => {
                if (filteredCommands[selectedIndex]) {
                  navigateTo(filteredCommands[selectedIndex].href)
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
              <Pressable onPress={onClose} className="p-1 rounded-md active:bg-muted">
                <X size={16} className="text-muted-foreground" />
              </Pressable>
            )}
          </View>

          {/* Category tabs */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            className="border-b border-border"
            contentContainerClassName="px-3 py-2 gap-2"
          >
            {CATEGORY_TABS.map((tab) => {
              const selected = activeCategory === tab.value

              return (
                <Pressable
                  key={tab.value}
                  onPress={() => {
                    setActiveCategory(tab.value)
                    setSelectedIndex(0)
                  }}
                  className={cn(
                    'rounded-full px-3 py-1.5',
                    selected ? 'bg-accent' : 'active:bg-accent/50',
                  )}
                >
                  <Text
                    className={cn(
                      'text-sm',
                      selected ? 'font-medium text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>

          {/* Results */}
          <ScrollView
            className="max-h-96"
            keyboardShouldPersistTaps="handled"
            onScroll={handleResultsScroll}
            scrollEventThrottle={64}
          >
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
                            onPress={() => navigateTo(cmd.href)}
                            onHoverIn={() => setSelectedIndex(flatIndex)}
                            className={cn(
                              'flex-row items-center gap-3 w-full px-4 py-2.5',
                              isSelected
                                ? 'bg-accent'
                                : 'active:bg-accent/50',
                            )}
                          >
                            <Icon size={16} className="text-muted-foreground" />
                            <View className="flex-1 min-w-0">
                              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                                {cmd.label}
                              </Text>
                              {cmd.description && (
                                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                                  {cmd.chatHit ? renderHighlightedCommandDescription(cmd.description, query) : cmd.description}
                                </Text>
                              )}
                            </View>
                            {isSelected && (
                              <ArrowRight size={16} className="text-muted-foreground" />
                            )}
                          </Pressable>
                        )
                      })}
                    </View>
                  )
                })}
              </View>
            )}
            {isLoadingChatSearch && chatResults.length > 0 && (
              <View className="items-center py-3">
                <ActivityIndicator size="small" />
              </View>
            )}
          </ScrollView>

        </View>
      </View>
    </Modal>
  )
})

function formatChatResultDescription(
  result: ChatSearchConversationDto,
  hit: ChatSearchHitDto | undefined,
): string {
  const project = result.projectName ? `${result.projectName} · ` : ''
  const snippet = hit?.snippet?.trim()
  if (snippet) return `${project}${snippet}`
  return `${project}${formatRelativeChatDate(result.updatedAt)}`
}

function mergeChatSearchResults(
  current: ChatSearchConversationDto[],
  next: ChatSearchConversationDto[],
): ChatSearchConversationDto[] {
  const seen = new Set(current.map((item) => item.conversationId))
  const merged = [...current]
  for (const item of next) {
    if (seen.has(item.conversationId)) continue
    seen.add(item.conversationId)
    merged.push(item)
  }
  return merged
}

function renderHighlightedCommandDescription(text: string, query: string) {
  const tokens = query.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  if (tokens.length === 0) return text
  const lower = text.toLowerCase()
  const ranges = tokens.flatMap((token) => {
    const tokenRanges: Array<{ start: number; end: number }> = []
    let start = lower.indexOf(token)
    while (start !== -1) {
      tokenRanges.push({ start, end: start + token.length })
      start = lower.indexOf(token, start + 1)
    }
    return tokenRanges
  }).sort((a, b) => a.start - b.start)

  if (ranges.length === 0) return text
  const nodes: React.ReactNode[] = []
  let cursor = 0
  ranges.forEach((range, index) => {
    if (range.start < cursor) return
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start))
    nodes.push(<Text key={`chat-hit-${index}`} className="font-semibold text-foreground">{text.slice(range.start, range.end)}</Text>)
    cursor = range.end
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function formatRelativeChatDate(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return 'Last Week'
}

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
