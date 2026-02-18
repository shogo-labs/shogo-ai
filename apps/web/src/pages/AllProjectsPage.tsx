/**
 * AllProjectsPage - Projects listing page matching lovable.dev design
 * 
 * Features:
 * - Search bar for filtering projects
 * - Sorting options (Last edited, Date created, Alphabetical)
 * - View toggle (Grid/List)
 * - Project cards with star, timestamps, and action menus
 * - "Create new project" card
 * - Folder system with create, rename, delete, move
 * - Multi-select mode with bulk operations
 * - Breadcrumb navigation for folder views
 */

import { useState, useMemo, useCallback, useEffect } from "react"
import { observer } from "mobx-react-lite"
import { useNavigate, Link, useSearchParams } from "react-router-dom"
import { formatDistanceToNow } from "date-fns"
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  Search,
  Plus,
  Star,
  MoreHorizontal,
  LayoutGrid,
  List,
  ChevronDown,
  ChevronRight,
  Check,
  Pencil,
  Settings,
  Trash2,
  FolderOpen,
  FolderPlus,
  FolderInput,
  FolderX,
  CheckSquare,
  ArrowLeft,
  Copy,
  X,
  GripVertical,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useWorkspaceData, useWorkspaceNavigation } from "@/components/app/workspace/hooks"
import { CreateProjectModal } from "@/components/app/workspace/CreateProjectModal"
import { Label } from "@/components/ui/label"
import { useSDKDomain } from "@/contexts/DomainProvider"
import type { IDomainStore } from "@/generated/domain"
import { useDomainActions } from "@/generated/domain-actions"
import { useSession } from "@/contexts/SessionProvider"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"

// Types
type SortBy = "lastEdited" | "dateCreated" | "alphabetical"
type SortOrder = "newest" | "oldest"
type ViewMode = "grid" | "list"
type VisibilityFilter = "any" | "public" | "private"
type StatusFilter = "any" | "active" | "archived"

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
  workspace?: { id: string }
  createdAt: number
  updatedAt?: number
}

// Helper to get time ago text
function getTimeAgo(timestamp: number): string {
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true })
}

// Project card placeholder colors based on project name
function getPlaceholderGradient(name: string): string {
  const colors = [
    "from-purple-500 to-blue-500",
    "from-pink-500 to-rose-500",
    "from-orange-500 to-amber-500",
    "from-green-500 to-emerald-500",
    "from-cyan-500 to-blue-500",
    "from-violet-500 to-purple-500",
    "from-fuchsia-500 to-pink-500",
    "from-teal-500 to-cyan-500",
  ]
  const index = name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length
  return colors[index]
}

// ============================================================================
// Drag & Drop Components
// ============================================================================

/** Wrapper that makes a project card draggable */
function DraggableProjectCard({ project, children }: { project: Project; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `project-${project.id}`,
    data: { type: "project", project },
  })

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className="relative"
    >
      {/* Drag handle overlay - visible on hover */}
      <div
        {...listeners}
        {...attributes}
        className="absolute top-2 left-2 z-10 p-1 rounded-md bg-black/40 text-white/80 opacity-0 hover:opacity-100 cursor-grab active:cursor-grabbing transition-opacity"
        title="Drag to move to a folder"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </div>
      {children}
    </div>
  )
}

