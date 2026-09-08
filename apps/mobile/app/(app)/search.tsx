// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native ChatGPT-style search page.
 *
 * Opened from the sidebar search icon. Web keeps the command-palette modal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import { formatDistanceToNow } from 'date-fns'
import { Folder, Key, Search, Star, Users, X } from 'lucide-react-native'
import { PlatformApi, type ApiKeyInfo } from '@shogo-ai/sdk'
import { useAuth } from '../../contexts/auth'
import { useResolvedTheme } from '../../contexts/theme'
import {
  useDomainHttp,
  useMemberCollection,
  useProjectCollection,
  useStarredProjectCollection,
  useWorkspaceCollection,
} from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { usePlatformConfig } from '../../lib/platform-config'
import { CHATGPT_COMPOSER } from '../../components/chat/ComposerPlusMenu'
import {
  nativeComposerDockBottomPad,
  nativeComposerKeyboardDuration,
  nativeComposerKeyboardOpenFromSource,
} from '../../lib/native-composer-keyboard'
import {
  nativeComposerKeyboardEasing,
  nativeComposerKeyboardOverlapFromEvent,
  useNativeComposerKeyboard,
} from '../../lib/use-native-composer-keyboard'
import { isNativePlatform, nativePhoneCanvas, NATIVE_PHONE_GUTTER } from '../../lib/native-phone-layout'

const SEARCH_MIN_KEYBOARD_PAD = 8
const SEARCH_TAB_ROW_HEIGHT = 52
const SEARCH_PILL_HEIGHT = 36
const SEARCH_PILL_RADIUS = 18
const SEARCH_PILL_GAP = 8
const SEARCH_PILL_PAD_X = 14
const SEARCH_PILL_IDLE = { dark: '#2a2a2a', light: '#f4f4f5' } as const
const SEARCH_PILL_COUNT_IDLE = CHATGPT_COMPOSER.dark.placeholder
const SEARCH_PILL_COUNT_ACTIVE = {
  dark: 'rgba(13,13,13,0.55)',
  light: 'rgba(255,255,255,0.6)',
} as const

type SearchTab = 'all' | 'starred' | 'shared' | 'keys'

type SearchRow = {
  id: string
  title: string
  subtitle: string
  href: string
  kind: SearchTab
}

function matchesQuery(haystack: string, query: string): boolean {
  if (!query) return true
  return haystack.toLowerCase().includes(query)
}

function timeAgo(timestamp?: number | string | null): string {
  if (!timestamp) return ''
  const ms = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp))
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return formatDistanceToNow(new Date(ms), { addSuffix: true })
}

