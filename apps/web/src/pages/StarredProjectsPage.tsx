/**
 * StarredProjectsPage - Shows all starred projects across workspaces
 *
 * Features:
 * - Lists all starred projects for the current user
 * - Search and filter functionality
 * - Grid/List view toggle
 * - Quick unstar action
 * - Empty state when no projects are starred
 */

import { useState, useMemo, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { useNavigate, Link } from "react-router-dom"
import { formatDistanceToNow } from "date-fns"
import {
  Search,
  Star,
  MoreHorizontal,
  LayoutGrid,
  List,
  ChevronDown,
  Pencil,
  Settings,
  Trash2,
  FolderOpen,
  StarOff,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWorkspaceData } from "@/components/app/workspace/hooks"
import { useSession } from "@/auth/client"
import { cn } from "@/lib/utils"

// Types
type SortBy = "starredAt" | "lastEdited" | "alphabetical"
type ViewMode = "grid" | "list"

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

export const StarredProjectsPage = observer(function StarredProjectsPage() {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const { starredProjects, workspaces, toggleStarProject } = useWorkspaceData()

  // State
  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState<SortBy>("starredAt")
  const [viewMode, setViewMode] = useState<ViewMode>("grid")

  // Get sort label
  const sortLabel = useMemo(() => {
    switch (sortBy) {
      case "starredAt": return "Recently starred"
      case "lastEdited": return "Last edited"
      case "alphabetical": return "Alphabetical"
    }
  }, [sortBy])

  // Filter and sort projects
  const filteredProjects = useMemo(() => {
    let result = [...starredProjects]

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter((p: any) =>
        p.name?.toLowerCase().includes(query) ||
        p.description?.toLowerCase().includes(query)
      )
    }

    // Sort
    result.sort((a: any, b: any) => {
      switch (sortBy) {
        case "starredAt":
          return (b._starredAt || 0) - (a._starredAt || 0)
        case "lastEdited":
          return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
        case "alphabetical":
          return (a.name || "").localeCompare(b.name || "")
        default:
          return 0
      }
    })

    return result
  }, [starredProjects, searchQuery, sortBy])

  // Handlers
  const handleProjectClick = useCallback((project: any) => {
    navigate(`/projects/${project.id}`)
  }, [navigate])

  const handleUnstar = useCallback(async (project: any, e: React.MouseEvent) => {
    e.stopPropagation()
    const workspaceId = project._workspaceId || project.workspace?.id
    if (workspaceId) {
      await toggleStarProject(project.id, workspaceId)
    }
  }, [toggleStarProject])

  // Get workspace name for a project
  const getWorkspaceName = useCallback((project: any) => {
    const workspaceId = project._workspaceId || project.workspace?.id
    const workspace = workspaces.find((ws: any) => ws.id === workspaceId)
    return workspace?.name || "Unknown workspace"
  }, [workspaces])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <nav className="px-6 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
          <span className="text-lg font-semibold">Starred Projects</span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Quick access to your favorite projects across all workspaces
        </p>
      </nav>

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-2 border-b">
        {/* Search */}
        <div className="relative min-w-[180px] max-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search starred..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>

        {/* Sort dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1">
              {sortLabel}
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => setSortBy("starredAt")}>
              Recently starred
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSortBy("lastEdited")}>
              Last edited
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSortBy("alphabetical")}>
              Alphabetical
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

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
        {filteredProjects.length === 0 ? (
          // Empty state
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Star className="h-8 w-8 text-muted-foreground/50" />
            </div>
            <h3 className="text-base font-medium mb-1">
              {searchQuery ? "No results found" : "No starred projects yet"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              {searchQuery
                ? `No starred projects match "${searchQuery}"`
                : "Star projects to access them quickly from any workspace. Click the star icon on any project to add it here."}
            </p>
          </div>
        ) : viewMode === "grid" ? (
          // Grid View
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredProjects.map((project: any) => (
              <div
                key={project.id}
                onClick={() => handleProjectClick(project)}
                className="group flex flex-col rounded-xl bg-card overflow-hidden hover:shadow-md transition-all cursor-pointer"
              >
                {/* Preview area */}
                <div className={cn(
                  "relative aspect-[16/10] bg-gradient-to-br",
                  getPlaceholderGradient(project.name || "")
                )}>
                  {/* Project icon */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <FolderOpen className="h-10 w-10 text-white/30" />
                  </div>

                  {/* Unstar button - always visible since it's starred */}
                  <button
                    onClick={(e) => handleUnstar(project, e)}
                    className="absolute top-2 right-2 p-1.5 rounded-md bg-yellow-500/90 text-white hover:bg-yellow-600 transition-colors"
                    title="Remove from starred"
                  >
                    <Star className="h-3.5 w-3.5 fill-current" />
                  </button>
                </div>

                {/* Info area */}
                <div className="flex items-start gap-2.5 p-3">
                  {/* Creator avatar */}
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-medium">
                    {session?.user?.name?.charAt(0) || "U"}
                  </div>

                  {/* Name and workspace */}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate leading-tight">{project.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {getWorkspaceName(project)}
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
                      <DropdownMenuItem onClick={(e) => handleUnstar(project, e as any)}>
                        <StarOff className="mr-2 h-4 w-4" />
                        Remove from starred
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => handleProjectClick(project)}>
                        <Settings className="mr-2 h-4 w-4" />
                        Open project
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
            <div className="grid grid-cols-[1fr_150px_140px] gap-4 px-3 py-2 text-xs font-medium text-muted-foreground">
              <div>Name</div>
              <div>Workspace</div>
              <div>Starred</div>
            </div>

            {/* Project rows */}
            <div className="space-y-0">
              {filteredProjects.map((project: any) => (
                <div
                  key={project.id}
                  onClick={() => handleProjectClick(project)}
                  className="group grid grid-cols-[1fr_150px_140px] gap-4 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors items-center cursor-pointer"
                >
                  {/* Name column with preview */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={cn(
                      "flex-shrink-0 w-12 h-8 rounded-md bg-gradient-to-br flex items-center justify-center overflow-hidden",
                      getPlaceholderGradient(project.name || "")
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

                  {/* Workspace column */}
                  <div className="text-sm text-muted-foreground truncate">
                    {getWorkspaceName(project)}
                  </div>

                  {/* Starred at column */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {project._starredAt ? getTimeAgo(project._starredAt) : "-"}
                    </span>

                    {/* Actions */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={(e) => handleUnstar(project, e)}
                        title="Remove from starred"
                      >
                        <Star className="h-4 w-4 fill-yellow-500 text-yellow-500" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={(e) => handleUnstar(project, e as any)}>
                            <StarOff className="mr-2 h-4 w-4" />
                            Remove from starred
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleProjectClick(project)}>
                            <Settings className="mr-2 h-4 w-4" />
                            Open project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
})
