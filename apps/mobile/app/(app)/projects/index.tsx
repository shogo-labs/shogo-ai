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
  Modal,
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
  FolderPlus,
  CheckSquare,
  Check,
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

  type VisibilityFilter = 'any' | 'public' | 'private'
  type StatusFilter = 'any' | 'draft' | 'published'

  // State
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('lastEdited')
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [starredIds, setStarredIds] = useState<Set<string>>(new Set())
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('any')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('any')
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [newFolderModalVisible, setNewFolderModalVisible] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [showSortMenu, setShowSortMenu] = useState(false)
  const [showVisibilityMenu, setShowVisibilityMenu] = useState(false)
  const [showStatusMenu, setShowStatusMenu] = useState(false)

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

    if (currentWorkspace?.id) {
      result = result.filter((p: any) => p.workspaceId === currentWorkspace.id)
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (p) => p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q),
      )
    }

    if (visibilityFilter !== 'any') {
      result = result.filter((p: any) => {
        const access = p.accessLevel || 'anyone'
        return visibilityFilter === 'public' ? access === 'anyone' : access !== 'anyone'
      })
    }

    if (statusFilter !== 'any') {
      result = result.filter((p) => p.status === statusFilter)
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
  }, [allProjects, currentFolderId, currentWorkspace?.id, searchQuery, sortBy, visibilityFilter, statusFilter])

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
            onPress: async (newName?: string) => {
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

  const handleSortPress = useCallback(() => {
    setShowSortMenu((v) => !v)
    setShowVisibilityMenu(false)
    setShowStatusMenu(false)
  }, [])

  const handleVisibilityFilter = useCallback(() => {
    setShowVisibilityMenu((v) => !v)
    setShowSortMenu(false)
    setShowStatusMenu(false)
  }, [])

  const handleStatusFilter = useCallback(() => {
    setShowStatusMenu((v) => !v)
    setShowSortMenu(false)
    setShowVisibilityMenu(false)
  }, [])

  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim()
    if (!name || !currentWorkspace?.id) return
    try {
      await actions.createFolder(name, currentWorkspace.id, currentFolderId)
      store?.folderCollection?.loadAll({ workspaceId: currentWorkspace.id }).catch(() => {})
    } catch (err) {
      console.error('[AllProjectsPage] Failed to create folder:', err)
    }
    setNewFolderName('')
    setNewFolderModalVisible(false)
  }, [newFolderName, currentWorkspace?.id, currentFolderId, actions, store])

  const handleToggleSelect = useCallback(() => {
    setSelectMode((s) => !s)
    setSelectedIds(new Set())
  }, [])

  const handleMoreOptions = useCallback(() => {
    Alert.alert('More options', undefined, [
      { text: 'New folder', onPress: () => setNewFolderModalVisible(true) },
      { text: 'Select projects', onPress: handleToggleSelect },
      { text: 'Cancel', style: 'cancel' },
    ])
  }, [handleToggleSelect])

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
      const isSelected = selectedIds.has(project.id)
      return (
        <Pressable
          onPress={() => {
            if (selectMode) {
              setSelectedIds((prev) => {
                const next = new Set(prev)
                if (next.has(project.id)) {
                  next.delete(project.id)
                } else {
                  next.add(project.id)
                }
                return next
              })
            } else {
              handleProjectPress(project)
            }
          }}
          onLongPress={() => handleProjectActions(project)}
          className={cn('flex-1 m-1.5 rounded-xl bg-card overflow-hidden', isSelected && 'border-2 border-primary')}
        >
          {/* Color banner / thumbnail placeholder */}
          <View className={cn('aspect-[16/10] items-center justify-center', getPlaceholderColor(project.name))}>
            <View className="items-center">
              <Text style={{ fontSize: 28, fontWeight: '700', color: 'rgba(255,255,255,0.6)' }}>
                {project.name?.charAt(0)?.toUpperCase() || 'P'}
              </Text>
              <Text style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
                {(project as any).type === 'AGENT' ? 'Agent' : 'Project'}
              </Text>
            </View>

            {/* Select checkbox */}
            {selectMode && (
              <View className={cn(
                'absolute top-2 left-2 w-5 h-5 rounded border-2 items-center justify-center',
                isSelected ? 'bg-primary border-primary' : 'border-white/70 bg-black/20'
              )}>
                {isSelected && <Check size={12} color="#fff" />}
              </View>
            )}

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
      selectedIds,
      selectMode,
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
      <View className="flex-row items-center justify-between px-4 pt-3 pb-1">
        <Text className="text-lg font-semibold text-foreground">Projects</Text>
        <Pressable onPress={handleMoreOptions} className="p-1.5 rounded-md active:bg-muted">
          <MoreHorizontal size={18} className="text-muted-foreground" />
        </Pressable>
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

        {/* Dismiss overlay for open dropdowns */}
        {(showSortMenu || showVisibilityMenu || showStatusMenu) && (
          <Pressable
            onPress={() => { setShowSortMenu(false); setShowVisibilityMenu(false); setShowStatusMenu(false) }}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40 }}
          />
        )}

        {/* Sort + Filters + View toggle row */}
        <View className="flex-row items-center gap-1.5 flex-wrap" style={{ zIndex: 50 }}>
          {/* Sort */}
          <View className="relative">
            <Pressable
              onPress={handleSortPress}
              className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg border border-input"
            >
              <Text className="text-xs text-foreground">{sortLabel}</Text>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Pressable>
            {showSortMenu && (
              <View className="absolute top-full left-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-lg overflow-hidden" style={{ minWidth: 150 }}>
                {([
                  { value: 'lastEdited' as SortBy, label: 'Last edited' },
                  { value: 'dateCreated' as SortBy, label: 'Date created' },
                  { value: 'alphabetical' as SortBy, label: 'Alphabetical' },
                ] as const).map((item) => (
                  <Pressable
                    key={item.value}
                    onPress={() => { setSortBy(item.value); setShowSortMenu(false) }}
                    className={cn('px-3 py-2 active:bg-muted', sortBy === item.value && 'bg-accent')}
                  >
                    <Text className={cn('text-xs', sortBy === item.value ? 'text-foreground font-medium' : 'text-foreground')}>
                      {item.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          {/* Visibility filter */}
          <View className="relative">
            <Pressable
              onPress={handleVisibilityFilter}
              className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg border border-input"
            >
              <Text className="text-xs text-foreground">
                {visibilityFilter === 'any' ? 'Any visibility' : visibilityFilter === 'public' ? 'Public' : 'Private'}
              </Text>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Pressable>
            {showVisibilityMenu && (
              <View className="absolute top-full left-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-lg overflow-hidden" style={{ minWidth: 150 }}>
                {([
                  { value: 'any' as VisibilityFilter, label: 'Any visibility' },
                  { value: 'public' as VisibilityFilter, label: 'Public' },
                  { value: 'private' as VisibilityFilter, label: 'Private' },
                ] as const).map((item) => (
                  <Pressable
                    key={item.value}
                    onPress={() => { setVisibilityFilter(item.value); setShowVisibilityMenu(false) }}
                    className={cn('px-3 py-2 active:bg-muted', visibilityFilter === item.value && 'bg-accent')}
                  >
                    <Text className={cn('text-xs', visibilityFilter === item.value ? 'text-foreground font-medium' : 'text-foreground')}>
                      {item.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          {/* Status filter */}
          <View className="relative">
            <Pressable
              onPress={handleStatusFilter}
              className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg border border-input"
            >
              <Text className="text-xs text-foreground">
                {statusFilter === 'any' ? 'Any status' : statusFilter === 'draft' ? 'Draft' : 'Published'}
              </Text>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Pressable>
            {showStatusMenu && (
              <View className="absolute top-full left-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-lg overflow-hidden" style={{ minWidth: 150 }}>
                {([
                  { value: 'any' as StatusFilter, label: 'Any status' },
                  { value: 'draft' as StatusFilter, label: 'Draft' },
                  { value: 'published' as StatusFilter, label: 'Published' },
                ] as const).map((item) => (
                  <Pressable
                    key={item.value}
                    onPress={() => { setStatusFilter(item.value); setShowStatusMenu(false) }}
                    className={cn('px-3 py-2 active:bg-muted', statusFilter === item.value && 'bg-accent')}
                  >
                    <Text className={cn('text-xs', statusFilter === item.value ? 'text-foreground font-medium' : 'text-foreground')}>
                      {item.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          {/* Spacer */}
          <View className="flex-1" />

          {/* New folder */}
          <Pressable
            onPress={() => setNewFolderModalVisible(true)}
            className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg border border-input active:bg-muted"
          >
            <FolderPlus size={14} className="text-muted-foreground" />
            <Text className="text-xs text-foreground">New folder</Text>
          </Pressable>

          {/* Select */}
          <Pressable
            onPress={handleToggleSelect}
            className={cn(
              'w-8 h-8 items-center justify-center rounded-lg',
              selectMode ? 'bg-primary/10' : 'bg-transparent',
            )}
          >
            <CheckSquare size={16} className={selectMode ? 'text-primary' : 'text-muted-foreground'} />
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

      {/* New Folder Modal */}
      <Modal
        visible={newFolderModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setNewFolderModalVisible(false)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setNewFolderModalVisible(false)}
        >
          <Pressable
            className="bg-card rounded-xl p-6 w-80 border border-border"
            onPress={(e) => e.stopPropagation()}
          >
            <Text className="text-base font-semibold text-foreground mb-1">Create new folder</Text>
            <Text className="text-sm text-muted-foreground mb-4">
              Create a new folder to organize your projects
            </Text>
            <TextInput
              value={newFolderName}
              onChangeText={setNewFolderName}
              placeholder="Enter folder name"
              placeholderTextColor="#9ca3af"
              className="border border-border rounded-md px-3 py-2 text-sm text-foreground bg-background mb-4"
              autoFocus
              onSubmitEditing={handleCreateFolder}
            />
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setNewFolderModalVisible(false)}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleCreateFolder}
                className={cn(
                  'px-4 py-2 rounded-md',
                  newFolderName.trim() ? 'bg-primary active:bg-primary/80' : 'bg-muted'
                )}
                disabled={!newFolderName.trim()}
              >
                <Text className={cn(
                  'text-sm',
                  newFolderName.trim() ? 'text-primary-foreground' : 'text-muted-foreground'
                )}>
                  Create folder
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
})
