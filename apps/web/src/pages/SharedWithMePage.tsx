/**
 * SharedWithMePage - Shows projects from workspaces the user was invited to
 *
 * Features:
 * - Lists all projects from workspaces where user is a member (not owner)
 * - Grouped by workspace or flat list
 * - Search and filter functionality
 * - Grid/List view toggle
 * - Empty state when no shared projects
 */

import { useState, useMemo, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { useNavigate } from "react-router-dom"
import { formatDistanceToNow } from "date-fns"
import {
  Search,
  Star,
  MoreHorizontal,
  LayoutGrid,
  List,
  ChevronDown,
  Settings,
  FolderOpen,
  Users,
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
import { useSession } from "@/contexts/SessionProvider"
import { cn } from "@/lib/utils"

// Types
type SortBy = "lastEdited" | "dateCreated" | "alphabetical"
type ViewMode = "grid" | "list"

// Helper to get time ago text
function getTimeAgo(timestamp: number): string {
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true })
}

/** Build thumbnail URL with cache-busting timestamp */
function getThumbnailSrc(project: any): string {
  if (!project.thumbnailKey) return ''
  const t = project.thumbnailUpdatedAt || project.updatedAt || ''
  // Use backend proxy route: /thumbnails/{projectId}
  const baseUrl = `/thumbnails/${project.id}`
  return t ? `${baseUrl}?t=${t}` : baseUrl
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

export const SharedWithMePage = observer(function SharedWithMePage() {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const { sharedProjects, sharedWorkspaces, starredProjectIds, toggleStarProject } = useWorkspaceData()

  // State
  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState<SortBy>("lastEdited")
  const [viewMode, setViewMode] = useState<ViewMode>("grid")

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
    let result = [...sharedProjects]

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
        case "lastEdited":
          return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
        case "dateCreated":
          return b.createdAt - a.createdAt
        case "alphabetical":
          return (a.name || "").localeCompare(b.name || "")
        default:
          return 0
      }
    })

    return result
  }, [sharedProjects, searchQuery, sortBy])

  // Handlers
  const handleProjectClick = useCallback((project: any) => {
    navigate(`/projects/${project.id}`)
  }, [navigate])

  const handleToggleStar = useCallback(async (project: any, e: React.MouseEvent) => {
    e.stopPropagation()
    const workspaceId = project.workspaceId
    if (workspaceId) {
      await toggleStarProject(project.id, workspaceId)
    }
  }, [toggleStarProject])

  // Get workspace name for a project
  const getWorkspaceName = useCallback((project: any) => {
    const workspaceId = project.workspaceId
    const workspace = sharedWorkspaces.find((ws: any) => ws.id === workspaceId)
    return workspace?.name || "Unknown workspace"
  }, [sharedWorkspaces])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <nav className="px-6 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <span className="text-lg font-semibold">Shared with me</span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Projects from workspaces you've been invited to
        </p>
      </nav>

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-2 border-b">
        {/* Search */}
        <div className="relative min-w-[180px] max-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search shared..."
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
            <DropdownMenuItem onClick={() => setSortBy("lastEdited")}>
              Last edited
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSortBy("dateCreated")}>
              Date created
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
              <Users className="h-8 w-8 text-muted-foreground/50" />
            </div>
            <h3 className="text-base font-medium mb-1">
              {searchQuery ? "No results found" : "No shared projects yet"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              {searchQuery
                ? `No shared projects match "${searchQuery}"`
                : "Projects you are invited to will appear here. When someone adds you to their workspace, you'll see their projects here."}
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
                  "relative aspect-[16/10] overflow-hidden",
                  !project.thumbnailKey && "bg-gradient-to-br",
                  !project.thumbnailKey && getPlaceholderGradient(project.name || "")
                )}>
                  {/* Thumbnail or fallback icon */}
                  {project.thumbnailKey ? (
                    <img
                      src={getThumbnailSrc(project)}
                      alt={`${project.name} preview`}
                      className="w-full h-full object-cover object-top"
                      loading="lazy"
                      onError={(e) => {
                        const target = e.currentTarget
                        target.style.display = 'none'
                        const parent = target.parentElement
                        if (parent) {
                          parent.classList.add('bg-gradient-to-br', ...getPlaceholderGradient(project.name || '').split(' '))
                        }
                      }}
                    />
                  ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <FolderOpen className="h-10 w-10 text-white/30" />
                  </div>
                  )}

                  {/* Shared badge */}
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/30 text-white text-xs flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    Shared
                  </div>

                  {/* Star button */}
                  <button
                    onClick={(e) => handleToggleStar(project, e)}
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
                      <DropdownMenuItem onClick={(e) => handleToggleStar(project, e as any)}>
                        <Star className="mr-2 h-4 w-4" />
                        {starredProjectIds.has(project.id) ? "Remove from starred" : "Add to starred"}
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
              <div>Last edited</div>
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
                      "flex-shrink-0 w-12 h-8 rounded-md flex items-center justify-center overflow-hidden relative",
                      !project.thumbnailKey && "bg-gradient-to-br",
                      !project.thumbnailKey && getPlaceholderGradient(project.name || "")
                    )}>
                      {project.thumbnailKey ? (
                        <img src={getThumbnailSrc(project)} alt="" className="w-full h-full object-cover object-top" loading="lazy" />
                      ) : (
                      <FolderOpen className="h-4 w-4 text-white/50" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="font-medium text-sm truncate">{project.name}</p>
                        <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
                          Shared
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {project.description || "No description"}
                      </p>
                    </div>
                  </div>

                  {/* Workspace column */}
                  <div className="text-sm text-muted-foreground truncate">
                    {getWorkspaceName(project)}
                  </div>

                  {/* Last edited column */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {getTimeAgo(project.updatedAt || project.createdAt)}
                    </span>

                    {/* Actions */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={(e) => handleToggleStar(project, e)}
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
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={(e) => handleToggleStar(project, e as any)}>
                            <Star className="mr-2 h-4 w-4" />
                            {starredProjectIds.has(project.id) ? "Remove from starred" : "Add to starred"}
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
