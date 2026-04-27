// SPDX-License-Identifier: AGPL-3.0-or-later
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
} from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  Search,
  Home,
  LayoutGrid,
  Star,
  Users,
  FileCode2,
  CreditCard,
  User,
  ArrowRight,
  X,
  BarChart3,
  Key,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useProjectCollection } from '../../contexts/domain'
import { usePlatformConfig } from '../../lib/platform-config'

// ─── Types ────────────────────────────────────────────────

type CommandCategory = 'navigation' | 'projects' | 'settings'

interface CommandItem {
  id: string
  label: string
  description?: string
  icon: React.ElementType
  href: string
  category: CommandCategory
  keywords?: string[]
}

const CATEGORY_ORDER: CommandCategory[] = ['navigation', 'projects', 'settings']

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
  const { localMode } = usePlatformConfig()
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
      {
        id: 'nav-templates',
        label: 'Templates',
        description: 'Browse templates',
        icon: FileCode2,
        href: '/(app)/templates',
        category: 'navigation',
        keywords: ['templates', 'starter'],
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
        href: '/(app)/settings',
        category: 'settings',
        keywords: ['profile', 'account', 'settings'],
      },
      {
        id: 'settings-members',
        label: 'Members',
        description: 'Manage workspace members',
        icon: Users,
        href: '/(app)/settings',
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
  }, [projects?.all])

  const filteredCommands = useMemo(() => {
    if (!query.trim()) return commands
    const lowerQuery = query.toLowerCase()
    return commands.filter((cmd) => {
      const labelMatch = cmd.label.toLowerCase().includes(lowerQuery)
      const descMatch = cmd.description?.toLowerCase().includes(lowerQuery)
      const keywordMatch = cmd.keywords?.some((k) => k.includes(lowerQuery))
      return labelMatch || descMatch || keywordMatch
    })
  }, [commands, query])

  const groupedCommands = useMemo(() => {
    const groups: Record<CommandCategory, CommandItem[]> = {
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
    if (!visible) {
      setQuery('')
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
          <View className="flex-row items-center gap-3 px-4 py-3 border-b border-border">
            <Search size={20} className="text-muted-foreground" />
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder="Search for pages, projects, features..."
              placeholderTextColor="#9ca3af"
              autoCapitalize="none"
              autoCorrect={false}
              className="flex-1 text-base text-foreground web:outline-none"
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
                                  {cmd.description}
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
