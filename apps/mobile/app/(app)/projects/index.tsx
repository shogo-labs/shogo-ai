// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
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
 * - HTML5 drag-and-drop on web (projects onto folders); disabled on native
 * - No multi-select mode (simplify for touch UX)
 * - Modal sheets instead of dropdown menus for actions
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  Image,
  Modal,
  useWindowDimensions,
  Alert,
  Platform,
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
  FolderInput,
  CheckSquare,
  Check,
  X,
  Trash2,
  ArrowRightLeft,
  Pencil,
  Download,
} from 'lucide-react-native'
import {
  useSDKDomain,
  useSDKReady,
  useDomainActions,
} from '@shogo/shared-app/domain'
import type { IDomainStore } from '@shogo/domain-stores'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import { useAuth } from '../../../contexts/auth'
import { ProjectCard } from '../../../components/home/ProjectCard'
import { api } from '../../../lib/api'
import { useToast, Toast, ToastTitle, ToastDescription } from '@/components/ui/toast'

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
  thumbnailUrl?: string
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

// ─── DraggableView (web HTML5 drag source) ────────────────

function DraggableView({
  children,
  dragId,
  disabled,
}: {
  children: React.ReactNode
  dragId: string
  disabled?: boolean
}) {
  const ref = useRef<View>(null)

  useEffect(() => {
    if (Platform.OS !== 'web') return
    const el = ref.current as unknown as HTMLDivElement
    if (!el) return

    if (disabled) {
      el.draggable = false
      el.style.cursor = ''
      return
    }

    el.draggable = true
    el.style.cursor = 'grab'

    const handleDragStart = (e: DragEvent) => {
      e.dataTransfer!.setData('text/plain', dragId)
      e.dataTransfer!.effectAllowed = 'move'
      requestAnimationFrame(() => {
        el.style.opacity = '0.4'
        el.style.cursor = 'grabbing'
      })
    }
    const handleDragEnd = () => {
      el.style.opacity = '1'
      el.style.cursor = 'grab'
    }

    el.addEventListener('dragstart', handleDragStart)
    el.addEventListener('dragend', handleDragEnd)
    return () => {
      el.draggable = false
      el.style.cursor = ''
      el.removeEventListener('dragstart', handleDragStart)
      el.removeEventListener('dragend', handleDragEnd)
    }
  }, [dragId, disabled])

  return (
    <View ref={ref} className="flex-1">
      {children}
    </View>
  )
}

// ─── DroppableView (web HTML5 drop target) ─────────────────

function DroppableView({
  children,
  onDrop,
}: {
  children: React.ReactNode | ((isDragOver: boolean) => React.ReactNode)
  onDrop: (dragId: string) => void
}) {
  const ref = useRef<View>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  useEffect(() => {
    if (Platform.OS !== 'web') return
    const el = ref.current as unknown as HTMLDivElement
    if (!el) return

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'move'
      setIsDragOver(true)
    }
    const handleDragLeave = (e: DragEvent) => {
      if (el.contains(e.relatedTarget as Node)) return
      setIsDragOver(false)
    }
    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      const id = e.dataTransfer!.getData('text/plain')
      if (id) onDrop(id)
    }

    el.addEventListener('dragover', handleDragOver)
    el.addEventListener('dragleave', handleDragLeave)
    el.addEventListener('drop', handleDrop)
    return () => {
      el.removeEventListener('dragover', handleDragOver)
      el.removeEventListener('dragleave', handleDragLeave)
      el.removeEventListener('drop', handleDrop)
    }
  }, [onDrop])

  return (
    <View ref={ref} className="flex-1">
      {typeof children === 'function' ? children(isDragOver) : children}
    </View>
  )
}

