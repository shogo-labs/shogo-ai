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
  Settings,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import {
  useWorkspaceCollection,
  useProjectCollection,
  useStarredProjectCollection,
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

  const starredProjects = useMemo(() => {
    if (!user?.id) return []
    const starredEntries = starredColl.all.filter((s: any) => s.userId === user.id)
    return starredEntries
      .map((entry: any) => {
        const project = projects.all.find((p: any) => p.id === entry.projectId)
        if (!project) return null
        return {
          ...project,
          _starredAt: entry.createdAt,
          _workspaceId: entry.workspaceId,
          _starredEntryId: entry.id,
        }
      })
      .filter(Boolean)
  }, [user?.id, starredColl.all, projects.all])

  const filteredProjects = useMemo(() => {
    let result = [...starredProjects]

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
        case 'starredAt':
          return (b._starredAt || 0) - (a._starredAt || 0)
        case 'lastEdited':
          return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
        case 'alphabetical':
          return (a.name || '').localeCompare(b.name || '')
        default:
          return 0
      }
    })
    return result
  }, [starredProjects, searchQuery, sortBy])

  const getWorkspaceName = useCallback(
    (project: any) => {
      const wsId = project._workspaceId || project.workspaceId
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
    async (project: any) => {
      try {
        if (project._starredEntryId) {
          await starredColl.delete(project._starredEntryId)
        }
        if (user?.id) {
          await starredColl.loadAll({ userId: user.id })
        }
      } catch {
        Alert.alert('Error', 'Failed to remove from starred')
      }
    },
    [starredColl, user?.id]
  )

  const sortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label || 'Sort'

  const renderGridItem = useCallback(
    ({ item: project }: { item: any }) => (
      <Pressable
        onPress={() => handleProjectPress(project)}
        className="flex-1 mx-1.5 mb-3 rounded-xl bg-card overflow-hidden border border-border"
      >
        <View className={cn('aspect-video items-center justify-center', getPlaceholderColor(project.name || ''))}>
          <FolderOpen size={28} className="text-white/30" />
          <Pressable
            onPress={() => handleUnstar(project)}
            className="absolute top-2 right-2 p-1.5 rounded-md bg-yellow-500/90"
          >
            <Star size={14} className="text-white" fill="white" />
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
                {getWorkspaceName(project)}
              </Text>
            </View>
          </View>
        </View>
      </Pressable>
    ),
    [handleProjectPress, handleUnstar, getWorkspaceName, user?.name]
  )

  const renderListItem = useCallback(
    ({ item: project }: { item: any }) => (
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
            {getWorkspaceName(project)} · Edited{' '}
            {getTimeAgo(project.updatedAt || project.createdAt)}
          </Text>
        </View>
        <Pressable onPress={() => handleUnstar(project)} className="p-2 mr-1">
          <Star size={16} className="text-yellow-500" fill="#eab308" />
        </Pressable>
        <Pressable
          onPress={() => setMenuProjectId(project.id === menuProjectId ? null : project.id)}
          className="p-2"
        >
          <MoreHorizontal size={16} className="text-muted-foreground" />
        </Pressable>
      </Pressable>
    ),
    [handleProjectPress, handleUnstar, getWorkspaceName, menuProjectId]
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
      ) : filteredProjects.length === 0 ? (
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
          data={filteredProjects}
          keyExtractor={(item: any) => item.id}
          numColumns={2}
          contentContainerClassName="p-2.5 pt-4"
          renderItem={renderGridItem}
        />
      ) : (
        <FlatList
          data={filteredProjects}
          keyExtractor={(item: any) => item.id}
          renderItem={renderListItem}
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
