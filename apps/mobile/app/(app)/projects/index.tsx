/**
 * AllProjectsPage - Projects listing (mobile)
 *
 * Features ported from web AllProjectsPage:
 * - Search bar for filtering projects
 * - Sort options (Last edited, Date created, Alphabetical)
 * - View toggle (Grid / List) using FlatList with numColumns
 * - Project cards navigate to /projects/[id]
 * - Star / unstar projects
 * - Project action menu (rename, delete)
 * - Folder navigation with breadcrumbs
 * - Empty states for no projects / no results
 *
 * Mobile-specific changes:
 * - FlatList instead of CSS grid
 * - Pressable instead of button/a
 * - expo-router instead of react-router-dom
 * - lucide-react-native instead of lucide-react
 * - No drag-and-drop (not practical on mobile)
 * - No multi-select mode (simplify for touch UX)
 * - Modal sheets instead of dropdown menus for actions
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  useWindowDimensions,
  Alert,
} from 'react-native'
import { observer } from 'mobx-react-lite'
import { useRouter } from 'expo-router'
import { formatDistanceToNow } from 'date-fns'
import {
  Search,
  Plus,
  Star,
  MoreHorizontal,
  LayoutGrid,
  List,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  FolderOpen,
} from 'lucide-react-native'
import {
  useSDKDomain,
  useSDKReady,
  useDomainActions,
} from '@shogo/shared-app/domain'
import type { IDomainStore } from '@shogo/domain-stores'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../../contexts/auth'

// Types
type SortBy = 'lastEdited' | 'dateCreated' | 'alphabetical'
type ViewMode = 'grid' | 'list'

interface Project {
  id: string
  name: string
  description?: string
  createdAt: number
  updatedAt?: number
  status?: string
  starred?: boolean
  folderId?: string | null
}

interface Folder {
  id: string
  name: string
  parentId?: string | null
  createdAt: number
  updatedAt?: number
}

function getTimeAgo(timestamp: number): string {
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true })
}

const GRADIENT_CLASSES = [
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
  const index =
    name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % GRADIENT_CLASSES.length
  return GRADIENT_CLASSES[index]
}

export default observer(function AllProjectsPage() {
  const router = useRouter()
  const { user } = useAuth()
  const store = useSDKDomain() as IDomainStore
  const sdkReady = useSDKReady()
  const actions = useDomainActions()
  const { width } = useWindowDimensions()

  // State
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('lastEdited')
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [starredIds, setStarredIds] = useState<Set<string>>(new Set())
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Determine grid columns based on screen width
  const numColumns = viewMode === 'grid' ? (width >= 768 ? 3 : 2) : 1

  // Find current workspace
  const workspaces = store?.workspaceCollection?.all ?? []
  const currentWorkspace = workspaces[0] ?? null

  // Load data
  useEffect(() => {
    if (!sdkReady || !store || !user?.id) return

    store.workspaceCollection.loadAll({ userId: user.id }).catch((err: any) =>
      console.warn('[AllProjectsPage] Failed to load workspaces:', err),
    )
  }, [sdkReady, store, user?.id])

  useEffect(() => {
    if (!currentWorkspace?.id || !store) return

    store.projectCollection.loadAll({ workspaceId: currentWorkspace.id }).catch((err: any) =>
      console.warn('[AllProjectsPage] Failed to load projects:', err),
    )
    store.folderCollection?.loadAll({ workspaceId: currentWorkspace.id }).catch((err: any) =>
      console.warn('[AllProjectsPage] Failed to load folders:', err),
    )
  }, [currentWorkspace?.id, store])

  // Load starred projects
  useEffect(() => {
    if (!currentWorkspace?.id || !store?.starredProjectCollection) return

    store.starredProjectCollection
      .loadAll({ workspaceId: currentWorkspace.id })
      .then(() => {
        const ids = new Set(
          store.starredProjectCollection.all
            .filter((s: any) => s.workspaceId === currentWorkspace.id)
            .map((s: any) => s.projectId),
        )
        setStarredIds(ids)
      })
      .catch(() => {})
  }, [currentWorkspace?.id, store])

  const allProjects = (store?.projectCollection?.all ?? []) as Project[]
  const allFolders = (store?.folderCollection?.all ?? []) as Folder[]

  // Folders in current location
  const currentFolders = useMemo(() => {
    let result = allFolders.filter((f) =>
      currentFolderId ? f.parentId === currentFolderId : !f.parentId,
    )
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter((f) => f.name.toLowerCase().includes(q))
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }, [allFolders, currentFolderId, searchQuery])

  // Current folder object
  const currentFolder = currentFolderId
    ? allFolders.find((f) => f.id === currentFolderId) ?? null
    : null

  // Filtered & sorted projects
  const filteredProjects = useMemo(() => {
    let result = [...allProjects].filter((p) =>
      currentFolderId ? p.folderId === currentFolderId : !p.folderId,
    )

    // Filter by workspace
    if (currentWorkspace?.id) {
      result = result.filter((p: any) => p.workspaceId === currentWorkspace.id)
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (p) => p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q),
      )
    }

    result.sort((a, b) => {
      switch (sortBy) {
        case 'lastEdited':
          return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
        case 'dateCreated':
          return b.createdAt - a.createdAt
        case 'alphabetical':
          return a.name.localeCompare(b.name)
      }
    })

    return result
  }, [allProjects, currentFolderId, currentWorkspace?.id, searchQuery, sortBy])

  // Handlers
  const handleProjectPress = useCallback(
    (project: Project) => {
      router.push(`/(app)/projects/${project.id}` as any)
    },
    [router],
  )

  const handleCreateProject = useCallback(() => {
    router.push('/(app)/' as any)
  }, [router])

  const handleToggleStar = useCallback(
    async (projectId: string) => {
      if (!currentWorkspace?.id) return
      try {
        const isStarred = starredIds.has(projectId)
        if (isStarred) {
          const starRecord = store?.starredProjectCollection?.all.find(
            (s: any) => s.projectId === projectId && s.workspaceId === currentWorkspace.id,
          )
          if (starRecord) {
            await store.starredProjectCollection.delete(starRecord.id)
          }
          setStarredIds((prev) => {
            const next = new Set(prev)
            next.delete(projectId)
            return next
          })
        } else {
          await store?.starredProjectCollection?.create({
            projectId,
            workspaceId: currentWorkspace.id,
          })
          setStarredIds((prev) => new Set(prev).add(projectId))
        }
      } catch (err) {
        console.error('[AllProjectsPage] Failed to toggle star:', err)
      }
    },
    [currentWorkspace?.id, starredIds, store],
  )

  const handleRenameProject = useCallback(
    (project: Project) => {
      Alert.prompt(
        'Rename project',
        'Enter a new name',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Rename',
            onPress: async (newName) => {
              if (!newName?.trim()) return
              try {
                await actions.updateProject(project.id, { name: newName.trim() })
                store?.projectCollection
                  ?.loadAll({ workspaceId: currentWorkspace?.id })
                  .catch(() => {})
              } catch (err) {
                console.error('[AllProjectsPage] Rename failed:', err)
              }
            },
          },
        ],
        'plain-text',
        project.name,
      )
    },
    [actions, store, currentWorkspace?.id],
  )

  const handleDeleteProject = useCallback(
    (project: Project) => {
      Alert.alert('Delete project', `Are you sure you want to delete "${project.name}"?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await actions.deleteProject(project.id)
              store?.projectCollection
                ?.loadAll({ workspaceId: currentWorkspace?.id })
                .catch(() => {})
            } catch (err) {
              console.error('[AllProjectsPage] Delete failed:', err)
            }
          },
        },
      ])
    },
    [actions, store, currentWorkspace?.id],
  )

  const handleProjectActions = useCallback(
    (project: Project) => {
      const options = ['Rename', 'Delete', 'Cancel']
      Alert.alert(project.name, undefined, [
        { text: 'Rename', onPress: () => handleRenameProject(project) },
        { text: 'Delete', style: 'destructive', onPress: () => handleDeleteProject(project) },
        { text: 'Cancel', style: 'cancel' },
      ])
    },
    [handleRenameProject, handleDeleteProject],
  )

  const handleFolderPress = useCallback((folder: Folder) => {
    setCurrentFolderId(folder.id)
  }, [])

  const handleBackToRoot = useCallback(() => {
    setCurrentFolderId(null)
  }, [])

  const handleRefresh = useCallback(async () => {
    if (!currentWorkspace?.id || !store) return
    setIsRefreshing(true)
    try {
      await store.projectCollection.loadAll({ workspaceId: currentWorkspace.id })
      await store.folderCollection?.loadAll({ workspaceId: currentWorkspace.id })
    } catch (err) {
      console.warn('[AllProjectsPage] Refresh failed:', err)
    } finally {
      setIsRefreshing(false)
    }
  }, [currentWorkspace?.id, store])

  const sortLabel =
    sortBy === 'lastEdited'
      ? 'Last edited'
      : sortBy === 'dateCreated'
        ? 'Date created'
        : 'Alphabetical'

  // Sort menu options
  const handleSortPress = useCallback(() => {
    Alert.alert('Sort by', undefined, [
      {
        text: 'Last edited',
        onPress: () => setSortBy('lastEdited'),
      },
      {
        text: 'Date created',
        onPress: () => setSortBy('dateCreated'),
      },
      {
        text: 'Alphabetical',
        onPress: () => setSortBy('alphabetical'),
      },
      { text: 'Cancel', style: 'cancel' },
    ])
  }, [])

  // Build combined data for FlatList (folders first, then projects)
  type ListItem =
    | { type: 'create' }
    | { type: 'folder'; data: Folder }
    | { type: 'project'; data: Project }

  const listData = useMemo((): ListItem[] => {
    const items: ListItem[] = [{ type: 'create' }]
    currentFolders.forEach((f) => items.push({ type: 'folder', data: f }))
    filteredProjects.forEach((p) => items.push({ type: 'project', data: p }))
    return items
  }, [currentFolders, filteredProjects])

  const renderGridItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.type === 'create') {
        return (
          <Pressable
            onPress={handleCreateProject}
            className="flex-1 m-1.5 rounded-xl border-2 border-dashed border-muted-foreground/20 overflow-hidden"
          >
            <View className="aspect-[16/10] items-center justify-center bg-muted/30">
              <View className="w-10 h-10 rounded-full bg-muted items-center justify-center">
                <Plus size={20} className="text-muted-foreground" />
              </View>
            </View>
            <View className="p-3 items-center">
              <Text className="text-sm text-muted-foreground">Create new project</Text>
            </View>
          </Pressable>
        )
      }

      if (item.type === 'folder') {
        const folder = item.data
        const projectCount = allProjects.filter((p) => p.folderId === folder.id).length
        return (
          <Pressable
            onPress={() => handleFolderPress(folder)}
            className="flex-1 m-1.5 rounded-xl bg-card overflow-hidden"
          >
            <View className="aspect-[16/10] bg-muted items-center justify-center">
              <FolderOpen size={48} className="text-muted-foreground/40" />
            </View>
            <View className="p-3">
              <Text className="font-medium text-sm text-foreground" numberOfLines={1}>
                {folder.name}
              </Text>
              <Text className="text-xs text-muted-foreground mt-0.5">
                {projectCount} project{projectCount !== 1 ? 's' : ''}
              </Text>
            </View>
          </Pressable>
        )
      }

      // Project card
      const project = item.data
      const isStarred = starredIds.has(project.id)
      return (
        <Pressable
          onPress={() => handleProjectPress(project)}
          onLongPress={() => handleProjectActions(project)}
          className="flex-1 m-1.5 rounded-xl bg-card overflow-hidden"
        >
          {/* Color banner */}
          <View className={cn('aspect-[16/10] items-center justify-center', getPlaceholderColor(project.name))}>
            <FolderOpen size={40} color="rgba(255,255,255,0.3)" />

            {/* Star button */}
            <Pressable
              onPress={() => handleToggleStar(project.id)}
              className={cn(
                'absolute top-2 right-2 p-1.5 rounded-md',
                isStarred ? 'bg-yellow-500/90' : 'bg-black/30',
              )}
            >
              <Star
                size={14}
                color="#fff"
                fill={isStarred ? '#fff' : 'transparent'}
              />
            </Pressable>
          </View>

          {/* Info */}
          <View className="flex-row items-start gap-2.5 p-3">
            <View className="w-6 h-6 rounded-full bg-primary/10 items-center justify-center">
              <Text className="text-[10px] font-medium text-foreground">
                {user?.name?.charAt(0) || 'U'}
              </Text>
            </View>
            <View className="flex-1 min-w-0">
              <Text className="font-medium text-sm text-foreground" numberOfLines={1}>
                {project.name}
              </Text>
              <Text className="text-xs text-muted-foreground mt-0.5">
                Edited {getTimeAgo(project.updatedAt || project.createdAt)}
              </Text>
            </View>
            <Pressable
              onPress={() => handleProjectActions(project)}
              className="w-6 h-6 items-center justify-center"
            >
              <MoreHorizontal size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
        </Pressable>
      )
    },
    [
      allProjects,
      handleCreateProject,
      handleFolderPress,
      handleProjectPress,
      handleProjectActions,
      handleToggleStar,
      starredIds,
      user?.name,
    ],
  )

  const renderListItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.type === 'create') {
        return (
          <Pressable
            onPress={handleCreateProject}
            className="flex-row items-center gap-3 px-4 py-3 border-b border-border/50"
          >
            <View className="w-12 h-8 rounded-md bg-muted items-center justify-center">
              <Plus size={16} className="text-muted-foreground" />
            </View>
            <Text className="text-sm text-muted-foreground">Create new project</Text>
          </Pressable>
        )
      }

      if (item.type === 'folder') {
        const folder = item.data
        const projectCount = allProjects.filter((p) => p.folderId === folder.id).length
        return (
          <Pressable
            onPress={() => handleFolderPress(folder)}
            className="flex-row items-center gap-3 px-4 py-3 border-b border-border/50"
          >
            <View className="w-12 h-8 rounded-md bg-muted items-center justify-center">
              <FolderOpen size={16} className="text-muted-foreground" />
            </View>
            <View className="flex-1 min-w-0">
              <Text className="font-medium text-sm text-foreground" numberOfLines={1}>
                {folder.name}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {projectCount} project{projectCount !== 1 ? 's' : ''}
              </Text>
            </View>
          </Pressable>
        )
      }

      const project = item.data
      const isStarred = starredIds.has(project.id)
      return (
        <Pressable
          onPress={() => handleProjectPress(project)}
          onLongPress={() => handleProjectActions(project)}
          className="flex-row items-center gap-3 px-4 py-3 border-b border-border/50"
        >
          {/* Thumbnail */}
          <View
            className={cn(
              'w-12 h-8 rounded-md items-center justify-center',
              getPlaceholderColor(project.name),
            )}
          >
            <FolderOpen size={16} color="rgba(255,255,255,0.5)" />
          </View>

          {/* Details */}
          <View className="flex-1 min-w-0">
            <Text className="font-medium text-sm text-foreground" numberOfLines={1}>
              {project.name}
            </Text>
            <Text className="text-xs text-muted-foreground">
              Edited {getTimeAgo(project.updatedAt || project.createdAt)}
            </Text>
          </View>

          {/* Star */}
          <Pressable onPress={() => handleToggleStar(project.id)} className="p-2">
            <Star
              size={16}
              className={isStarred ? 'text-yellow-500' : 'text-muted-foreground'}
              fill={isStarred ? '#eab308' : 'transparent'}
            />
          </Pressable>

          {/* Menu */}
          <Pressable onPress={() => handleProjectActions(project)} className="p-2">
            <MoreHorizontal size={16} className="text-muted-foreground" />
          </Pressable>
        </Pressable>
      )
    },
    [
      allProjects,
      handleCreateProject,
      handleFolderPress,
      handleProjectPress,
      handleProjectActions,
      handleToggleStar,
      starredIds,
    ],
  )

  // Empty states
  const ListEmptyComponent = useMemo(() => {
    if (listData.length > 1) return null

    if (searchQuery) {
      return (
        <View className="items-center justify-center py-20">
          <View className="w-16 h-16 rounded-full bg-muted items-center justify-center mb-4">
            <Search size={32} className="text-muted-foreground/50" />
          </View>
          <Text className="text-base font-medium text-foreground mb-1">No results found</Text>
          <Text className="text-sm text-muted-foreground text-center">
            No projects match "{searchQuery}"
          </Text>
        </View>
      )
    }

    return (
      <View className="items-center justify-center py-20">
        <View className="w-16 h-16 rounded-full bg-muted items-center justify-center mb-4">
          <FolderOpen size={32} className="text-muted-foreground/50" />
        </View>
        <Text className="text-base font-medium text-foreground mb-1">No projects yet</Text>
        <Text className="text-sm text-muted-foreground mb-4 text-center">
          Create your first project to get started
        </Text>
        <Pressable
          onPress={handleCreateProject}
          className="flex-row items-center gap-2 bg-primary px-4 py-2 rounded-lg"
        >
          <Plus size={16} color="#fff" />
          <Text className="text-sm font-medium text-primary-foreground">Create project</Text>
        </Pressable>
      </View>
    )
  }, [searchQuery, handleCreateProject, listData.length])

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-4 pt-3 pb-1">
        <Text className="text-lg font-semibold text-foreground">Projects</Text>
      </View>

      {/* Breadcrumb navigation */}
      {currentFolder && (
        <View className="flex-row items-center gap-1 px-4 py-2 border-b border-border">
          <Pressable
            onPress={handleBackToRoot}
            className="flex-row items-center gap-1 px-2 py-1 rounded-md"
          >
            <ArrowLeft size={14} className="text-muted-foreground" />
            <Text className="text-sm text-muted-foreground">All Projects</Text>
          </Pressable>
          <ChevronRight size={14} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-foreground px-2">{currentFolder.name}</Text>
        </View>
      )}

      {/* Filters bar */}
      <View className="px-4 py-2 gap-2">
        {/* Search */}
        <View className="flex-row items-center bg-card border border-input rounded-lg px-3">
          <Search size={16} className="text-muted-foreground" />
          <TextInput
            className="flex-1 h-9 ml-2 text-sm text-foreground"
            placeholder="Search projects..."
            placeholderTextColor="#71717a"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {/* Sort + View toggle row */}
        <View className="flex-row items-center justify-between">
          {/* Sort button */}
          <Pressable
            onPress={handleSortPress}
            className="flex-row items-center gap-1 px-3 py-1.5 rounded-lg border border-input"
          >
            <Text className="text-xs text-foreground">{sortLabel}</Text>
            <ChevronDown size={14} className="text-muted-foreground" />
          </Pressable>

          {/* View toggle */}
          <View className="flex-row items-center gap-1">
            <Pressable
              onPress={() => setViewMode('grid')}
              className={cn(
                'w-8 h-8 items-center justify-center rounded-lg',
                viewMode === 'grid' ? 'bg-secondary' : 'bg-transparent',
              )}
            >
              <LayoutGrid
                size={16}
                className={viewMode === 'grid' ? 'text-foreground' : 'text-muted-foreground'}
              />
            </Pressable>
            <Pressable
              onPress={() => setViewMode('list')}
              className={cn(
                'w-8 h-8 items-center justify-center rounded-lg',
                viewMode === 'list' ? 'bg-secondary' : 'bg-transparent',
              )}
            >
              <List
                size={16}
                className={viewMode === 'list' ? 'text-foreground' : 'text-muted-foreground'}
              />
            </Pressable>
          </View>
        </View>
      </View>

      {/* Content */}
      {viewMode === 'grid' ? (
        <FlatList
          key={`grid-${numColumns}`}
          data={listData}
          keyExtractor={(item, index) =>
            item.type === 'create'
              ? 'create'
              : item.type === 'folder'
                ? `folder-${item.data.id}`
                : `project-${item.data.id}`
          }
          renderItem={renderGridItem}
          numColumns={numColumns}
          contentContainerStyle={{ padding: 4 }}
          onRefresh={handleRefresh}
          refreshing={isRefreshing}
          ListEmptyComponent={
            filteredProjects.length === 0 && currentFolders.length === 0
              ? ListEmptyComponent
              : null
          }
        />
      ) : (
        <FlatList
          key="list-1"
          data={listData}
          keyExtractor={(item, index) =>
            item.type === 'create'
              ? 'create'
              : item.type === 'folder'
                ? `folder-${item.data.id}`
                : `project-${item.data.id}`
          }
          renderItem={renderListItem}
          onRefresh={handleRefresh}
          refreshing={isRefreshing}
          ListEmptyComponent={
            filteredProjects.length === 0 && currentFolders.length === 0
              ? ListEmptyComponent
              : null
          }
        />
      )}
    </View>
  )
})
