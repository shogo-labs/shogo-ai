/**
 * AllProjectsPage - Projects listing page matching lovable.dev design
 * 
 * Features:
 * - Search bar for filtering projects
 * - Sorting options (Last edited, Date created, Alphabetical)
 * - View toggle (Grid/List)
 * - Project cards with star, timestamps, and action menus
 * - "Create new project" card
 */

import { useState, useMemo, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { useNavigate, Link } from "react-router-dom"
import { formatDistanceToNow } from "date-fns"
import {
  Search,
  Plus,
  Star,
  MoreHorizontal,
  LayoutGrid,
  List,
  ChevronDown,
  Check,
  Pencil,
  Settings,
  Trash2,
  FolderOpen,
  CheckSquare,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
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
import { useWorkspaceData, useWorkspaceNavigation } from "@/components/app/workspace/hooks"
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
  const { currentWorkspace, projects, refetchProjects } = useWorkspaceData()
  const { setProjectId } = useWorkspaceNavigation()

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

  // Starred projects (local state for now)
  const [starredIds, setStarredIds] = useState<Set<string>>(new Set())

  // Get sort label
  const sortLabel = useMemo(() => {
    switch (sortBy) {
      case "lastEdited": return "Last edited"
      case "dateCreated": return "Date created"
      case "alphabetical": return "Alphabetical"
    }
  }, [sortBy])

  // Filter and sort projects
  const filteredProjects = useMemo(() => {
    let result = [...projects] as Project[]

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
  }, [projects, searchQuery, sortBy, sortOrder, statusFilter])

  // Handlers
  const handleProjectClick = useCallback(async (project: Project) => {
    // Set project ID first, then navigate with preserved params
    const params = await setProjectId(project.id)
    navigate(`/?${params.toString()}`)
  }, [setProjectId, navigate])

  const handleCreateProject = useCallback(async (projectId: string) => {
    const params = await setProjectId(projectId)
    navigate(`/?${params.toString()}`)
  }, [setProjectId, navigate])

  const handleToggleStar = useCallback((projectId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setStarredIds(prev => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

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
              <DropdownMenuItem onClick={() => refetchProjects()}>
                Refresh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>

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
                      starredIds.has(project.id)
                        ? "bg-yellow-500/90 text-white opacity-100"
                        : "bg-black/30 text-white/90 opacity-0 group-hover:opacity-100 hover:bg-black/50"
                    )}
                    title={starredIds.has(project.id) ? "Remove from favorites" : "Add to favorites"}
                  >
                    <Star className={cn("h-3.5 w-3.5", starredIds.has(project.id) && "fill-current")} />
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
                          starredIds.has(project.id) && "fill-yellow-500 text-yellow-500"
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
    </div>
  )
})