export default observer(function SearchPage() {
  const router = useRouter()
  const { user, isAuthenticated } = useAuth()
  const isDark = useResolvedTheme() === 'dark'
  const pageBg = nativePhoneCanvas(isDark)
  const { localMode } = usePlatformConfig()
  const projects = useProjectCollection()
  const workspaces = useWorkspaceCollection()
  const starredColl = useStarredProjectCollection()
  const membersColl = useMemberCollection()
  const workspace = useActiveWorkspace()
  const http = useDomainHttp()
  const platform = useMemo(() => new PlatformApi(http), [http])
  const inputRef = useRef<TextInput>(null)
  const insets = useSafeAreaInsets()
  const restKeyboardPad = Math.max(insets.bottom, SEARCH_MIN_KEYBOARD_PAD)
  const composerKeyboardPad = useRef(new Animated.Value(restKeyboardPad)).current

  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<SearchTab>('all')
  const [keys, setKeys] = useState<ApiKeyInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (Platform.OS === 'web') {
      router.replace('/(app)' as any)
    }
  }, [router])

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 250)
    return () => clearTimeout(t)
  }, [])

  useNativeComposerKeyboard(isNativePlatform(), (event, source) => {
    const overlap = nativeComposerKeyboardOverlapFromEvent(event)
    const keyboardOpen = nativeComposerKeyboardOpenFromSource(source, overlap, restKeyboardPad)
    if (keyboardOpen == null) return
    Animated.timing(composerKeyboardPad, {
      toValue: nativeComposerDockBottomPad({
        keyboardOpen,
        overlap,
        restPad: restKeyboardPad,
        iosKeyboardAvoiding: false,
      }),
      duration: nativeComposerKeyboardDuration(event.duration),
      easing: nativeComposerKeyboardEasing(),
      useNativeDriver: false,
    }).start()
  })

  useEffect(() => {
    if (!isAuthenticated || !user?.id) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        await Promise.all([
          workspaces.loadAll({}).catch(() => undefined),
          projects.loadAll().catch(() => undefined),
          starredColl.loadAll({ userId: user.id }).catch(() => undefined),
          localMode ? Promise.resolve() : membersColl.loadAll({ userId: user.id }).catch(() => undefined),
        ])
        if (workspace?.id) {
          const listed = await platform.listApiKeys(workspace.id).catch(() => [])
          if (!cancelled) setKeys(listed)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, localMode, membersColl, platform, projects, starredColl, user?.id, workspace?.id, workspaces])

  const allProjects = useMemo(() => {
    const list = (() => {
      try {
        return projects.all.slice()
      } catch {
        return [] as any[]
      }
    })()
    if (!workspace?.id) return list
    return list.filter((p: any) => p.workspaceId === workspace.id)
  }, [projects.all, workspace?.id])

  const starredProjects = useMemo(() => {
    if (!user?.id) return [] as any[]
    const ids = new Set(
      starredColl.all
        .filter((s: any) => s.userId === user.id)
        .map((s: any) => s.projectId),
    )
    return projects.all.filter((p: any) => ids.has(p.id))
  }, [projects.all, starredColl.all, user?.id])

  const sharedProjects = useMemo(() => {
    if (localMode || !user?.id) return [] as any[]
    const userMembers = membersColl.all.filter((m: any) => m.userId === user.id)
    const sharedWorkspaceIds = new Set(
      workspaces.all
        .filter((ws: any) => {
          const membership = userMembers.find((m: any) => m.workspaceId === ws.id)
          return membership && membership.role !== 'owner'
        })
        .map((ws: any) => ws.id),
    )
    return projects.all.filter((p: any) => sharedWorkspaceIds.has(p.workspaceId))
  }, [localMode, membersColl.all, projects.all, user?.id, workspaces.all])

  const q = query.trim().toLowerCase()

  const rows = useMemo<SearchRow[]>(() => {
    const projectRows = (list: any[], kind: SearchTab): SearchRow[] =>
      list
        .filter((p: any) => matchesQuery(`${p.name ?? ''} ${p.description ?? ''}`, q))
        .sort((a: any, b: any) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
        .map((p: any) => ({
          id: p.id,
          title: p.name || 'Untitled project',
          subtitle: [p.description, timeAgo(p.updatedAt || p.createdAt)].filter(Boolean).join(' · ') || 'Project',
          href: `/(app)/projects/${p.id}?tab=chat-fullscreen`,
          kind,
        }))

    if (tab === 'all') return projectRows(allProjects, 'all')
    if (tab === 'starred') return projectRows(starredProjects, 'starred')
    if (tab === 'shared') return projectRows(sharedProjects, 'shared')
    return keys
      .filter((k) => matchesQuery(`${k.name ?? ''} ${k.kind ?? ''}`, q))
      .map((k) => ({
        id: k.id,
        title: k.name || 'API key',
        subtitle: k.kind === 'device' ? 'Device' : 'API key',
        href: '/(app)/api-keys',
        kind: 'keys' as const,
      }))
  }, [allProjects, keys, q, sharedProjects, starredProjects, tab])

  const counts = useMemo(() => {
    const projectCount = (list: any[]) =>
      q ? list.filter((p: any) => matchesQuery(`${p.name ?? ''} ${p.description ?? ''}`, q)).length : list.length
    return {
      all: projectCount(allProjects),
      starred: projectCount(starredProjects),
      shared: projectCount(sharedProjects),
      keys: q ? keys.filter((k) => matchesQuery(`${k.name ?? ''} ${k.kind ?? ''}`, q)).length : keys.length,
    }
  }, [allProjects, keys, q, sharedProjects, starredProjects])

  const tabs = useMemo(
    () =>
      (
        [
          { id: 'all' as const, label: 'All projects', count: counts.all },
          { id: 'starred' as const, label: 'Starred', count: counts.starred },
          ...(!localMode ? [{ id: 'shared' as const, label: 'Shared with me', count: counts.shared }] : []),
          { id: 'keys' as const, label: 'API keys', count: counts.keys },
        ]
      ),
    [counts.all, counts.keys, counts.shared, counts.starred, localMode],
  )

  const closeSearch = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)' as any)
  }, [router])

  const openRow = useCallback(
    (row: SearchRow) => {
      router.push(row.href as any)
    },
    [router],
  )

  const emptyCopy =
    tab === 'keys'
      ? q
        ? 'No API keys match that search'
        : 'No API keys yet'
      : q
        ? 'No projects match that search'
        : tab === 'starred'
          ? 'No starred projects'
          : tab === 'shared'
            ? 'Nothing shared with you yet'
            : 'No projects yet'

  if (Platform.OS === 'web') return null

  const renderRow = ({ item }: { item: SearchRow }) => {
    const Icon = item.kind === 'keys' ? Key : item.kind === 'starred' ? Star : item.kind === 'shared' ? Users : Folder
    return (
      <Pressable
        onPress={() => openRow(item)}
        accessibilityRole="button"
        accessibilityLabel={item.title}
        className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted/60"
      >
        <View className="h-11 w-11 items-center justify-center rounded-2xl bg-muted">
          <Icon size={18} className="text-foreground" />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-[16px] font-medium text-foreground" numberOfLines={1}>
            {item.title}
          </Text>
          <Text className="mt-0.5 text-[13px] text-muted-foreground" numberOfLines={1}>
            {item.subtitle}
          </Text>
        </View>
      </Pressable>
    )
  }

  return (
    <View className="flex-1 bg-background" style={{ flex: 1, paddingTop: insets.top, backgroundColor: pageBg }}>
      <View className="flex-1">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={{ height: SEARCH_TAB_ROW_HEIGHT, flexGrow: 0, flexShrink: 0 }}
          contentContainerStyle={{
            paddingHorizontal: NATIVE_PHONE_GUTTER,
            alignItems: 'center',
            height: SEARCH_TAB_ROW_HEIGHT,
          }}
        >
          {tabs.map((item) => {
            const active = tab === item.id
            return (
              <Pressable
                key={item.id}
                onPress={() => setTab(item.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={{
                  height: SEARCH_PILL_HEIGHT,
                  marginRight: SEARCH_PILL_GAP,
                  paddingHorizontal: SEARCH_PILL_PAD_X,
                  borderRadius: SEARCH_PILL_RADIUS,
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: active
                    ? (isDark ? CHATGPT_COMPOSER.dark.text : CHATGPT_COMPOSER.light.text)
                    : (isDark ? SEARCH_PILL_IDLE.dark : SEARCH_PILL_IDLE.light),
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    lineHeight: 18,
                    fontWeight: '500',
                    color: active
                      ? (isDark ? CHATGPT_COMPOSER.dark.sendIcon : CHATGPT_COMPOSER.light.sendIcon)
                      : (isDark ? CHATGPT_COMPOSER.dark.text : CHATGPT_COMPOSER.light.text),
                    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
                  }}
                >
                  {item.label}
                </Text>
                <Text
                  style={{
                    marginLeft: 6,
                    fontSize: 13,
                    lineHeight: 18,
                    color: active
                      ? (isDark ? SEARCH_PILL_COUNT_ACTIVE.dark : SEARCH_PILL_COUNT_ACTIVE.light)
                      : SEARCH_PILL_COUNT_IDLE,
                    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
                  }}
                >
                  {item.count}
                </Text>
              </Pressable>
            )
          })}
        </ScrollView>

        {loading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator />
          </View>
        ) : rows.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Search size={44} className="text-muted-foreground/70" />
            <Text className="mt-4 text-center text-base text-muted-foreground">{emptyCopy}</Text>
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(item) => item.id}
            renderItem={renderRow}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={{ paddingBottom: 12 }}
          />
        )}
      </View>

      <Animated.View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: composerKeyboardPad,
          backgroundColor: pageBg,
        }}
      >
        <View className="h-12 min-w-0 flex-1 flex-row items-center rounded-full bg-muted px-4">
          <Search size={18} className="text-muted-foreground" />
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={CHATGPT_COMPOSER.dark.placeholder}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            automaticallyAdjustKeyboardInsets={false}
            className="ml-2 flex-1 text-[16px] text-foreground"
            style={{ fontSize: 16, lineHeight: 20, paddingVertical: 0 }}
            accessibilityLabel="Search"
          />
          {query.length > 0 ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear search">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={closeSearch}
          accessibilityLabel="Close search"
          className="ml-2 h-12 w-12 items-center justify-center rounded-full bg-muted"
        >
          <X size={20} className="text-foreground" />
        </Pressable>
      </Animated.View>
    </View>
  )
})
