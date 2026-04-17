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
  StarOff,
  FolderOpen,
  X,
  Pencil,
  Trash2,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import { useAuth } from '../../contexts/auth'
import {
  useWorkspaceCollection,
  useProjectCollection,
  useStarredProjectCollection,
  useDomainActions,
} from '../../contexts/domain'

type SortBy = 'starredAt' | 'lastEdited' | 'alphabetical'
type ViewMode = 'grid' | 'list'

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'starredAt', label: 'Recently starred' },
  { value: 'lastEdited', label: 'Last edited' },
  { value: 'alphabetical', label: 'Alphabetical' },
]

function getTimeAgo(timestamp: number): string {
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true })
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

export default observer(function StarredProjectsPage() {
  const router = useRouter()
  const { user, isAuthenticated } = useAuth()
  const workspaces = useWorkspaceCollection()
  const projects = useProjectCollection()
  const starredColl = useStarredProjectCollection()

  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('starredAt')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [sortModalVisible, setSortModalVisible] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null)
  const [renameProject, setRenameProject] = useState<any>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteProject, setDeleteProject] = useState<any>(null)

  const actions = useDomainActions()

  useEffect(() => {
    if (!isAuthenticated || !user?.id) return
    const load = async () => {
      setIsLoading(true)
      try {
        await Promise.all([
          workspaces.loadAll({}),
          projects.loadAll(),
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

  const starredEntries = useMemo(() => {
    if (!user?.id) return []
    return starredColl.all
      .filter((s: any) => s.userId === user.id)
      .filter((entry: any) => projects.all.some((p: any) => p.id === entry.projectId))
  }, [user?.id, starredColl.all, projects.all])

  const getProject = useCallback(
    (projectId: string) => projects.all.find((p: any) => p.id === projectId),
    [projects.all],
  )

  const filteredEntries = useMemo(() => {
    let result = [...starredEntries]

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter((entry: any) => {
        const p = getProject(entry.projectId)
        return (
          p?.name?.toLowerCase().includes(query) ||
          p?.description?.toLowerCase().includes(query)
        )
      })
    }

    result.sort((a: any, b: any) => {
      const pa = getProject(a.projectId)
      const pb = getProject(b.projectId)
      switch (sortBy) {
        case 'starredAt':
          return (b.createdAt || 0) - (a.createdAt || 0)
        case 'lastEdited':
          return ((pb?.updatedAt || pb?.createdAt) || 0) - ((pa?.updatedAt || pa?.createdAt) || 0)
        case 'alphabetical':
          return (pa?.name || '').localeCompare(pb?.name || '')
        default:
          return 0
      }
    })
    return result
  }, [starredEntries, searchQuery, sortBy, getProject])

  const getWorkspaceName = useCallback(
    (wsId: string) => {
      const ws = workspaces.all.find((w: any) => w.id === wsId)
      return ws?.name || 'Unknown workspace'
    },
    [workspaces.all]
  )

  const handleProjectPress = useCallback(
    (project: any) => {
      router.push(`/(app)/projects/${project.id}`)
    },
    [router]
  )

  const handleUnstar = useCallback(
    async (entry: any) => {
      try {
        await starredColl.delete(entry.id)
        if (user?.id) {
          await starredColl.loadAll({ userId: user.id })
        }
      } catch {
        Alert.alert('Error', 'Failed to remove from starred')
      }
    },
    [starredColl, user?.id]
  )

  const handleRename = useCallback(
    (project: any) => {
      setMenuProjectId(null)
      setRenameValue(project.name || '')
      setRenameProject(project)
    },
    [],
  )

  const confirmRename = useCallback(async () => {
    if (!renameProject || !renameValue.trim()) return
    const projectId = renameProject.id
    const newName = renameValue.trim()
    setRenameProject(null)
    try {
      await actions.updateProject(projectId, { name: newName })
      await Promise.all([
        projects.loadAll(),
        user?.id ? starredColl.loadAll({ userId: user.id }) : Promise.resolve(),
      ])
    } catch {
      Alert.alert('Error', 'Failed to rename project')
    }
  }, [renameProject, renameValue, actions, projects, starredColl, user?.id])

  const handleDelete = useCallback(
    (project: any) => {
      setMenuProjectId(null)
      setDeleteProject(project)
    },
    [],
  )

  const confirmDelete = useCallback(async () => {
    if (!deleteProject) return
    const projectId = deleteProject.id
    setDeleteProject(null)
    try {
      await actions.deleteProject(projectId)
      await projects.loadAll()
      if (user?.id) {
        await starredColl.loadAll({ userId: user.id })
      }
    } catch {
      Alert.alert('Error', 'Failed to delete project')
    }
  }, [deleteProject, actions, projects, starredColl, user?.id])

  const sortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label || 'Sort'

  const renderGridItem = useCallback(
    ({ item: entry }: { item: any }) => {
      const project = getProject(entry.projectId)
      if (!project) return null
      return (
        <Pressable
          onPress={() => handleProjectPress(project)}
          className="flex-1 mx-1.5 mb-3 rounded-xl bg-card overflow-hidden border border-border"
        >
          <View className={cn('aspect-video items-center justify-center', getPlaceholderColor(project.name || ''))}>
            <FolderOpen size={28} className="text-white/30" />
            <Pressable
              onPress={() => handleUnstar(entry)}
              className="absolute top-2 right-2 p-1.5 rounded-md bg-yellow-500/90"
            >
              <Star size={14} className="text-white" fill="white" />
            </Pressable>
            <View className="absolute top-2 left-2">
              <Popover
                placement="bottom left"
                isOpen={menuProjectId === project.id}
                onOpen={() => setMenuProjectId(project.id)}
                onClose={() => setMenuProjectId(null)}
                trigger={(triggerProps) => (
                  <Pressable
                    {...triggerProps}
                    onPress={(e) => {
                      e.stopPropagation()
                      setMenuProjectId((prev) => (prev === project.id ? null : project.id))
                    }}
                    className="p-1.5 rounded-md bg-black/30"
                    accessibilityLabel="Project actions"
                  >
                    <MoreHorizontal size={14} className="text-white" />
                  </Pressable>
                )}
              >
                <PopoverBackdrop />
                <PopoverContent className="p-0 min-w-[150px]">
                  <PopoverBody>
                    <Pressable
                      onPress={() => {
                        setMenuProjectId(null)
                        handleUnstar(entry)
                      }}
                      className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                    >
                      <StarOff size={14} className="text-muted-foreground" />
                      <Text className="text-sm text-foreground">Unstar</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => handleRename(project)}
                      className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                    >
                      <Pencil size={14} className="text-muted-foreground" />
                      <Text className="text-sm text-foreground">Rename</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => handleDelete(project)}
                      className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                    >
                      <Trash2 size={14} className="text-destructive" />
                      <Text className="text-sm text-destructive">Delete</Text>
                    </Pressable>
                  </PopoverBody>
                </PopoverContent>
              </Popover>
            </View>
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
                  {getWorkspaceName(entry.workspaceId)}
                </Text>
              </View>
            </View>
          </View>
        </Pressable>
      )
    },
    [handleProjectPress, handleUnstar, handleRename, handleDelete, getProject, getWorkspaceName, user?.name, menuProjectId]
  )

  const renderListItem = useCallback(
    ({ item: entry }: { item: any }) => {
      const project = getProject(entry.projectId)
      if (!project) return null
      return (
        <Pressable
          onPress={() => handleProjectPress(project)}
          className="flex-row items-center px-4 py-3 border-b border-border"
        >
          <View
            className={cn(
              'w-12 h-8 rounded-md items-center justify-center mr-3',
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
              {getWorkspaceName(entry.workspaceId)} · Edited{' '}
              {getTimeAgo(project.updatedAt || project.createdAt)}
            </Text>
          </View>
          <Pressable onPress={() => handleUnstar(entry)} className="p-2 mr-1">
            <Star size={16} className="text-yellow-500" fill="#eab308" />
          </Pressable>
          <Popover
            placement="bottom right"
            isOpen={menuProjectId === project.id}
            onOpen={() => setMenuProjectId(project.id)}
            onClose={() => setMenuProjectId(null)}
            trigger={(triggerProps) => (
              <Pressable
                {...triggerProps}
                onPress={(e) => {
                  e.stopPropagation()
                  setMenuProjectId((prev) => (prev === project.id ? null : project.id))
                }}
                className="p-2"
                accessibilityLabel="Project actions"
              >
                <MoreHorizontal size={16} className="text-muted-foreground" />
              </Pressable>
            )}
          >
            <PopoverBackdrop />
            <PopoverContent className="p-0 min-w-[150px]">
              <PopoverBody>
                <Pressable
                  onPress={() => {
                    setMenuProjectId(null)
                    handleUnstar(entry)
                  }}
                  className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                >
                  <StarOff size={14} className="text-muted-foreground" />
                  <Text className="text-sm text-foreground">Unstar</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleRename(project)}
                  className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                >
                  <Pencil size={14} className="text-muted-foreground" />
                  <Text className="text-sm text-foreground">Rename</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleDelete(project)}
                  className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                >
                  <Trash2 size={14} className="text-destructive" />
                  <Text className="text-sm text-destructive">Delete</Text>
                </Pressable>
              </PopoverBody>
            </PopoverContent>
          </Popover>
        </Pressable>
      )
    },
    [handleProjectPress, handleUnstar, handleRename, handleDelete, getProject, getWorkspaceName, menuProjectId]
  )

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-4 pt-4 pb-2">
        <View className="flex-row items-center gap-2">
          <Star size={20} className="text-yellow-500" fill="#eab308" />
          <Text className="text-foreground text-lg font-semibold">Starred Projects</Text>
        </View>
        <Text className="text-muted-foreground text-sm mt-1">
          Quick access to your favorite projects across all workspaces
        </Text>
      </View>

      {/* Filters Bar */}
      <View className="flex-row items-center gap-2 px-4 py-2 border-b border-border">
        <View className="flex-1 flex-row items-center bg-muted rounded-lg px-3 py-2">
          <Search size={16} className="text-muted-foreground mr-2" />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search starred..."
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
      ) : filteredEntries.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <View className="w-16 h-16 rounded-full bg-muted items-center justify-center mb-4">
            <Star size={32} className="text-muted-foreground/50" />
          </View>
          <Text className="text-foreground text-base font-medium mb-1">
            {searchQuery ? 'No results found' : 'No starred projects yet'}
          </Text>
          <Text className="text-muted-foreground text-sm text-center max-w-[300px]">
            {searchQuery
              ? `No starred projects match "${searchQuery}"`
              : 'Star projects to access them quickly. Tap the star icon on any project to add it here.'}
          </Text>
        </View>
      ) : viewMode === 'grid' ? (
        <FlatList
          key="grid-2"
          data={filteredEntries}
          keyExtractor={(item: any) => item.id}
          numColumns={2}
          contentContainerClassName="p-2.5 pt-4"
          renderItem={renderGridItem}
        />
      ) : (
        <FlatList
          key="list-1"
          data={filteredEntries}
          keyExtractor={(item: any) => item.id}
          renderItem={renderListItem}
        />
      )}

      {/* Sort Modal */}
      <Modal visible={sortModalVisible} transparent animationType="fade" onRequestClose={() => setSortModalVisible(false)}>
        <Pressable onPress={() => setSortModalVisible(false)} className="flex-1 bg-black/50 justify-end">
          <View className="bg-background rounded-t-2xl p-4 pb-8">
            <View className="flex-row items-center justify-between mb-3">
              <Text className="text-foreground text-lg font-semibold">Sort by</Text>
              <Pressable onPress={() => setSortModalVisible(false)} className="p-1">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
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

      {/* Rename Modal */}
      <Modal
        visible={!!renameProject}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameProject(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setRenameProject(null)}
        >
          <Pressable
            className="bg-card rounded-xl p-6 w-80 border border-border"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="flex-row items-center justify-between mb-1">
              <Text className="text-base font-semibold text-foreground">Rename project</Text>
              <Pressable onPress={() => setRenameProject(null)} className="p-1">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
            <Text className="text-sm text-muted-foreground mb-4">
              Enter a new name for this project
            </Text>
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="Project name"
              placeholderTextColor="#9ca3af"
              className="border border-border rounded-md px-3 py-2 text-sm text-foreground bg-background mb-4"
              autoFocus
              onSubmitEditing={confirmRename}
              selectTextOnFocus
            />
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setRenameProject(null)}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmRename}
                className={cn(
                  'px-4 py-2 rounded-md',
                  renameValue.trim() ? 'bg-primary active:bg-primary/80' : 'bg-muted'
                )}
                disabled={!renameValue.trim()}
              >
                <Text className={cn(
                  'text-sm',
                  renameValue.trim() ? 'text-primary-foreground' : 'text-muted-foreground'
                )}>
                  Rename
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={!!deleteProject}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteProject(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setDeleteProject(null)}
        >
          <Pressable
            className="bg-card rounded-xl p-6 w-80 border border-border"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="flex-row items-center gap-3 mb-3">
              <View className="w-10 h-10 rounded-full bg-destructive/10 items-center justify-center">
                <Trash2 size={20} className="text-destructive" />
              </View>
              <Text className="text-base font-semibold text-foreground">Delete project</Text>
            </View>
            <Text className="text-sm text-muted-foreground mb-5">
              Are you sure you want to delete &quot;{deleteProject?.name}&quot;? This action cannot be undone.
            </Text>
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setDeleteProject(null)}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmDelete}
                className="px-4 py-2 rounded-md bg-destructive active:bg-destructive/80"
              >
                <Text className="text-sm text-white font-medium">Delete</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  )
})