export default observer(function AllProjectsPage() {
  const router = useRouter()
  const { user } = useAuth()
  const store = useSDKDomain() as IDomainStore
  const sdkReady = useSDKReady()
  const actions = useDomainActions()
  const toast = useToast()
  const { width } = useWindowDimensions()
  const isNativeMobile = Platform.OS === 'ios' || Platform.OS === 'android'

  type VisibilityFilter = 'any' | 'public' | 'private'
  type StatusFilter = 'any' | 'draft' | 'active' | 'archived'

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
  const [isImporting, setIsImporting] = useState(false)
  const [moveToFolderModalVisible, setMoveToFolderModalVisible] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [visibilityOpen, setVisibilityOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [actionMenuProjectId, setActionMenuProjectId] = useState<string | null>(null)
  const [actionMenuFolderId, setActionMenuFolderId] = useState<string | null>(null)
  const [renameFolder, setRenameFolder] = useState<Folder | null>(null)
  const [renameFolderValue, setRenameFolderValue] = useState('')
  const [singleDeleteFolder, setSingleDeleteFolder] = useState<Folder | null>(null)

  // Native phones: 2 columns for readable titles and touch targets; web keeps 3-up grid.
  const numColumns = viewMode === 'grid' ? (isNativeMobile ? 2 : 3) : 1

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
    if (!currentWorkspace?.id || !user?.id || !store?.starredProjectCollection) return

    store.starredProjectCollection
      .loadAll({ userId: user.id, workspaceId: currentWorkspace.id })
      .then(() => {
        const starredAll = Array.isArray(store.starredProjectCollection.all) ? store.starredProjectCollection.all : []
        const ids = new Set(
          starredAll
            .filter((s: any) => s.userId === user.id && s.workspaceId === currentWorkspace.id)
            .map((s: any) => s.projectId),
        )
        setStarredIds(ids)
      })
      .catch((e) => console.error('[Projects] Failed to load starred projects:', e))
  }, [currentWorkspace?.id, user?.id, store])

  const rawProjects = store?.projectCollection?.all
  const allProjects = (Array.isArray(rawProjects) ? rawProjects : []) as Project[]
  const rawFolders = store?.folderCollection?.all
  const allFolders = (Array.isArray(rawFolders) ? rawFolders : []) as Folder[]

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
      if (!currentWorkspace?.id || !user?.id) return
      try {
        const isStarred = starredIds.has(projectId)
        if (isStarred) {
          const starRecord = store?.starredProjectCollection?.all.find(
            (s: any) => s.projectId === projectId && s.userId === user.id,
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
            userId: user.id,
            workspaceId: currentWorkspace.id,
          })
          setStarredIds((prev) => new Set(prev).add(projectId))
        }
      } catch (err) {
        console.error('[AllProjectsPage] Failed to toggle star:', err)
      }
    },
    [currentWorkspace?.id, user?.id, starredIds, store],
  )

  const [renameProject, setRenameProject] = useState<Project | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const handleRenameProject = useCallback(
    (project: Project) => {
      setRenameValue(project.name)
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
      store?.projectCollection
        ?.loadAll({ workspaceId: currentWorkspace?.id })
        .catch((e) => console.error('[Projects] Failed to refresh after rename:', e))
    } catch (err) {
      console.error('[AllProjectsPage] Rename failed:', err)
    }
  }, [renameProject, renameValue, actions, store, currentWorkspace?.id])

  const [singleDeleteProject, setSingleDeleteProject] = useState<Project | null>(null)

  const handleDeleteProject = useCallback(
    (project: Project) => {
      setSingleDeleteProject(project)
    },
    [],
  )

  const confirmSingleDelete = useCallback(async () => {
    if (!singleDeleteProject) return
    const projectId = singleDeleteProject.id
    setSingleDeleteProject(null)
    try {
      await actions.deleteProject(projectId)
      await store?.projectCollection?.loadAll({ workspaceId: currentWorkspace?.id })
    } catch (err) {
      console.error('[AllProjectsPage] Delete failed:', err)
    }
  }, [singleDeleteProject, actions, store, currentWorkspace?.id])

  const handleProjectActions = useCallback(
    (project: Project) => {
      setActionMenuProjectId((prev) => (prev === project.id ? null : project.id))
    },
    [],
  )

  const handleFolderPress = useCallback((folder: Folder) => {
    setCurrentFolderId(folder.id)
  }, [])

  const handleDragToFolder = useCallback(
    async (projectId: string, folderId: string) => {
      try {
        await actions.moveProjectToFolder(projectId, folderId)
        await store?.projectCollection?.loadAll({ workspaceId: currentWorkspace?.id })
      } catch (err) {
        console.error('[AllProjectsPage] Drag to folder failed:', err)
      }
    },
    [actions, store, currentWorkspace?.id],
  )

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

  const visibilityLabel =
    visibilityFilter === 'any' ? 'Any visibility' : visibilityFilter === 'public' ? 'Public' : 'Private'

  const statusLabel =
    statusFilter === 'any' ? 'Any status'
      : statusFilter === 'draft' ? 'Draft'
        : statusFilter === 'active' ? 'Active'
          : 'Archived'

  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim()
    if (!name || !currentWorkspace?.id) return
    try {
      await actions.createFolder(name, currentWorkspace.id, currentFolderId)
      store?.folderCollection?.loadAll({ workspaceId: currentWorkspace.id }).catch((e) => console.error('[Projects] Failed to refresh folders:', e))
    } catch (err) {
      console.error('[AllProjectsPage] Failed to create folder:', err)
    }
    setNewFolderName('')
    setNewFolderModalVisible(false)
  }, [newFolderName, currentWorkspace?.id, currentFolderId, actions, store])

  const handleRenameFolder = useCallback((folder: Folder) => {
    setRenameFolderValue(folder.name)
    setRenameFolder(folder)
  }, [])

  const confirmRenameFolder = useCallback(async () => {
    if (!renameFolder || !renameFolderValue.trim()) return
    const folderId = renameFolder.id
    const newName = renameFolderValue.trim()
    setRenameFolder(null)
    try {
      await actions.updateFolder(folderId, { name: newName })
      await store?.folderCollection?.loadAll({ workspaceId: currentWorkspace?.id })
    } catch (err) {
      console.error('[AllProjectsPage] Rename folder failed:', err)
    }
  }, [renameFolder, renameFolderValue, actions, store, currentWorkspace?.id])

  const handleDeleteFolder = useCallback(
    (folder: Folder) => {
      setActionMenuFolderId(null)
      const projectCount = allProjects.filter((p) => p.folderId === folder.id).length
      if (projectCount > 0) {
        toast.show({
          placement: 'top',
          duration: 5000,
          render: ({ id }) => (
            <Toast nativeID={id} variant="outline" action="warning">
              <ToastTitle>Cannot delete folder</ToastTitle>
              <ToastDescription>
                This folder contains {projectCount} project{projectCount !== 1 ? 's' : ''}. Delete or move all projects out first.
              </ToastDescription>
            </Toast>
          ),
        })
        return
      }
      setSingleDeleteFolder(folder)
    },
    [allProjects, toast],
  )

  const confirmDeleteFolder = useCallback(async () => {
    if (!singleDeleteFolder) return
    const folderId = singleDeleteFolder.id
    setSingleDeleteFolder(null)
    try {
      await actions.deleteFolder(folderId)
      await store?.folderCollection?.loadAll({ workspaceId: currentWorkspace?.id })
    } catch (err: any) {
      console.error('[AllProjectsPage] Delete folder failed:', err)
      Alert.alert('Delete failed', err?.message ?? 'Could not delete folder.')
    }
  }, [singleDeleteFolder, actions, store, currentWorkspace?.id])

  const handleToggleSelect = useCallback(() => {
    setSelectMode((s) => !s)
    setSelectedIds(new Set())
  }, [])

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === filteredProjects.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredProjects.map((p) => p.id)))
    }
  }, [filteredProjects, selectedIds.size])

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const handleCancelSelectMode = useCallback(() => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }, [])

  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size === 0) return
    setDeleteConfirmVisible(true)
  }, [selectedIds])

  const confirmBulkDelete = useCallback(async () => {
    setDeleteConfirmVisible(false)
    setIsDeleting(true)
    const idsArray = Array.from(selectedIds)
    try {
      for (let i = 0; i < idsArray.length; i++) {
        await actions.deleteProject(idsArray[i])
      }
    } catch (err) {
      console.error('[AllProjectsPage] Bulk delete failed:', err)
    }
    try {
      await store?.projectCollection?.loadAll({ workspaceId: currentWorkspace?.id })
    } catch (_) {}
    setIsDeleting(false)
    setSelectedIds(new Set())
    setSelectMode(false)
  }, [selectedIds, actions, store, currentWorkspace?.id])

  const handleBulkMoveToFolder = useCallback(
    async (folderId: string | null) => {
      if (selectedIds.size === 0) return
      const idsArray = Array.from(selectedIds)
      try {
        for (let i = 0; i < idsArray.length; i++) {
          await actions.moveProjectToFolder(idsArray[i], folderId)
        }
      } catch (err) {
        console.error('[AllProjectsPage] Bulk move failed:', err)
      }
      try {
        await store?.projectCollection?.loadAll({ workspaceId: currentWorkspace?.id })
      } catch (_) {}
      setMoveToFolderModalVisible(false)
      setSelectedIds(new Set())
      setSelectMode(false)
    },
    [selectedIds, actions, store, currentWorkspace?.id],
  )

  const [transferModalVisible, setTransferModalVisible] = useState(false)

  const handleBulkTransfer = useCallback(() => {
    if (selectedIds.size === 0) return
    setTransferModalVisible(true)
  }, [selectedIds])

  const executeTransfer = useCallback(async (targetWorkspaceId: string) => {
    if (selectedIds.size === 0) return
    const idsArray = Array.from(selectedIds)
    try {
      for (let i = 0; i < idsArray.length; i++) {
        await store?.projectCollection?.update(idsArray[i], { workspaceId: targetWorkspaceId })
      }
    } catch (err) {
      console.error('[AllProjectsPage] Transfer failed:', err)
    }
    try {
      await store?.projectCollection?.loadAll({ workspaceId: currentWorkspace?.id })
    } catch (_) {}
    setTransferModalVisible(false)
    setSelectedIds(new Set())
    setSelectMode(false)
  }, [selectedIds, store, currentWorkspace?.id])

  const handleImportProject = useCallback(() => {
    if (!currentWorkspace?.id || isImporting) return

    const pickAndImport = async (blob: Blob, filename: string) => {
      setIsImporting(true)
      try {
        const result = await api.importProject({
          file: blob,
          workspaceId: currentWorkspace.id,
          filename,
        })
        if (result?.id) {
          store?.projectCollection?.loadAll({ workspaceId: currentWorkspace.id })
          toast.show({
            placement: 'top',
            duration: 3000,
            render: ({ id }) => (
              <Toast nativeID={id} variant="outline" action="success">
                <ToastTitle>Project imported</ToastTitle>
                <ToastDescription>{result.name}</ToastDescription>
              </Toast>
            ),
          })
          router.push({ pathname: '/(app)/projects/[id]', params: { id: result.id } } as any)
        }
      } catch (err: any) {
        console.error('[AllProjectsPage] Import failed:', err)
        Alert.alert('Import Failed', err.message || 'Failed to import project')
      } finally {
        setIsImporting(false)
      }
    }

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.shogo-project,.zip'
      input.style.cssText = 'position:fixed;left:-9999px;opacity:0;width:1px;height:1px;pointer-events:none'
      document.body.appendChild(input)
      const cleanup = () => { if (input.parentNode) input.parentNode.removeChild(input) }
      const timer = setTimeout(cleanup, 120_000)
      input.onchange = async (e: any) => {
        clearTimeout(timer)
        const file = e.target?.files?.[0] as File | undefined
        if (file) await pickAndImport(file, file.name)
        cleanup()
      }
      input.click()
      return
    }

    void (async () => {
      try {
        const { getDocumentAsync } = await import('expo-document-picker')
        const result = await getDocumentAsync({
          type: ['application/zip', 'application/octet-stream'],
          copyToCacheDirectory: true,
          multiple: false,
        })
        if (result.canceled || !result.assets?.[0]) return
        const asset = result.assets[0]
        const { readAsStringAsync, EncodingType } = await import('expo-file-system/legacy')
        const base64 = await readAsStringAsync(asset.uri, { encoding: EncodingType.Base64 })
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'application/zip' })
        await pickAndImport(blob, asset.name || 'project.shogo-project')
      } catch (err: any) {
        if (err?.code !== 'ERR_CANCELED') {
          console.error('[AllProjectsPage] Import picker failed:', err)
          Alert.alert('Import Failed', err.message || 'Failed to pick file')
        }
      }
    })()
  }, [currentWorkspace?.id, isImporting, store, router, toast])

  const handleMoreOptions = useCallback(() => {
    Alert.alert('More options', undefined, [
      { text: 'Import project', onPress: handleImportProject },
      { text: 'New folder', onPress: () => setNewFolderModalVisible(true) },
      { text: 'Select projects', onPress: handleToggleSelect },
      { text: 'Cancel', style: 'cancel' },
    ])
  }, [handleToggleSelect, handleImportProject])

  // Build combined data for FlatList (folders first, then projects)
  type ListItem =
    | { type: 'create' }
    | { type: 'folder'; data: Folder }
    | { type: 'project'; data: Project }
    | { type: 'spacer' }

  const listData = useMemo((): ListItem[] => {
    const items: ListItem[] = [{ type: 'create' }]
    currentFolders.forEach((f) => items.push({ type: 'folder', data: f }))
    filteredProjects.forEach((p) => items.push({ type: 'project', data: p }))
    const remainder = items.length % numColumns
    if (remainder !== 0) {
      for (let i = 0; i < numColumns - remainder; i++) {
        items.push({ type: 'spacer' })
      }
    }
    return items
  }, [currentFolders, filteredProjects, numColumns])

  const renderGridItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.type === 'spacer') {
        return <View className="flex-1 m-1.5" />
      }

      if (item.type === 'create') {
        return (
          <Pressable
            onPress={handleCreateProject}
            className="flex-1 m-1.5 rounded-2xl border-2 border-dashed border-border overflow-hidden"
          >
            <View
              className="flex-1 items-center justify-center"
              style={{
                minHeight:
                  Platform.OS === 'ios' || Platform.OS === 'android' ? 168 : 180,
              }}
            >
              <View className="w-12 h-12 rounded-full bg-muted items-center justify-center mb-2">
                <Plus size={24} className="text-muted-foreground" />
              </View>
              <Text className="text-sm text-muted-foreground">Create new project</Text>
            </View>
          </Pressable>
        )
      }

      if (item.type === 'folder') {
        const folder = item.data
        const projectCount = allProjects.filter((p) => p.folderId === folder.id).length
        return (
          <DroppableView onDrop={(projectId) => handleDragToFolder(projectId, folder.id)}>
            {(isDragOver) => (
              <View
                className={cn(
                  'flex-1 m-1.5 rounded-2xl border bg-card overflow-hidden',
                  isDragOver ? 'border-2 border-primary bg-primary/5' : 'border-border',
                )}
              >
                <Pressable
                  onPress={() => handleFolderPress(folder)}
                  className="flex-1"
                >
                  <View className="bg-muted/40 items-center justify-center" style={{ height: 180 }}>
                    <FolderOpen size={36} className={isDragOver ? 'text-primary/50' : 'text-muted-foreground/30'} />
                  </View>
                  <View className="px-3 py-2.5">
                    <Text className="font-medium text-sm text-foreground" numberOfLines={1}>
                      {folder.name}
                    </Text>
                    <Text className="text-xs text-muted-foreground mt-0.5">
                      {projectCount} project{projectCount !== 1 ? 's' : ''}
                    </Text>
                  </View>
                </Pressable>
                <View className="absolute top-2 right-2">
                  <Popover
                    placement="bottom right"
                    isOpen={actionMenuFolderId === folder.id}
                    onOpen={() => setActionMenuFolderId(folder.id)}
                    onClose={() => setActionMenuFolderId(null)}
                    trigger={(triggerProps) => (
                      <Pressable
                        {...triggerProps}
                        onPress={(e) => {
                          e.stopPropagation()
                          setActionMenuFolderId((prev) => (prev === folder.id ? null : folder.id))
                        }}
                        className="w-8 h-8 items-center justify-center rounded-md active:bg-muted"
                      >
                        <MoreHorizontal size={18} className="text-muted-foreground" />
                      </Pressable>
                    )}
                  >
                    <PopoverBackdrop />
                    <PopoverContent className="p-0 min-w-[150px]">
                      <PopoverBody>
                        <Pressable
                          onPress={() => {
                            setActionMenuFolderId(null)
                            handleRenameFolder(folder)
                          }}
                          className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                        >
                          <Pencil size={14} className="text-muted-foreground" />
                          <Text className="text-sm text-foreground">Rename</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => handleDeleteFolder(folder)}
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
            )}
          </DroppableView>
        )
      }

      // Project card — draggable on web, checkbox non-overlapping
      const project = item.data
      const isStarred = starredIds.has(project.id)
      const isSelected = selectedIds.has(project.id)
      return (
        <DraggableView dragId={project.id} disabled={selectMode}>
          <ProjectCard
            name={project.name || 'Untitled'}
            updatedAt={project.updatedAt || project.createdAt}
            thumbnailUrl={(project as any).thumbnailUrl}
            isSelected={isSelected}
            isStarred={isStarred}
            selectMode={selectMode}
            compact={Platform.OS === 'ios' || Platform.OS === 'android'}
            className="flex-1 m-1.5"
            onPress={() => {
              if (selectMode) {
                setSelectedIds((prev) => {
                  const next = new Set(prev)
                  if (next.has(project.id)) next.delete(project.id)
                  else next.add(project.id)
                  return next
                })
              } else {
                handleProjectPress(project)
              }
            }}
            onLongPress={() => handleProjectActions(project)}
            onStarToggle={(e) => {
              e.stopPropagation()
              handleToggleStar(project.id)
            }}
            onSelectToggle={(e) => {
              e.stopPropagation()
              setSelectedIds((prev) => {
                const next = new Set(prev)
                if (next.has(project.id)) next.delete(project.id)
                else next.add(project.id)
                return next
              })
            }}
            renderLeading={() => (
              <View className="w-6 h-6 rounded-full bg-muted items-center justify-center">
                <Text className="text-[10px] font-medium text-muted-foreground">
                  {user?.name?.charAt(0) || 'U'}
                </Text>
              </View>
            )}
            renderTrailing={() => (
              <Popover
                placement="bottom right"
                isOpen={actionMenuProjectId === project.id}
                onOpen={() => setActionMenuProjectId(project.id)}
                onClose={() => setActionMenuProjectId(null)}
                trigger={(triggerProps) => (
                  <Pressable
                    {...triggerProps}
                    hitSlop={
                      Platform.OS === 'ios' || Platform.OS === 'android'
                        ? { top: 6, bottom: 6, left: 6, right: 6 }
                        : undefined
                    }
                    onPress={(e) => {
                      e.stopPropagation()
                      setActionMenuProjectId((prev) => (prev === project.id ? null : project.id))
                    }}
                    className={cn(
                      'items-center justify-center rounded-lg active:bg-muted/80',
                      Platform.OS === 'ios' || Platform.OS === 'android'
                        ? 'w-11 h-11'
                        : 'w-6 h-6',
                    )}
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
                        setActionMenuProjectId(null)
                        handleRenameProject(project)
                      }}
                      className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                    >
                      <Pencil size={14} className="text-muted-foreground" />
                      <Text className="text-sm text-foreground">Rename</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setActionMenuProjectId(null)
                        handleDeleteProject(project)
                      }}
                      className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                    >
                      <Trash2 size={14} className="text-destructive" />
                      <Text className="text-sm text-destructive">Delete</Text>
                    </Pressable>
                  </PopoverBody>
                </PopoverContent>
              </Popover>
            )}
          />
        </DraggableView>
      )
    },
    [
      allProjects,
      handleCreateProject,
      handleFolderPress,
      handleDragToFolder,
      handleProjectPress,
      handleProjectActions,
      handleToggleStar,
      handleRenameProject,
      handleDeleteProject,
      handleRenameFolder,
      handleDeleteFolder,
      starredIds,
      selectedIds,
      selectMode,
      user?.name,
      actionMenuProjectId,
      actionMenuFolderId,
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
          <DroppableView onDrop={(projectId) => handleDragToFolder(projectId, folder.id)}>
            {(isDragOver) => (
              <View
                className={cn(
                  'flex-row items-center gap-3 px-4 py-3 border-b',
                  isDragOver ? 'border-primary bg-primary/5 border-b-2' : 'border-border/50',
                )}
              >
                <Pressable
                  onPress={() => handleFolderPress(folder)}
                  className="flex-1 flex-row items-center gap-3 min-w-0"
                >
                  <View className="w-12 h-8 rounded-md bg-muted items-center justify-center">
                    <FolderOpen size={16} className={isDragOver ? 'text-primary' : 'text-muted-foreground'} />
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
                <Popover
                  placement="bottom right"
                  isOpen={actionMenuFolderId === folder.id}
                  onOpen={() => setActionMenuFolderId(folder.id)}
                  onClose={() => setActionMenuFolderId(null)}
                  trigger={(triggerProps) => (
                    <Pressable
                      {...triggerProps}
                      onPress={(e) => {
                        e.stopPropagation()
                        setActionMenuFolderId((prev) => (prev === folder.id ? null : folder.id))
                      }}
                      className="w-8 h-8 items-center justify-center"
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
                          setActionMenuFolderId(null)
                          handleRenameFolder(folder)
                        }}
                        className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                      >
                        <Pencil size={14} className="text-muted-foreground" />
                        <Text className="text-sm text-foreground">Rename</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => handleDeleteFolder(folder)}
                        className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                      >
                        <Trash2 size={14} className="text-destructive" />
                        <Text className="text-sm text-destructive">Delete</Text>
                      </Pressable>
                    </PopoverBody>
                  </PopoverContent>
                </Popover>
              </View>
            )}
          </DroppableView>
        )
      }

      const project = item.data
      const isStarred = starredIds.has(project.id)
      const isSelected = selectedIds.has(project.id)
      return (
        <DraggableView dragId={project.id} disabled={selectMode}>
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
            className={cn(
              'flex-row items-center gap-3 px-4 py-3 border-b border-border/50',
              isSelected && 'bg-primary/5',
            )}
          >
            {selectMode && (
              <Pressable
                onPress={(e) => {
                  e.stopPropagation()
                  setSelectedIds((prev) => {
                    const next = new Set(prev)
                    if (next.has(project.id)) {
                      next.delete(project.id)
                    } else {
                      next.add(project.id)
                    }
                    return next
                  })
                }}
              >
                <View className={cn(
                  'w-6 h-6 rounded border-2 items-center justify-center',
                  isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/40',
                )}>
                  {isSelected && <Check size={14} color="#fff" />}
                </View>
              </Pressable>
            )}

            {/* Thumbnail */}
            <View className="w-12 h-8 rounded-md items-center justify-center bg-muted/40 overflow-hidden">
              {(project as any).thumbnailUrl ? (
                <Image
                  source={{ uri: (project as any).thumbnailUrl }}
                  className="absolute inset-0 w-full h-full"
                  resizeMode="cover"
                />
              ) : (
                <Text className="text-xs font-bold text-muted-foreground/30">
                  {project.name?.charAt(0)?.toUpperCase() || 'P'}
                </Text>
              )}
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

            {!selectMode && (
              <Pressable
                onPress={(e) => {
                  e.stopPropagation()
                  handleToggleStar(project.id)
                }}
                className="p-2"
              >
                <Star
                  size={16}
                  className={isStarred ? 'text-yellow-500' : 'text-muted-foreground'}
                  fill={isStarred ? '#eab308' : 'transparent'}
                />
              </Pressable>
            )}

            {!selectMode && (
              <Popover
                placement="bottom right"
                isOpen={actionMenuProjectId === project.id}
                onOpen={() => setActionMenuProjectId(project.id)}
                onClose={() => setActionMenuProjectId(null)}
                trigger={(triggerProps) => (
                  <Pressable
                    {...triggerProps}
                    onPress={(e) => {
                      e.stopPropagation()
                      setActionMenuProjectId((prev) => (prev === project.id ? null : project.id))
                    }}
                    className="p-2"
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
                        setActionMenuProjectId(null)
                        handleRenameProject(project)
                      }}
                      className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                    >
                      <Pencil size={14} className="text-muted-foreground" />
                      <Text className="text-sm text-foreground">Rename</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setActionMenuProjectId(null)
                        handleDeleteProject(project)
                      }}
                      className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                    >
                      <Trash2 size={14} className="text-destructive" />
                      <Text className="text-sm text-destructive">Delete</Text>
                    </Pressable>
                  </PopoverBody>
                </PopoverContent>
              </Popover>
            )}
          </Pressable>
        </DraggableView>
      )
    },
    [
      allProjects,
      handleCreateProject,
      handleFolderPress,
      handleDragToFolder,
      handleProjectPress,
      handleProjectActions,
      handleToggleStar,
      handleRenameProject,
      handleDeleteProject,
      handleRenameFolder,
      handleDeleteFolder,
      starredIds,
      selectedIds,
      selectMode,
      actionMenuProjectId,
      actionMenuFolderId,
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

      {/* Filters bar — single row on wide, stacked on narrow */}
      <View className="px-4 py-2 gap-2">
        <View className="flex-row items-center gap-2 flex-wrap">
          {/* Search */}
          <View className="flex-row items-center bg-card border border-input rounded-lg px-3 h-9 min-w-[180px] flex-1">
            <Search size={16} className="text-muted-foreground" />
            <TextInput
              className="flex-1 ml-2 py-0 text-sm text-foreground web:outline-none"
              placeholder="Search projects..."
              placeholderTextColor="#71717a"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
              textAlignVertical="center"
            />
          </View>
          {/* Sort */}
          <Popover
            placement="bottom left"
            isOpen={sortOpen}
            onOpen={() => setSortOpen(true)}
            onClose={() => setSortOpen(false)}
            trigger={(triggerProps) => (
              <Pressable
                {...triggerProps}
                className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg border border-input"
              >
                <Text className="text-xs text-foreground">{sortLabel}</Text>
                <ChevronDown size={14} className="text-muted-foreground" />
              </Pressable>
            )}
          >
            <PopoverBackdrop />
            <PopoverContent className="p-0 min-w-[150px]">
              <PopoverBody>
                {([
                  { value: 'lastEdited' as SortBy, label: 'Last edited' },
                  { value: 'dateCreated' as SortBy, label: 'Date created' },
                  { value: 'alphabetical' as SortBy, label: 'Alphabetical' },
                ] as const).map((item) => (
                  <Pressable
                    key={item.value}
                    onPress={() => { setSortBy(item.value); setSortOpen(false) }}
                    className={cn('px-3 py-2 active:bg-muted', sortBy === item.value && 'bg-accent')}
                  >
                    <Text className={cn('text-xs', sortBy === item.value ? 'text-foreground font-medium' : 'text-foreground')}>
                      {item.label}
                    </Text>
                  </Pressable>
                ))}
              </PopoverBody>
            </PopoverContent>
          </Popover>

          {/* Visibility filter */}
          <Popover
            placement="bottom left"
            isOpen={visibilityOpen}
            onOpen={() => setVisibilityOpen(true)}
            onClose={() => setVisibilityOpen(false)}
            trigger={(triggerProps) => (
              <Pressable
                {...triggerProps}
                className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg border border-input"
              >
                <Text className="text-xs text-foreground">{visibilityLabel}</Text>
                <ChevronDown size={14} className="text-muted-foreground" />
              </Pressable>
            )}
          >
            <PopoverBackdrop />
            <PopoverContent className="p-0 min-w-[150px]">
              <PopoverBody>
                {([
                  { value: 'any' as VisibilityFilter, label: 'Any visibility' },
                  { value: 'public' as VisibilityFilter, label: 'Public' },
                  { value: 'private' as VisibilityFilter, label: 'Private' },
                ] as const).map((item) => (
                  <Pressable
                    key={item.value}
                    onPress={() => { setVisibilityFilter(item.value); setVisibilityOpen(false) }}
                    className={cn('px-3 py-2 active:bg-muted', visibilityFilter === item.value && 'bg-accent')}
                  >
                    <Text className={cn('text-xs', visibilityFilter === item.value ? 'text-foreground font-medium' : 'text-foreground')}>
                      {item.label}
                    </Text>
                  </Pressable>
                ))}
              </PopoverBody>
            </PopoverContent>
          </Popover>

          {/* Status filter */}
          <Popover
            placement="bottom left"
            isOpen={statusOpen}
            onOpen={() => setStatusOpen(true)}
            onClose={() => setStatusOpen(false)}
            trigger={(triggerProps) => (
              <Pressable
                {...triggerProps}
                className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg border border-input"
              >
                <Text className="text-xs text-foreground">{statusLabel}</Text>
                <ChevronDown size={14} className="text-muted-foreground" />
              </Pressable>
            )}
          >
            <PopoverBackdrop />
            <PopoverContent className="p-0 min-w-[150px]">
              <PopoverBody>
                {([
                  { value: 'any' as StatusFilter, label: 'Any status' },
                  { value: 'draft' as StatusFilter, label: 'Draft' },
                  { value: 'active' as StatusFilter, label: 'Active' },
                  { value: 'archived' as StatusFilter, label: 'Archived' },
                ] as const).map((item) => (
                  <Pressable
                    key={item.value}
                    onPress={() => { setStatusFilter(item.value); setStatusOpen(false) }}
                    className={cn('px-3 py-2 active:bg-muted', statusFilter === item.value && 'bg-accent')}
                  >
                    <Text className={cn('text-xs', statusFilter === item.value ? 'text-foreground font-medium' : 'text-foreground')}>
                      {item.label}
                    </Text>
                  </Pressable>
                ))}
              </PopoverBody>
            </PopoverContent>
          </Popover>

          {/* Spacer */}
          <View className="flex-1" />

          {/* Import project */}
          <Pressable
            onPress={handleImportProject}
            disabled={isImporting}
            className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg border border-input active:bg-muted"
          >
            <Download size={14} className="text-muted-foreground" />
            <Text className="text-xs text-foreground">{isImporting ? 'Importing...' : 'Import'}</Text>
          </Pressable>

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
              : item.type === 'spacer'
                ? `spacer-${index}`
                : item.type === 'folder'
                  ? `folder-${item.data.id}`
                  : `project-${item.data.id}`
          }
          renderItem={renderGridItem}
          numColumns={numColumns}
          contentContainerClassName="p-1"
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

      {/* Rename Project Modal */}
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
            <View className="flex-row items-center justify-between mb-1">
              <Text className="text-base font-semibold text-foreground">Create new folder</Text>
              <Pressable onPress={() => setNewFolderModalVisible(false)} className="p-1">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
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

      {/* Rename Folder Modal */}
      <Modal
        visible={!!renameFolder}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameFolder(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setRenameFolder(null)}
        >
          <Pressable
            className="bg-card rounded-xl p-6 w-80 border border-border"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="flex-row items-center justify-between mb-1">
              <Text className="text-base font-semibold text-foreground">Rename folder</Text>
              <Pressable onPress={() => setRenameFolder(null)} className="p-1">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
            <Text className="text-sm text-muted-foreground mb-4">
              Enter a new name for this folder
            </Text>
            <TextInput
              value={renameFolderValue}
              onChangeText={setRenameFolderValue}
              placeholder="Folder name"
              placeholderTextColor="#9ca3af"
              className="border border-border rounded-md px-3 py-2 text-sm text-foreground bg-background mb-4"
              autoFocus
              onSubmitEditing={confirmRenameFolder}
              selectTextOnFocus
            />
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setRenameFolder(null)}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmRenameFolder}
                className={cn(
                  'px-4 py-2 rounded-md',
                  renameFolderValue.trim() ? 'bg-primary active:bg-primary/80' : 'bg-muted'
                )}
                disabled={!renameFolderValue.trim()}
              >
                <Text className={cn(
                  'text-sm',
                  renameFolderValue.trim() ? 'text-primary-foreground' : 'text-muted-foreground'
                )}>
                  Rename
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Delete Folder Confirmation Modal */}
      <Modal
        visible={!!singleDeleteFolder}
        transparent
        animationType="fade"
        onRequestClose={() => setSingleDeleteFolder(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setSingleDeleteFolder(null)}
        >
          <Pressable
            className="bg-card rounded-xl p-6 w-80 border border-border"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="flex-row items-center gap-3 mb-3">
              <View className="w-10 h-10 rounded-full bg-destructive/10 items-center justify-center">
                <Trash2 size={20} className="text-destructive" />
              </View>
              <Text className="text-base font-semibold text-foreground">Delete folder</Text>
            </View>
            <Text className="text-sm text-muted-foreground mb-5">
              Are you sure you want to delete &quot;{singleDeleteFolder?.name}&quot;? This action cannot be undone.
            </Text>
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setSingleDeleteFolder(null)}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmDeleteFolder}
                className="px-4 py-2 rounded-md bg-destructive active:bg-destructive/80"
              >
                <Text className="text-sm text-white font-medium">Delete</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Move to Folder Modal */}
      <Modal
        visible={moveToFolderModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMoveToFolderModalVisible(false)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setMoveToFolderModalVisible(false)}
        >
          <Pressable
            className="bg-card rounded-xl p-5 w-80 border border-border max-h-[400px]"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-base font-semibold text-foreground">Move to folder</Text>
              <Pressable onPress={() => setMoveToFolderModalVisible(false)} className="p-1">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>

            <Pressable
              onPress={() => handleBulkMoveToFolder(null)}
              className="flex-row items-center gap-3 px-3 py-2.5 rounded-lg active:bg-muted mb-1"
            >
              <FolderOpen size={18} className="text-muted-foreground" />
              <Text className="text-sm text-foreground flex-1">Root (no folder)</Text>
            </Pressable>

            {allFolders.map((folder) => (
              <Pressable
                key={folder.id}
                onPress={() => handleBulkMoveToFolder(folder.id)}
                className={cn(
                  'flex-row items-center gap-3 px-3 py-2.5 rounded-lg active:bg-muted mb-1',
                  folder.id === currentFolderId && 'bg-accent',
                )}
              >
                <FolderOpen size={18} className="text-muted-foreground" />
                <Text className="text-sm text-foreground flex-1">{folder.name}</Text>
                {folder.id === currentFolderId && (
                  <Text className="text-xs text-muted-foreground">Current</Text>
                )}
              </Pressable>
            ))}

            {allFolders.length === 0 && (
              <View className="py-4 items-center">
                <Text className="text-sm text-muted-foreground">No folders available</Text>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Transfer to Workspace Modal */}
      <Modal
        visible={transferModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTransferModalVisible(false)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setTransferModalVisible(false)}
        >
          <Pressable
            className="bg-card rounded-xl p-5 w-80 border border-border max-h-[400px]"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="flex-row items-center justify-between mb-1">
              <Text className="text-base font-semibold text-foreground">Transfer to workspace</Text>
              <Pressable onPress={() => setTransferModalVisible(false)} className="p-1">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
            <Text className="text-sm text-muted-foreground mb-4">
              Move {selectedIds.size} project{selectedIds.size !== 1 ? 's' : ''} to another workspace
            </Text>

            {workspaces.filter((w: any) => w.id !== currentWorkspace?.id).length === 0 ? (
              <View className="py-6 items-center">
                <Text className="text-sm text-muted-foreground text-center">
                  You only have one workspace.{'\n'}Create another workspace to transfer projects.
                </Text>
              </View>
            ) : (
              workspaces
                .filter((w: any) => w.id !== currentWorkspace?.id)
                .map((workspace: any) => (
                  <Pressable
                    key={workspace.id}
                    onPress={() => executeTransfer(workspace.id)}
                    className="flex-row items-center gap-3 px-3 py-2.5 rounded-lg active:bg-muted mb-1"
                  >
                    <View className="w-8 h-8 rounded-full bg-primary/10 items-center justify-center">
                      <Text className="text-xs font-medium text-primary">
                        {workspace.name?.charAt(0)?.toUpperCase() || 'W'}
                      </Text>
                    </View>
                    <Text className="text-sm text-foreground flex-1">{workspace.name}</Text>
                  </Pressable>
                ))
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Single Delete Confirmation Modal */}
      <Modal
        visible={!!singleDeleteProject}
        transparent
        animationType="fade"
        onRequestClose={() => setSingleDeleteProject(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setSingleDeleteProject(null)}
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
              Are you sure you want to delete &quot;{singleDeleteProject?.name}&quot;? This action cannot be undone.
            </Text>
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setSingleDeleteProject(null)}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmSingleDelete}
                className="px-4 py-2 rounded-md bg-destructive active:bg-destructive/80"
              >
                <Text className="text-sm text-white font-medium">Delete</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Bulk Delete Confirmation Modal */}
      <Modal
        visible={deleteConfirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteConfirmVisible(false)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setDeleteConfirmVisible(false)}
        >
          <Pressable
            className="bg-card rounded-xl p-6 w-80 border border-border"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="flex-row items-center gap-3 mb-3">
              <View className="w-10 h-10 rounded-full bg-destructive/10 items-center justify-center">
                <Trash2 size={20} className="text-destructive" />
              </View>
              <Text className="text-base font-semibold text-foreground">Delete projects</Text>
            </View>
            <Text className="text-sm text-muted-foreground mb-5">
              Are you sure you want to delete {selectedIds.size} project{selectedIds.size !== 1 ? 's' : ''}? This action cannot be undone.
            </Text>
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setDeleteConfirmVisible(false)}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                testID="confirm-bulk-delete-btn"
                onPress={confirmBulkDelete}
                className="px-4 py-2 rounded-md bg-destructive active:bg-destructive/80"
              >
                <Text className="text-sm text-white font-medium">Delete</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Multi-select Bottom Action Bar */}
      {selectMode && (
        <View className="border-t border-border bg-card px-4 py-3">
          {selectedIds.size === 0 ? (
            <View className="flex-row items-center justify-center gap-4">
              <Pressable
                testID="select-all-btn"
                onPress={handleSelectAll}
                className="flex-row items-center gap-2"
              >
                <View className="w-5 h-5 rounded border-2 border-muted-foreground/40 items-center justify-center" />
                <Text className="text-sm text-foreground">
                  Select all ({filteredProjects.length})
                </Text>
              </Pressable>
              <Pressable testID="cancel-select-btn" onPress={handleCancelSelectMode}>
                <Text className="text-sm text-muted-foreground">Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <View className="flex-row items-center justify-center gap-3 flex-wrap">
              <Pressable
                onPress={handleSelectAll}
                className="flex-row items-center gap-2"
              >
                <View className={cn(
                  'w-5 h-5 rounded border-2 items-center justify-center',
                  selectedIds.size === filteredProjects.length
                    ? 'bg-primary border-primary'
                    : 'bg-primary/60 border-primary/60',
                )}>
                  <Check size={12} color="#fff" />
                </View>
                <Text className="text-sm font-medium text-foreground">
                  {selectedIds.size} selected
                </Text>
              </Pressable>

              <View className="w-px h-5 bg-border" />

              <Pressable
                testID="move-to-folder-btn"
                onPress={() => setMoveToFolderModalVisible(true)}
                className="flex-row items-center gap-1.5 px-2 py-1 rounded-md active:bg-muted"
              >
                <FolderInput size={15} className="text-muted-foreground" />
                <Text className="text-sm text-foreground">Move to folder</Text>
              </Pressable>

              <Pressable
                testID="transfer-btn"
                onPress={handleBulkTransfer}
                className="flex-row items-center gap-1.5 px-2 py-1 rounded-md active:bg-muted"
              >
                <ArrowRightLeft size={15} className="text-muted-foreground" />
                <Text className="text-sm text-foreground">Transfer</Text>
              </Pressable>

              <Pressable
                testID="bulk-delete-btn"
                onPress={handleBulkDelete}
                className="flex-row items-center gap-1.5 px-2 py-1 rounded-md active:bg-muted"
              >
                <Trash2 size={15} className="text-destructive" />
                <Text className="text-sm text-destructive">Delete</Text>
              </Pressable>

              <View className="w-px h-5 bg-border" />

              <Pressable testID="clear-selection-btn" onPress={handleClearSelection}>
                <Text className="text-sm text-muted-foreground">Clear</Text>
              </Pressable>

              <Pressable testID="cancel-select-mode-btn" onPress={handleCancelSelectMode}>
                <Text className="text-sm text-muted-foreground">Cancel</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  )
})
