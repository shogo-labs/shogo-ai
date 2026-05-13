// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { formatDistanceToNow } from 'date-fns'
import {
  Search,
  Star,
  MoreHorizontal,
  LayoutGrid,
  List,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Users,
  Settings,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import {
  useWorkspaceCollection,
  useProjectCollection,
  useMemberCollection,
  useStarredProjectCollection,
} from '../../contexts/domain'

type SortBy = 'lastEdited' | 'dateCreated' | 'alphabetical'
type ViewMode = 'grid' | 'list'

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'lastEdited', label: 'Last edited' },
  { value: 'dateCreated', label: 'Date created' },
  { value: 'alphabetical', label: 'Alphabetical' },
]

function getTimeAgo(timestamp: number): string {
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true })
}

type SharedGroup = {
  workspace: any
  role: string
  projects: any[]
  latestUpdatedAt: number
}

const COLLAPSE_STORAGE_KEY = 'shogo:shared:collapsed'

function readCollapsedFromStorage(): Record<string, boolean> {
  if (typeof window === 'undefined' || !window.localStorage) return {}
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeCollapsedToStorage(state: Record<string, boolean>) {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    const compact: Record<string, true> = {}
    for (const [id, v] of Object.entries(state)) if (v) compact[id] = true
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(compact))
  } catch {
    // ignore quota / privacy-mode errors
  }
}

function roleLabel(role: string | undefined): string {
  if (!role) return 'Member'
  return role.charAt(0).toUpperCase() + role.slice(1)
}

const GRADIENT_COLORS = [
  'bg-purple-500',
  'bg-pink-500',
  'bg-orange-500',
  'bg-green-500',
  'bg-cyan-500',
  'bg-violet-500',
  'bg-fuchsia-500',
  'bg-teal-500',
]

function getPlaceholderColor(name: string): string {
  const index = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % GRADIENT_COLORS.length
  return GRADIENT_COLORS[index]
}

