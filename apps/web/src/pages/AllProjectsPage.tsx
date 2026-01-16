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
  Square,
  ArrowLeft,
  Copy,
  X,
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
import { Label } from "@/components/ui/label"
import { useDomains } from "@/contexts/DomainProvider"
import { useSession } from "@/auth/client"
import { CreateProjectModal } from "@/components/app/workspace/CreateProjectModal"
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

export const AllProjectsPage = observer(function AllProjectsPage() {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const { studioCore } = useDomains()
  const { currentWorkspace, projects, folders, currentFolder, folderBreadcrumbs, refetchProjects, refetchFolders, starredProjectIds, toggleStarProject: toggleStar } = useWorkspaceData()
  const { folderId, setFolderId, clearFolder } = useWorkspaceNavigation()

  // State
  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState<SortBy>("lastEdited")
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest")
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("any")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("any")
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

  const handleCreateProject = useCallback((projectId: string) => {
    // Navigate to the new project view
    navigate(`/projects/${projectId}`)
  }, [navigate])

  const handleToggleStar = useCallback(async (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!currentWorkspace?.id) return
    await toggleStar(projectId, currentWorkspace.id)
  }, [currentWorkspace?.id, toggleStar])

  const handleRename = useCallback(async () => {
    if (!projectToRename || !newName.trim() || !studioCore) return
    
    setIsRenaming(true)
    try {
      // Update the project name via the domain
      await studioCore.updateProject(projectToRename.id, { name: newName.trim() })
      refetchProjects()
      setRenameDialogOpen(false)
      setProjectToRename(null)
      setNewName("")
    } catch (error) {
      console.error("Failed to rename project:", error)
    } finally {
      setIsRenaming(false)
    }
  }, [projectToRename, newName, studioCore, refetchProjects])

  const handleDelete = useCallback(async () => {
    if (!projectToDelete || !studioCore) return
    
    setIsDeleting(true)
    try {
      await studioCore.deleteProject(projectToDelete.id)
      refetchProjects()
      setDeleteDialogOpen(false)
      setProjectToDelete(null)
    } catch (error) {
      console.error("Failed to delete project:", error)
    } finally {
      setIsDeleting(false)
    }
  }, [projectToDelete, studioCore, refetchProjects])

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
    if (!newFolderName.trim() || !studioCore || !currentWorkspace?.id || !session?.user?.id) return

    setIsCreatingFolder(true)
    try {
      await studioCore.createFolder(
        newFolderName.trim(),
        currentWorkspace.id,
        folderId || null,
        session.user.id
      )
      refetchFolders()
      setCreateFolderDialogOpen(false)
      setNewFolderName("")
    } catch (error) {
      console.error("Failed to create folder:", error)
    } finally {
      setIsCreatingFolder(false)
    }
  }, [newFolderName, studioCore, currentWorkspace?.id, session?.user?.id, folderId, refetchFolders])

  const handleRenameFolder = useCallback(async () => {
    if (!folderToRename || !renameFolderName.trim() || !studioCore) return

    setIsRenamingFolder(true)
    try {
      await studioCore.updateFolder(folderToRename.id, { name: renameFolderName.trim() })
      refetchFolders()
      setRenameFolderDialogOpen(false)
      setFolderToRename(null)
      setRenameFolderName("")
    } catch (error) {
      console.error("Failed to rename folder:", error)
    } finally {
      setIsRenamingFolder(false)
    }
  }, [folderToRename, renameFolderName, studioCore, refetchFolders])

  const handleDeleteFolder = useCallback(async () => {
    if (!folderToDelete || !studioCore) return

    setIsDeletingFolder(true)
    try {
      await studioCore.deleteFolder(folderToDelete.id)
      refetchFolders()
      refetchProjects() // Projects may have moved
      setDeleteFolderDialogOpen(false)
      setFolderToDelete(null)
    } catch (error) {
      console.error("Failed to delete folder:", error)
    } finally {
      setIsDeletingFolder(false)
    }
  }, [folderToDelete, studioCore, refetchFolders, refetchProjects])

  const handleMoveProjectToFolder = useCallback(async () => {
    if (!projectToMove || !studioCore) return

    setIsMovingProject(true)
    try {
      await studioCore.moveProjectToFolder(projectToMove.id, targetFolderId)
      refetchProjects()
      setMoveProjectDialogOpen(false)
      setProjectToMove(null)
      setTargetFolderId(null)
    } catch (error) {
      console.error("Failed to move project:", error)
    } finally {
      setIsMovingProject(false)
    }
  }, [projectToMove, targetFolderId, studioCore, refetchProjects])

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

  // Get root folders for move dialog
  const rootFolders = useMemo(() => {
    return (folders as Folder[]).filter(f => !f.parentId)
  }, [folders])

  return (
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
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBackToRoot}
            className="h-7 px-2 gap-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All Projects
          </Button>
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
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
          <CheckSquare className="h-4 w-4" />
        </Button>

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
            <Link
              to="/"
              onClick={(e) => {
                e.preventDefault()
                setShowCreateModal(true)
              }}
              className="group flex flex-col rounded-xl border-2 border-dashed border-muted-foreground/20 hover:border-primary/40 transition-colors overflow-hidden"
            >
              <div className="relative aspect-[16/10] flex flex-col items-center justify-center gap-2 bg-muted/30">
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted group-hover:bg-muted-foreground/10 transition-colors">
                  <Plus className="h-5 w-5 text-muted-foreground" />
                </div>
              </div>
              <div className="p-3 text-center">
                <span className="text-sm text-muted-foreground">Create new project</span>
              </div>
            </Link>

            {/* Folder cards */}
            {currentFolders.map((folder) => (
              <div
                key={folder.id}
                onClick={() => handleFolderClick(folder)}
                className="group flex flex-col rounded-xl bg-card overflow-hidden hover:shadow-md transition-all cursor-pointer"
              >
                {/* Folder preview area */}
                <div className="relative aspect-[16/10] bg-muted flex items-center justify-center">
                  <FolderOpen className="h-12 w-12 text-muted-foreground/40" />
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
            ))}

            {/* Project cards */}
            {filteredProjects.map((project) => (
              <div
                key={project.id}
                onClick={() => handleProjectClick(project)}
                className="group flex flex-col rounded-xl bg-card overflow-hidden hover:shadow-md transition-all cursor-pointer"
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

                  {/* Star button - shows on hover */}
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

                  {/* Actions menu */}
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
                        handleProjectClick(project)
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
              </div>
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

            {/* Folder rows */}
            <div className="space-y-0">
              {currentFolders.map((folder) => (
                <div
                  key={folder.id}
                  onClick={() => handleFolderClick(folder)}
                  className="group grid grid-cols-[1fr_120px_140px] gap-4 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors items-center cursor-pointer"
                >
                  {/* Name column with folder icon */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex-shrink-0 w-12 h-8 rounded-md bg-muted flex items-center justify-center">
                      <FolderOpen className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate">{folder.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {(projects as Project[]).filter(p => p.folderId === folder.id).length} projects
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
              ))}
            </div>

            {/* Project rows */}
            <div className="space-y-0">
              {filteredProjects.map((project) => (
                <Link
                  key={project.id}
                  to="#"
                  onClick={(e) => {
                    e.preventDefault()
                    handleProjectClick(project)
                  }}
                  className="group grid grid-cols-[1fr_120px_140px] gap-4 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors items-center"
                >
                  {/* Name column with preview */}
                  <div className="flex items-center gap-3 min-w-0">
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
                    <button
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-accent transition-colors"
                    >
                      <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-medium">
                        {session?.user?.name?.charAt(0) || "U"}
                      </div>
                      <span className="text-xs">{session?.user?.name || "User"}</span>
                    </button>

                    {/* Actions */}
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
                            handleProjectClick(project)
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
                  </div>
                </Link>
              ))}
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

      {/* Create Project Modal */}
      <CreateProjectModal
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
        workspaceId={currentWorkspace?.id || ""}
        onSuccess={handleCreateProject}
      />

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
            <DialogTitle>Move to folder</DialogTitle>
            <DialogDescription>
              Select a folder to move "{projectToMove?.name}" to.
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
            <Button onClick={handleMoveProjectToFolder} disabled={isMovingProject}>
              {isMovingProject ? "Moving..." : "Move"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