/** Wrapper that makes a folder card a drop target */
function DroppableFolderCard({
  folder,
  children,
}: {
  folder: Folder
  children: (isOver: boolean) => React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-${folder.id}`,
    data: { type: "folder", folderId: folder.id, folderName: folder.name },
  })

  return <div ref={setNodeRef}>{children(isOver)}</div>
}

/** Drop target for moving projects to root (no folder) */
function DroppableRoot({ children }: { children: (isOver: boolean) => React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: "root",
    data: { type: "root" },
  })

  return <div ref={setNodeRef}>{children(isOver)}</div>
}

/** Preview card shown while dragging */
function DragOverlayCard({ project }: { project: Project }) {
  return (
    <div className="w-64 rounded-xl bg-card shadow-2xl border border-border overflow-hidden pointer-events-none">
      <div className={cn(
        "aspect-[16/10] bg-gradient-to-br",
        getPlaceholderGradient(project.name)
      )}>
        <div className="absolute inset-0 flex items-center justify-center">
          <FolderOpen className="h-10 w-10 text-white/30" />
        </div>
      </div>
      <div className="p-3">
        <p className="font-medium text-sm truncate">{project.name}</p>
      </div>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export const AllProjectsPage = observer(function AllProjectsPage() {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const { toast } = useToast()
  const actions = useDomainActions()
  const { currentWorkspace, projects, folders, currentFolder, folderBreadcrumbs, refetchProjects, refetchFolders, starredProjectIds, toggleStarProject: toggleStar } = useWorkspaceData()
  const { folderId, setFolderId, clearFolder } = useWorkspaceNavigation()

  // State
  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState<SortBy>("lastEdited")
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest")
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("any")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("any")
  
  // Create project modal state
  const [showCreateModal, setShowCreateModal] = useState(false)

  // Delete dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Rename dialog state
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [projectToRename, setProjectToRename] = useState<Project | null>(null)
  const [newName, setNewName] = useState("")
  const [isRenaming, setIsRenaming] = useState(false)

  // Folder dialog state
  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)

  const [renameFolderDialogOpen, setRenameFolderDialogOpen] = useState(false)
  const [folderToRename, setFolderToRename] = useState<Folder | null>(null)
  const [renameFolderName, setRenameFolderName] = useState("")
  const [isRenamingFolder, setIsRenamingFolder] = useState(false)

  const [deleteFolderDialogOpen, setDeleteFolderDialogOpen] = useState(false)
  const [folderToDelete, setFolderToDelete] = useState<Folder | null>(null)
  const [isDeletingFolder, setIsDeletingFolder] = useState(false)

  // Move project to folder dialog state
  const [moveProjectDialogOpen, setMoveProjectDialogOpen] = useState(false)
  const [projectToMove, setProjectToMove] = useState<Project | null>(null)
  const [targetFolderId, setTargetFolderId] = useState<string | null>(null)
  const [isMovingProject, setIsMovingProject] = useState(false)

  // Multi-select mode state
  const [isSelectMode, setIsSelectMode] = useState(false)
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set())

  // Drag & drop state
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Require 8px of movement before starting drag to avoid conflicts with clicks
      activationConstraint: { distance: 8 },
    })
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event
    if (active.data.current?.type === "project") {
      setActiveProject(active.data.current.project as Project)
    }
  }, [])

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event
    setActiveProject(null)

    if (!over || !active.data.current) return

    const project = active.data.current.project as Project
    const overData = over.data.current

    if (!overData) return

    // Determine the target folder
    let newFolderId: string | null = null
    let folderName = "root"
    if (overData.type === "folder") {
      newFolderId = overData.folderId as string
      folderName = overData.folderName as string
    }
    // overData.type === "root" → newFolderId stays null

    // Skip if project is already in the target folder
    if ((project.folderId || null) === newFolderId) return

    try {
      await actions.moveProjectToFolder(project.id, newFolderId)
      refetchProjects()
      toast({
        title: "Project moved",
        description: newFolderId
          ? `"${project.name}" moved to "${folderName}"`
          : `"${project.name}" moved to root`,
      })
    } catch (error) {
      console.error("Failed to move project:", error)
      toast({ title: "Failed to move project", description: String(error), variant: "destructive" })
    }
  }, [actions, refetchProjects, toast])

  // Get sort label
  const sortLabel = useMemo(() => {
    switch (sortBy) {
      case "lastEdited": return "Last edited"
      case "dateCreated": return "Date created"
      case "alphabetical": return "Alphabetical"
    }
  }, [sortBy])

  // Filter folders to show in current view
  const currentFolders = useMemo(() => {
    let result = (folders as Folder[]).filter(f => {
      // Show folders that match the current location
      if (folderId) {
        return f.parentId === folderId
      }
      // At root level, show folders with no parent
      return !f.parentId
    })

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(f => f.name.toLowerCase().includes(query))
    }

    // Sort folders by name
    result.sort((a, b) => a.name.localeCompare(b.name))

    return result
  }, [folders, folderId, searchQuery])

  // Filter and sort projects
  const filteredProjects = useMemo(() => {
    let result = [...projects] as Project[]

    // Filter by current folder
    if (folderId) {
      result = result.filter(p => p.folderId === folderId)
    } else {
      // At root level, show projects with no folder
      result = result.filter(p => !p.folderId)
    }

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.description?.toLowerCase().includes(query)
      )
    }

    // Status filter
    if (statusFilter !== "any") {
      result = result.filter(p =>
        statusFilter === "active"
          ? p.status !== "archived"
          : p.status === "archived"
      )
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0
      switch (sortBy) {
        case "lastEdited":
          comparison = (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
          break
        case "dateCreated":
          comparison = b.createdAt - a.createdAt
          break
        case "alphabetical":
          comparison = a.name.localeCompare(b.name)
          break
      }
      return sortOrder === "oldest" ? -comparison : comparison
    })

    return result
  }, [projects, folderId, searchQuery, sortBy, sortOrder, statusFilter])

  // Handlers
  const handleProjectClick = useCallback((project: Project) => {
    // Navigate to the full-screen project view
    navigate(`/projects/${project.id}`)
  }, [navigate])

  const handleToggleStar = useCallback(async (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!currentWorkspace?.id) return
    await toggleStar(projectId, currentWorkspace.id)
  }, [currentWorkspace?.id, toggleStar])

  const handleRename = useCallback(async () => {
    if (!projectToRename || !newName.trim()) return
    
    setIsRenaming(true)
    try {
      // Update the project name via SDK domain actions
      await actions.updateProject(projectToRename.id, { name: newName.trim() })
      refetchProjects()
      setRenameDialogOpen(false)
      setProjectToRename(null)
      setNewName("")
    } catch (error) {
      console.error("Failed to rename project:", error)
    } finally {
      setIsRenaming(false)
    }
  }, [projectToRename, newName, actions, refetchProjects])

  const handleDelete = useCallback(async () => {
    if (!projectToDelete) return
    
    setIsDeleting(true)
    try {
      await actions.deleteProject(projectToDelete.id)
      refetchProjects()
      setDeleteDialogOpen(false)
      setProjectToDelete(null)
    } catch (error) {
      console.error("Failed to delete project:", error)
    } finally {
      setIsDeleting(false)
    }
  }, [projectToDelete, actions, refetchProjects])

  const openRenameDialog = (project: Project, e: React.MouseEvent) => {
    e.stopPropagation()
    setProjectToRename(project)
    setNewName(project.name)
    setRenameDialogOpen(true)
  }

  const openDeleteDialog = (project: Project, e: React.MouseEvent) => {
    e.stopPropagation()
    setProjectToDelete(project)
    setDeleteDialogOpen(true)
  }

  // Folder handlers
  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !currentWorkspace?.id) return

    setIsCreatingFolder(true)
    try {
      // Pass null for root folders (API expects null, collection normalizes to undefined for MST)
      await actions.createFolder(
        newFolderName.trim(),
        currentWorkspace.id,
        folderId || null
      )
      refetchFolders()
      setCreateFolderDialogOpen(false)
      setNewFolderName("")
      toast({ title: "Folder created", description: `"${newFolderName.trim()}" has been created.` })
    } catch (error) {
      console.error("Failed to create folder:", error)
      toast({ title: "Failed to create folder", description: String(error), variant: "destructive" })
    } finally {
      setIsCreatingFolder(false)
    }
  }, [newFolderName, actions, currentWorkspace?.id, folderId, refetchFolders, toast])

  const handleRenameFolder = useCallback(async () => {
    if (!folderToRename || !renameFolderName.trim()) return

    setIsRenamingFolder(true)
    try {
      await actions.updateFolder(folderToRename.id, { name: renameFolderName.trim() })
      refetchFolders()
      setRenameFolderDialogOpen(false)
      setFolderToRename(null)
      setRenameFolderName("")
      toast({ title: "Folder renamed" })
    } catch (error) {
      console.error("Failed to rename folder:", error)
      toast({ title: "Failed to rename folder", description: String(error), variant: "destructive" })
    } finally {
      setIsRenamingFolder(false)
    }
  }, [folderToRename, renameFolderName, actions, refetchFolders, toast])

  const handleDeleteFolder = useCallback(async () => {
    if (!folderToDelete) return

    setIsDeletingFolder(true)
    const folderName = folderToDelete.name
    try {
      await actions.deleteFolder(folderToDelete.id)
      refetchFolders()
      refetchProjects() // Projects may have moved
      setDeleteFolderDialogOpen(false)
      setFolderToDelete(null)
      toast({ title: "Folder deleted", description: `"${folderName}" has been deleted.` })
    } catch (error) {
      console.error("Failed to delete folder:", error)
      toast({ title: "Failed to delete folder", description: String(error), variant: "destructive" })
    } finally {
      setIsDeletingFolder(false)
    }
  }, [folderToDelete, actions, refetchFolders, refetchProjects, toast])

  const handleMoveProjectToFolder = useCallback(async () => {
    if (!projectToMove) return

    setIsMovingProject(true)
    try {
      await actions.moveProjectToFolder(projectToMove.id, targetFolderId)
      refetchProjects()
      setMoveProjectDialogOpen(false)
      setProjectToMove(null)
      setTargetFolderId(null)
      toast({ title: "Project moved" })
    } catch (error) {
      console.error("Failed to move project:", error)
      toast({ title: "Failed to move project", description: String(error), variant: "destructive" })
    } finally {
      setIsMovingProject(false)
    }
  }, [projectToMove, targetFolderId, actions, refetchProjects, toast])

  const openRenameFolderDialog = (folder: Folder, e: React.MouseEvent) => {
    e.stopPropagation()
    setFolderToRename(folder)
    setRenameFolderName(folder.name)
    setRenameFolderDialogOpen(true)
  }

  const openDeleteFolderDialog = (folder: Folder, e: React.MouseEvent) => {
    e.stopPropagation()
    setFolderToDelete(folder)
    setDeleteFolderDialogOpen(true)
  }

  const openMoveProjectDialog = (project: Project, e: React.MouseEvent) => {
    e.stopPropagation()
    setProjectToMove(project)
    setTargetFolderId(project.folderId || null)
    setMoveProjectDialogOpen(true)
  }

  const handleFolderClick = useCallback((folder: Folder) => {
    setFolderId(folder.id)
  }, [setFolderId])

  const handleBackToRoot = useCallback(() => {
    clearFolder()
  }, [clearFolder])

  const handleBreadcrumbClick = useCallback((folder: Folder) => {
    setFolderId(folder.id)
  }, [setFolderId])

  // Multi-select handlers
  const handleToggleSelectMode = useCallback(() => {
    setIsSelectMode(prev => {
      // Clear selections when exiting select mode
      if (prev) {
        setSelectedProjectIds(new Set())
      }
      return !prev
    })
  }, [])

  const handleToggleProjectSelection = useCallback((projectId: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation()
    }
    setSelectedProjectIds(prev => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    setSelectedProjectIds(new Set(filteredProjects.map(p => p.id)))
  }, [filteredProjects])

  const handleDeselectAll = useCallback(() => {
    setSelectedProjectIds(new Set())
  }, [])

  // Bulk operations
  const handleBulkDelete = useCallback(async () => {
    if (selectedProjectIds.size === 0) return
    
    setIsDeleting(true)
    try {
      await Promise.all(
        Array.from(selectedProjectIds).map(id => actions.deleteProject(id))
      )
      refetchProjects()
      setSelectedProjectIds(new Set())
      setIsSelectMode(false)
    } catch (error) {
      console.error("Failed to delete projects:", error)
    } finally {
      setIsDeleting(false)
    }
  }, [selectedProjectIds, actions, refetchProjects])

  const handleBulkMove = useCallback(async () => {
    if (selectedProjectIds.size === 0) return

    setIsMovingProject(true)
    try {
      await Promise.all(
        Array.from(selectedProjectIds).map(id => actions.moveProjectToFolder(id, targetFolderId))
      )
      refetchProjects()
      setSelectedProjectIds(new Set())
      setIsSelectMode(false)
      setMoveProjectDialogOpen(false)
      setTargetFolderId(null)
    } catch (error) {
      console.error("Failed to move projects:", error)
    } finally {
      setIsMovingProject(false)
    }
  }, [selectedProjectIds, targetFolderId, actions, refetchProjects])

  const openBulkMoveDialog = useCallback(() => {
    setMoveProjectDialogOpen(true)
    setTargetFolderId(null)
  }, [])

  // Get root folders for move dialog
  const rootFolders = useMemo(() => {
    return (folders as Folder[]).filter(f => !f.parentId)
  }, [folders])

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
    <div className="flex flex-col h-full">
      {/* Header */}
      <nav className="px-6 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold">Projects</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2 gap-1">
                <MoreHorizontal className="h-4 w-4" />
                <span className="text-xs text-muted-foreground">More options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => { refetchProjects(); refetchFolders(); }}>
                Refresh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>

      {/* Breadcrumb Navigation */}
      {(currentFolder || folderBreadcrumbs.length > 0) && (
        <div className="flex items-center gap-1 px-6 py-2 border-b text-sm">
          <DroppableRoot>
            {(isOver) => (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBackToRoot}
                className={cn(
                  "h-7 px-2 gap-1 text-muted-foreground hover:text-foreground transition-all",
                  isOver && "ring-2 ring-primary bg-primary/10 text-foreground"
                )}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                All Projects
              </Button>
            )}
          </DroppableRoot>
          {folderBreadcrumbs.map((folder: Folder) => (
            <div key={folder.id} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleBreadcrumbClick(folder)}
                className="h-7 px-2 text-muted-foreground hover:text-foreground"
              >
                {folder.name}
              </Button>
            </div>
          ))}
          {currentFolder && (
            <div className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="px-2 font-medium">{currentFolder.name}</span>
            </div>
          )}
        </div>
      )}

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-2">
        {/* Search */}
        <div className="relative min-w-[180px] max-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>

        {/* Filters */}
        <div className="flex items-center gap-1.5">
          {/* Sort dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1 text-xs">
                {sortLabel}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel className="text-xs">Sort by</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSortBy("lastEdited")} className="text-sm">
                Last edited
                {sortBy === "lastEdited" && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSortBy("dateCreated")} className="text-sm">
                Date created
                {sortBy === "dateCreated" && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSortBy("alphabetical")} className="text-sm">
                Alphabetical
                {sortBy === "alphabetical" && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Visibility filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1 text-xs">
                {visibilityFilter === "any" ? "Any visibility" : visibilityFilter === "public" ? "Public" : "Private"}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => setVisibilityFilter("any")} className="text-sm">
                Any visibility
                {visibilityFilter === "any" && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setVisibilityFilter("public")} className="text-sm">
                Public
                {visibilityFilter === "public" && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setVisibilityFilter("private")} className="text-sm">
                Private
                {visibilityFilter === "private" && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Status filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1 text-xs">
                {statusFilter === "any" ? "Any status" : statusFilter === "active" ? "Active" : "Archived"}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => setStatusFilter("any")} className="text-sm">
                Any status
                {statusFilter === "any" && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter("active")} className="text-sm">
                Active
                {statusFilter === "active" && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter("archived")} className="text-sm">
                Archived
                {statusFilter === "archived" && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* All creators filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1 text-xs">
                All creators
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem className="text-sm">
                All creators
                <Check className="ml-auto h-4 w-4" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* New folder button */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1 text-xs"
          onClick={() => setCreateFolderDialogOpen(true)}
        >
          <FolderPlus className="h-3.5 w-3.5" />
          New folder
        </Button>

        {/* Select projects button */}
        <Button 
          variant={isSelectMode ? "secondary" : "ghost"} 
          size="sm" 
          className="h-8 w-8 p-0"
          onClick={handleToggleSelectMode}
          title={isSelectMode ? "Exit select mode" : "Select projects"}
        >
          <CheckSquare className="h-4 w-4" />
        </Button>

        {/* Bulk actions - show when in select mode with selections */}
        {isSelectMode && selectedProjectIds.size > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
              {selectedProjectIds.size} selected
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs"
              onClick={handleSelectAll}
            >
              Select all
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs"
              onClick={handleDeselectAll}
            >
              Deselect all
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs"
              onClick={openBulkMoveDialog}
            >
              <FolderInput className="h-3.5 w-3.5" />
              Move
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs text-destructive hover:text-destructive"
              onClick={handleBulkDelete}
              disabled={isDeleting}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </>
        )}

        {/* View toggle */}
        <div className="flex items-center gap-0.5 ml-auto">
          <Button
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setViewMode("grid")}
            title="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setViewMode("list")}
            title="List view"
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 pt-4">
        {viewMode === "grid" ? (
          // Grid View - 3 columns max to match Lovable's larger card style
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Create new project card */}
            <button
              onClick={() => setShowCreateModal(true)}
              className="group flex flex-col rounded-xl border-2 border-dashed border-muted-foreground/20 hover:border-primary/40 transition-colors overflow-hidden text-left"
            >
              <div className="relative aspect-[16/10] flex flex-col items-center justify-center gap-2 bg-muted/30">
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted group-hover:bg-muted-foreground/10 transition-colors">
                  <Plus className="h-5 w-5 text-muted-foreground" />
                </div>
              </div>
              <div className="p-3 text-center">
                <span className="text-sm text-muted-foreground">Create new project</span>
              </div>
            </button>

            {/* Folder cards (drop targets) */}
            {currentFolders.map((folder) => (
              <DroppableFolderCard key={folder.id} folder={folder}>
                {(isOver) => (
                  <div
                    onClick={() => handleFolderClick(folder)}
                    className={cn(
                      "group flex flex-col rounded-xl bg-card overflow-hidden hover:shadow-md transition-all cursor-pointer",
                      isOver && "ring-2 ring-primary shadow-lg scale-[1.02]"
                    )}
                  >
                    {/* Folder preview area */}
                    <div className={cn(
                      "relative aspect-[16/10] bg-muted flex items-center justify-center transition-colors",
                      isOver && "bg-primary/10"
                    )}>
                      <FolderOpen className={cn(
                        "h-12 w-12 transition-colors",
                        isOver ? "text-primary/60" : "text-muted-foreground/40"
                      )} />
                      {isOver && (
                        <p className="absolute bottom-2 text-xs font-medium text-primary">Drop to move here</p>
                      )}
                    </div>

                    {/* Info area */}
                    <div className="flex items-start gap-2.5 p-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate leading-tight">{folder.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {(projects as Project[]).filter(p => p.folderId === folder.id).length} projects
                        </p>
                      </div>

                      {/* Folder actions menu */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={(e) => openRenameFolderDialog(folder, e as any)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={(e) => openDeleteFolderDialog(folder, e as any)}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                )}
              </DroppableFolderCard>
            ))}

            {/* Project cards (draggable) */}
            {filteredProjects.map((project) => (
              <DraggableProjectCard key={project.id} project={project}>
                <div
                  onClick={() => {
                  if (isSelectMode) {
                    handleToggleProjectSelection(project.id)
                  } else {
                    handleProjectClick(project)
                  }
                }}
                  className={cn(
                  "group flex flex-col rounded-xl bg-card overflow-hidden hover:shadow-md transition-all",
                  isSelectMode ? "cursor-pointer" : "cursor-pointer",
                  isSelectMode && selectedProjectIds.has(project.id) && "ring-2 ring-primary"
                )}
                >
                  {/* Preview area */}
                  <div className={cn(
                    "relative aspect-[16/10] bg-gradient-to-br",
                    getPlaceholderGradient(project.name)
                  )}>
                    {/* Project icon */}
                    <div className="absolute inset-0 flex items-center justify-center">
                      <FolderOpen className="h-10 w-10 text-white/30" />
                    </div>

                    {/* Checkbox in select mode */}
                  {isSelectMode && (
                    <div className="absolute top-2 left-2">
                      <Checkbox
                        checked={selectedProjectIds.has(project.id)}
                        onCheckedChange={() => handleToggleProjectSelection(project.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-white/90 border-white/20"
                      />
                    </div>
                  )}

                  {/* Star button - shows on hover (hidden in select mode) */}
                  {!isSelectMode && (
                      <button
                        onClick={(e) => handleToggleStar(project.id, e)}
                        className={cn(
                          "absolute top-2 right-2 p-1.5 rounded-md transition-all",
                          starredProjectIds.has(project.id)
                            ? "bg-yellow-500/90 text-white opacity-100"
                            : "bg-black/30 text-white/90 opacity-0 group-hover:opacity-100 hover:bg-black/50"
                        )}
                        title={starredProjectIds.has(project.id) ? "Remove from favorites" : "Add to favorites"}
                      >
                        <Star className={cn("h-3.5 w-3.5", starredProjectIds.has(project.id) && "fill-current")} />
                      </button>
                  )}
                  </div>

                  {/* Info area */}
                  <div className="flex items-start gap-2.5 p-3">
                    {/* Creator avatar - clickable */}
                    <Link
                      to="#"
                      onClick={(e) => e.stopPropagation()}
                      className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-medium hover:ring-2 hover:ring-primary/20 transition-all"
                    >
                      {session?.user?.name?.charAt(0) || "U"}
                    </Link>

                    {/* Name and time */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate leading-tight">{project.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Edited {getTimeAgo(project.updatedAt || project.createdAt)}
                      </p>
                    </div>

                    {/* Actions menu - hidden in select mode */}
                  {!isSelectMode && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={(e) => openMoveProjectDialog(project, e as any)}>
                            <FolderInput className="mr-2 h-4 w-4" />
                            Move to folder
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={(e) => openRenameDialog(project, e as any)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/projects/${project.id}/settings?tab=project`)
                          }}>
                            <Settings className="mr-2 h-4 w-4" />
                            Settings
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={(e) => openDeleteDialog(project, e as any)}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                  )}
                  </div>
                </div>
              </DraggableProjectCard>
            ))}
          </div>
        ) : (
          // List View
          <div className="space-y-0">
            {/* Header row */}
            <div className="grid grid-cols-[1fr_120px_140px] gap-4 px-3 py-2 text-xs font-medium text-muted-foreground">
              <div>Name</div>
              <div>Created at</div>
              <div>Created by</div>
            </div>

            {/* Folder rows (drop targets) */}
            <div className="space-y-0">
              {currentFolders.map((folder) => (
                <DroppableFolderCard key={folder.id} folder={folder}>
                  {(isOver) => (
                    <div
                      onClick={() => handleFolderClick(folder)}
                      className={cn(
                        "group grid grid-cols-[1fr_120px_140px] gap-4 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-all items-center cursor-pointer",
                        isOver && "ring-2 ring-primary bg-primary/10"
                      )}
                    >
                      {/* Name column with folder icon */}
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={cn(
                          "flex-shrink-0 w-12 h-8 rounded-md bg-muted flex items-center justify-center transition-colors",
                          isOver && "bg-primary/20"
                        )}>
                          <FolderOpen className={cn(
                            "h-4 w-4 transition-colors",
                            isOver ? "text-primary" : "text-muted-foreground"
                          )} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm truncate">{folder.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {(projects as Project[]).filter(p => p.folderId === folder.id).length} projects
                            {isOver && " · Drop to move here"}
                          </p>
                        </div>
                      </div>

                      {/* Created at column */}
                      <div className="text-sm text-muted-foreground">
                        {folder.createdAt ? getTimeAgo(folder.createdAt) : "—"}
                      </div>

                      {/* Actions column */}
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">—</span>
                        
                        {/* Actions */}
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                }}
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={(e) => openRenameFolderDialog(folder, e as any)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={(e) => openDeleteFolderDialog(folder, e as any)}
                                className="text-destructive"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>
                  )}
                </DroppableFolderCard>
              ))}
            </div>

            {/* Project rows */}
            <div className="space-y-0">
              {filteredProjects.map((project) => {
                const isSelected = selectedProjectIds.has(project.id)
                return (
                  <div
                    key={project.id}
                    onClick={() => {
                      if (isSelectMode) {
                        handleToggleProjectSelection(project.id)
                      } else {
                        handleProjectClick(project)
                      }
                    }}
                    className={cn(
                      "group grid grid-cols-[1fr_120px_140px] gap-4 px-3 py-2.5 rounded-lg transition-colors items-center cursor-pointer",
                      isSelectMode && isSelected && "bg-accent ring-2 ring-primary"
                    )}
                  >
                    {/* Name column with preview */}
                    <div className="flex items-center gap-3 min-w-0">
                      {isSelectMode && (
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => handleToggleProjectSelection(project.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="mr-1"
                        />
                      )}
                      <div className={cn(
                        "flex-shrink-0 w-12 h-8 rounded-md bg-gradient-to-br flex items-center justify-center overflow-hidden",
                        getPlaceholderGradient(project.name)
                      )}>
                        <FolderOpen className="h-4 w-4 text-white/50" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">{project.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Edited {getTimeAgo(project.updatedAt || project.createdAt)}
                        </p>
                      </div>
                    </div>

                  {/* Created at column */}
                  <div className="text-sm text-muted-foreground">
                    {getTimeAgo(project.createdAt)}
                  </div>

                  {/* Created by column */}
                  <div className="flex items-center justify-between">
                    {!isSelectMode && (
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-accent transition-colors"
                      >
                        <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-medium">
                          {session?.user?.name?.charAt(0) || "U"}
                        </div>
                        <span className="text-xs">{session?.user?.name || "User"}</span>
                      </button>
                    )}

                    {/* Actions - hidden in select mode */}
                    {!isSelectMode && (
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            handleToggleStar(project.id, e)
                          }}
                        >
                          <Star className={cn(
                            "h-4 w-4",
                            starredProjectIds.has(project.id) && "fill-yellow-500 text-yellow-500"
                          )} />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                              }}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={(e) => openRenameDialog(project, e as any)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => {
                              e.stopPropagation()
                              navigate(`/projects/${project.id}/settings?tab=project`)
                            }}>
                              <Settings className="mr-2 h-4 w-4" />
                              Settings
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => openDeleteDialog(project, e as any)}
                              className="text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                </div>
              )
              })}
            </div>
          </div>
        )}

        {/* Empty state - only show when no projects AND not searching */}
        {filteredProjects.length === 0 && !searchQuery && viewMode === "list" && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <FolderOpen className="h-8 w-8 text-muted-foreground/50" />
            </div>
            <h3 className="text-base font-medium mb-1">No projects yet</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first project to get started
            </p>
            <Button size="sm" onClick={() => setShowCreateModal(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create project
            </Button>
          </div>
        )}

        {/* No results state */}
        {filteredProjects.length === 0 && searchQuery && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Search className="h-8 w-8 text-muted-foreground/50" />
            </div>
            <h3 className="text-base font-medium mb-1">No results found</h3>
            <p className="text-sm text-muted-foreground">
              No projects match "{searchQuery}"
            </p>
          </div>
        )}
      </div>

      {/* Rename Dialog */}
      <AlertDialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename project</AlertDialogTitle>
            <AlertDialogDescription>
              Enter a new name for this project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Project name"
            className="mt-2"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRenaming}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRename}
              disabled={isRenaming || !newName.trim()}
            >
              {isRenaming ? "Renaming..." : "Rename"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{projectToDelete?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Folder Dialog */}
      <Dialog open={createFolderDialogOpen} onOpenChange={setCreateFolderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create new folder</DialogTitle>
            <DialogDescription>
              {currentFolder ? `Create a subfolder in "${currentFolder.name}"` : "Create a new folder to organize your projects"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="folder-name">Folder name</Label>
              <Input
                id="folder-name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="Enter folder name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateFolderDialogOpen(false)} disabled={isCreatingFolder}>
              Cancel
            </Button>
            <Button onClick={handleCreateFolder} disabled={isCreatingFolder || !newFolderName.trim()}>
              {isCreatingFolder ? "Creating..." : "Create folder"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Folder Dialog */}
      <AlertDialog open={renameFolderDialogOpen} onOpenChange={setRenameFolderDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename folder</AlertDialogTitle>
            <AlertDialogDescription>
              Enter a new name for this folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={renameFolderName}
            onChange={(e) => setRenameFolderName(e.target.value)}
            placeholder="Folder name"
            className="mt-2"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRenamingFolder}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRenameFolder}
              disabled={isRenamingFolder || !renameFolderName.trim()}
            >
              {isRenamingFolder ? "Renaming..." : "Rename"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Folder Dialog */}
      <AlertDialog open={deleteFolderDialogOpen} onOpenChange={setDeleteFolderDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{folderToDelete?.name}"? Projects inside will be moved to the parent folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingFolder}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteFolder}
              disabled={isDeletingFolder}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingFolder ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Move Project to Folder Dialog */}
      <Dialog open={moveProjectDialogOpen} onOpenChange={setMoveProjectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isSelectMode && selectedProjectIds.size > 0
                ? `Move ${selectedProjectIds.size} project${selectedProjectIds.size > 1 ? 's' : ''} to folder`
                : "Move to folder"}
            </DialogTitle>
            <DialogDescription>
              {isSelectMode && selectedProjectIds.size > 0
                ? `Select a folder to move ${selectedProjectIds.size} selected project${selectedProjectIds.size > 1 ? 's' : ''} to.`
                : `Select a folder to move "${projectToMove?.name}" to.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Select folder</Label>
              <div className="border rounded-md max-h-[200px] overflow-auto">
                <button
                  onClick={() => setTargetFolderId(null)}
                  className={cn(
                    "w-full px-3 py-2 text-left text-sm hover:bg-accent flex items-center gap-2",
                    targetFolderId === null && "bg-accent"
                  )}
                >
                  <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  Root (no folder)
                </button>
                {rootFolders.map((folder) => (
                  <button
                    key={folder.id}
                    onClick={() => setTargetFolderId(folder.id)}
                    className={cn(
                      "w-full px-3 py-2 text-left text-sm hover:bg-accent flex items-center gap-2",
                      targetFolderId === folder.id && "bg-accent"
                    )}
                  >
                    <FolderOpen className="h-4 w-4 text-muted-foreground" />
                    {folder.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveProjectDialogOpen(false)} disabled={isMovingProject}>
              Cancel
            </Button>
            <Button 
              onClick={isSelectMode && selectedProjectIds.size > 0 ? handleBulkMove : handleMoveProjectToFolder} 
              disabled={isMovingProject}
            >
              {isMovingProject ? "Moving..." : "Move"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Drag overlay - floating preview card that follows the cursor */}
      <DragOverlay dropAnimation={null}>
        {activeProject ? <DragOverlayCard project={activeProject} /> : null}
      </DragOverlay>

      {/* Create Project Modal */}
      {currentWorkspace?.id && (
        <CreateProjectModal
          open={showCreateModal}
          onOpenChange={setShowCreateModal}
          workspaceId={currentWorkspace.id}
          onSuccess={(projectId) => {
            navigate(`/projects/${projectId}`)
          }}
        />
      )}
    </div>
    </DndContext>
  )
})