export default observer(function SharedWithMePage() {
  const router = useRouter()
  const { user, isAuthenticated } = useAuth()
  const workspaces = useWorkspaceCollection()
  const projects = useProjectCollection()
  const membersColl = useMemberCollection()
  const starredColl = useStarredProjectCollection()

  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('lastEdited')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [sortModalVisible, setSortModalVisible] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!isAuthenticated || !user?.id) return
    const load = async () => {
      setIsLoading(true)
      try {
        await Promise.all([
          workspaces.loadAll({}),
          projects.loadAll(),
          membersColl.loadAll({ userId: user.id }),
          starredColl.loadAll({ userId: user.id }),
        ])
      } catch {
        // non-critical
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [isAuthenticated, user?.id])

  // Workspaces where user is member but NOT owner
  const sharedWorkspaces = useMemo(() => {
    if (!user?.id) return []
    const userMembers = membersColl.all.filter((m: any) => m.userId === user.id)
    return workspaces.all.filter((ws: any) => {
      const membership = userMembers.find((m: any) => m.workspaceId === ws.id)
      return membership && membership.role !== 'owner'
    })
  }, [user?.id, membersColl.all, workspaces.all])

  const sharedWorkspaceIds = useMemo(
    () => new Set(sharedWorkspaces.map((ws: any) => ws.id)),
    [sharedWorkspaces]
  )

  const sharedProjects = useMemo(
    () => projects.all.filter((p: any) => sharedWorkspaceIds.has(p.workspaceId)),
    [projects.all, sharedWorkspaceIds]
  )

  const starredProjectIds = useMemo(() => {
    if (!user?.id) return new Set<string>()
    return new Set(
      starredColl.all
        .filter((s: any) => s.userId === user.id)
        .map((s: any) => s.projectId)
    )
  }, [user?.id, starredColl.all])

  const filteredProjects = useMemo(() => {
    let result = [...sharedProjects]

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(
        (p: any) =>
          p.name?.toLowerCase().includes(query) ||
          p.description?.toLowerCase().includes(query)
      )
    }

    result.sort((a: any, b: any) => {
      switch (sortBy) {
        case 'lastEdited':
          return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
        case 'dateCreated':
          return b.createdAt - a.createdAt
        case 'alphabetical':
          return (a.name || '').localeCompare(b.name || '')
        default:
          return 0
      }
    })
    return result
  }, [sharedProjects, searchQuery, sortBy])

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    readCollapsedFromStorage()
  )

  const toggleCollapsed = useCallback((workspaceId: string) => {
    setCollapsed((prev) => ({ ...prev, [workspaceId]: !prev[workspaceId] }))
  }, [])

  const roleByWorkspaceId = useMemo(() => {
    const out: Record<string, string> = {}
    if (!user?.id) return out
    for (const m of membersColl.all as any[]) {
      if (m.userId === user.id) out[m.workspaceId] = m.role
    }
    return out
  }, [user?.id, membersColl.all])

  const groups: SharedGroup[] = useMemo(() => {
    const byWs = new Map<string, SharedGroup>()
    for (const p of filteredProjects as any[]) {
      const ws = sharedWorkspaces.find((w: any) => w.id === p.workspaceId)
      if (!ws) continue
      let g = byWs.get(ws.id)
      if (!g) {
        g = {
          workspace: ws,
          role: roleByWorkspaceId[ws.id] || 'member',
          projects: [],
          latestUpdatedAt: 0,
        }
        byWs.set(ws.id, g)
      }
      g.projects.push(p)
      const t = p.updatedAt || p.createdAt || 0
      if (t > g.latestUpdatedAt) g.latestUpdatedAt = t
    }
    const arr = Array.from(byWs.values())
    if (sortBy === 'lastEdited') {
      arr.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt)
    } else if (sortBy === 'dateCreated') {
      arr.sort((a, b) => {
        const ac = a.workspace.createdAt || 0
        const bc = b.workspace.createdAt || 0
        return bc - ac
      })
    } else {
      arr.sort((a, b) =>
        (a.workspace.name || '').localeCompare(b.workspace.name || '')
      )
    }
    return arr
  }, [filteredProjects, sharedWorkspaces, roleByWorkspaceId, sortBy])

  const totalFiltered = filteredProjects.length
  const visibleGroupCount = groups.length

  // Persist collapse state to storage as a side effect (keeps the
  // setState updater pure). Also prune ids for workspaces that no
  // longer appear in `groups` so the payload doesn't grow forever.
  useEffect(() => {
    const validIds = new Set(groups.map((g) => g.workspace.id))
    const pruned: Record<string, boolean> = {}
    for (const [id, v] of Object.entries(collapsed)) {
      if (v && validIds.has(id)) pruned[id] = true
    }
    writeCollapsedToStorage(pruned)
  }, [collapsed, groups])

  const handleProjectPress = useCallback(
    (project: any) => {
      router.push(`/(app)/projects/${project.id}`)
    },
    [router]
  )

  const handleToggleStar = useCallback(
    async (project: any) => {
      if (!user?.id) return
      try {
        const isStarred = starredProjectIds.has(project.id)
        if (isStarred) {
          const entry = starredColl.all.find(
            (s: any) => s.userId === user.id && s.projectId === project.id
          )
          if (entry) await starredColl.delete(entry.id)
        } else {
          await starredColl.create({
            userId: user.id,
            projectId: project.id,
            workspaceId: project.workspaceId,
          })
        }
        await starredColl.loadAll({ userId: user.id })
      } catch {
        Alert.alert('Error', 'Failed to update star status')
      }
    },
    [user?.id, starredColl, starredProjectIds]
  )

  const sortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label || 'Sort'

  const renderGridItem = useCallback(
    ({ item: project }: { item: any }) => (
      <Pressable
        onPress={() => handleProjectPress(project)}
        className="flex-1 mx-1.5 mb-3 rounded-xl bg-card overflow-hidden border border-border"
      >
        <View
          style={{ aspectRatio: 16 / 9 }}
          className={cn('items-center justify-center', getPlaceholderColor(project.name || ''))}
        >
          <FolderOpen size={28} className="text-white/30" />
          {/* Star button */}
          <Pressable
            onPress={() => handleToggleStar(project)}
            className={cn(
              'absolute top-2 right-2 p-1.5 rounded-md',
              starredProjectIds.has(project.id)
                ? 'bg-yellow-500/90'
                : 'bg-black/30'
            )}
          >
            <Star
              size={14}
              className="text-white"
              fill={starredProjectIds.has(project.id) ? 'white' : 'transparent'}
            />
          </Pressable>
        </View>
        <View className="p-3">
          <View className="flex-row items-center gap-2">
            <View className="w-6 h-6 rounded-full bg-primary/10 items-center justify-center">
              <Text className="text-[10px] font-medium text-foreground">
                {user?.name?.charAt(0) || 'U'}
              </Text>
            </View>
            <View className="flex-1">
              <Text className="text-foreground text-sm font-medium" numberOfLines={1}>
                {project.name}
              </Text>
              <Text className="text-muted-foreground text-xs" numberOfLines={1}>
                {getTimeAgo(project.updatedAt || project.createdAt)}
              </Text>
            </View>
          </View>
        </View>
      </Pressable>
    ),
    [handleProjectPress, handleToggleStar, starredProjectIds, user?.name]
  )

  const renderListItem = useCallback(
    ({ item: project }: { item: any }) => (
      <Pressable
        onPress={() => handleProjectPress(project)}
        className="flex-row items-center px-4 py-3 border-b border-border"
      >
        <View
          className={cn(
            'w-12 h-8 rounded-md items-center justify-center mr-3 relative',
            getPlaceholderColor(project.name || '')
          )}
        >
          <FolderOpen size={16} className="text-white/50" />
        </View>
        <View className="flex-1 mr-3">
          <Text className="text-foreground text-sm font-medium" numberOfLines={1}>
            {project.name}
          </Text>
          <Text className="text-muted-foreground text-xs" numberOfLines={1}>
            {getTimeAgo(project.updatedAt || project.createdAt)}
          </Text>
        </View>
        <Pressable onPress={() => handleToggleStar(project)} className="p-2">
          <Star
            size={16}
            className={starredProjectIds.has(project.id) ? 'text-yellow-500' : 'text-muted-foreground'}
            fill={starredProjectIds.has(project.id) ? '#eab308' : 'transparent'}
          />
        </Pressable>
      </Pressable>
    ),
    [handleProjectPress, handleToggleStar, starredProjectIds]
  )

  const renderSectionHeader = useCallback(
    (group: SharedGroup) => {
      const isCollapsed = !!collapsed[group.workspace.id]
      const Chevron = isCollapsed ? ChevronRight : ChevronDown
      return (
        <Pressable
          onPress={() => toggleCollapsed(group.workspace.id)}
          accessibilityRole="button"
          accessibilityState={{ expanded: !isCollapsed }}
          className="flex-row items-center pl-3 pr-4 py-3 bg-muted/60 dark:bg-muted/40 border-y border-border border-l-2 border-l-primary/50 hover:bg-muted/80 dark:hover:bg-muted/60"
        >
          <View
            className={cn(
              'w-8 h-8 rounded-md items-center justify-center mr-3 ml-1',
              getPlaceholderColor(group.workspace.name || '')
            )}
          >
            <Text className="text-white text-sm font-semibold">
              {(group.workspace.name || '?').charAt(0).toUpperCase()}
            </Text>
          </View>
          <View className="flex-1 mr-3">
            <View className="flex-row items-center gap-2">
              <Text className="text-foreground text-[15px] font-semibold" numberOfLines={1}>
                {group.workspace.name || 'Untitled workspace'}
              </Text>
              <View className="bg-background border border-border rounded px-1.5 py-0.5">
                <Text className="text-muted-foreground text-[10px]">
                  {roleLabel(group.role)}
                </Text>
              </View>
            </View>
            <Text className="text-muted-foreground text-xs mt-0.5" numberOfLines={1}>
              {group.projects.length}{' '}
              {group.projects.length === 1 ? 'project' : 'projects'}
              {group.latestUpdatedAt
                ? ` · updated ${getTimeAgo(group.latestUpdatedAt)}`
                : ''}
            </Text>
          </View>
          <Chevron size={16} className="text-muted-foreground" />
        </Pressable>
      )
    },
    [collapsed, toggleCollapsed]
  )

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-4 pt-4 pb-2">
        <View className="flex-row items-center gap-2">
          <Users size={20} className="text-primary" />
          <Text className="text-foreground text-lg font-semibold">Shared with me</Text>
        </View>
        <Text className="text-muted-foreground text-sm mt-1">
          Projects from workspaces you've been invited to
        </Text>
        {!isLoading && totalFiltered > 0 && (
          <Text className="text-muted-foreground text-xs mt-1">
            {totalFiltered} {totalFiltered === 1 ? 'project' : 'projects'} across{' '}
            {visibleGroupCount} {visibleGroupCount === 1 ? 'workspace' : 'workspaces'}
          </Text>
        )}
      </View>

      {/* Filters Bar */}
      <View className="flex-row items-center gap-2 px-4 py-2 border-b border-border">
        <View className="flex-1 flex-row items-center bg-muted rounded-lg px-3 py-2">
          <Search size={16} className="text-muted-foreground mr-2" />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search shared..."
            placeholderTextColor="#9ca3af"
            className="flex-1 text-foreground text-sm"
          />
        </View>
        <Pressable
          onPress={() => setSortModalVisible(true)}
          className="flex-row items-center border border-border rounded-lg px-3 py-2"
        >
          <Text className="text-foreground text-xs mr-1">{sortLabel}</Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
        <View className="flex-row">
          <Pressable
            onPress={() => setViewMode('grid')}
            className={cn('p-2 rounded-l-lg border border-border', viewMode === 'grid' && 'bg-secondary')}
          >
            <LayoutGrid size={16} className={viewMode === 'grid' ? 'text-foreground' : 'text-muted-foreground'} />
          </Pressable>
          <Pressable
            onPress={() => setViewMode('list')}
            className={cn('p-2 rounded-r-lg border border-l-0 border-border', viewMode === 'list' && 'bg-secondary')}
          >
            <List size={16} className={viewMode === 'list' ? 'text-foreground' : 'text-muted-foreground'} />
          </Pressable>
        </View>
      </View>

      {/* Content */}
      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
        </View>
      ) : filteredProjects.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <View className="w-16 h-16 rounded-full bg-muted items-center justify-center mb-4">
            <Users size={32} className="text-muted-foreground/50" />
          </View>
          <Text className="text-foreground text-base font-medium mb-1">
            {searchQuery ? 'No results found' : 'No shared projects yet'}
          </Text>
          <Text className="text-muted-foreground text-sm text-center max-w-[300px]">
            {searchQuery
              ? `No shared projects match "${searchQuery}"`
              : 'Projects you are invited to will appear here. When someone adds you to their workspace, you\'ll see their projects here.'}
          </Text>
        </View>
      ) : (
        <FlatList
          key={`groups-${viewMode}`}
          data={groups}
          keyExtractor={(g) => g.workspace.id}
          contentContainerClassName="pb-8"
          renderItem={({ item: group }) => {
            const isCollapsed = !!collapsed[group.workspace.id]
            return (
              <View className="mb-2">
                {renderSectionHeader(group)}
                {!isCollapsed &&
                  (viewMode === 'grid' ? (
                    <View className="flex-row flex-wrap p-2.5">
                      {group.projects.map((p: any) => (
                        <View key={p.id} className="w-1/2">
                          {renderGridItem({ item: p })}
                        </View>
                      ))}
                    </View>
                  ) : (
                    <View>
                      {group.projects.map((p: any) => (
                        <View key={p.id}>{renderListItem({ item: p })}</View>
                      ))}
                    </View>
                  ))}
              </View>
            )
          }}
        />
      )}

      {/* Sort Modal */}
      <Modal visible={sortModalVisible} transparent animationType="fade" onRequestClose={() => setSortModalVisible(false)}>
        <Pressable onPress={() => setSortModalVisible(false)} className="flex-1 bg-black/50 justify-end">
          <View className="bg-background rounded-t-2xl p-4 pb-8">
            <Text className="text-foreground text-lg font-semibold mb-3">Sort by</Text>
            {SORT_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => {
                  setSortBy(option.value)
                  setSortModalVisible(false)
                }}
                className={cn(
                  'py-3 px-4 rounded-lg mb-1',
                  sortBy === option.value && 'bg-primary/10'
                )}
              >
                <Text
                  className={cn(
                    'text-sm',
                    sortBy === option.value
                      ? 'text-primary font-medium'
                      : 'text-foreground'
                  )}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  )
})
