/**
 * AppSidebar - Persistent navigation sidebar component
 *
 * Renders the main navigation sidebar with:
 * - Logo and sidebar collapse toggle at top
 * - Workspace switcher
 * - Navigation sections (Home, Search)
 * - Projects section with expandable Recent and All projects
 * - Resources section (Templates)
 * - User avatar and inbox at bottom
 *
 * Inspired by Lovable.dev's sidebar design for better navigation UX.
 */

import { useState, useCallback, useEffect, useMemo } from "react"
import { observer } from "mobx-react-lite"
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom"
import {
  Home,
  Search,
  Clock,
  LayoutGrid,
  Star,
  Users,
  FileCode2,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeft,
  ExternalLink,
  Plus,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Inbox,
  Gift,
  Check,
  X,
  Building2,
  Loader2,
  Shield,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useSessionContext } from "@/contexts/SessionProvider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { WorkspaceSwitcher } from "../workspace"
import { useWorkspaceNavigation, useWorkspaceData } from "../workspace"
import { useSession } from "@/contexts/SessionProvider"
import { useCommandPaletteContext } from "./AppShell"
import { useDomains, useSDKDomain } from "@/contexts/DomainProvider"
import type { IDomainStore } from "@/generated/domain"
import { useDomainActions } from "@/generated/domain-actions"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { LogOut, User, Sun, Moon, Monitor } from "lucide-react"

/**
 * Get user initials from name
 */
function getInitials(name: string | null | undefined): string {
  if (!name) return "?"
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)
}

// Theme state helpers
function getTheme(): "light" | "dark" | "system" {
  if (typeof window === "undefined") return "system"
  const stored = localStorage.getItem("theme")
  if (stored === "dark" || stored === "light") return stored
  return "system"
}

function setTheme(theme: "light" | "dark" | "system") {
  if (theme === "system") {
    localStorage.removeItem("theme")
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
    document.documentElement.classList.toggle("dark", prefersDark)
  } else {
    localStorage.setItem("theme", theme)
    document.documentElement.classList.toggle("dark", theme === "dark")
  }
}

interface NavItemProps {
  icon: React.ElementType
  label: string
  to?: string
  href?: string
  active?: boolean
  collapsed?: boolean
  onClick?: () => void
  external?: boolean
  shortcut?: string
}

function NavItem({ icon: Icon, label, to, href, active, collapsed, onClick, external, shortcut }: NavItemProps) {
  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && shortcut && (
        <kbd className="ml-auto h-5 px-1.5 inline-flex items-center rounded border border-border bg-muted font-mono text-[10px] text-muted-foreground">
          {shortcut}
        </kbd>
      )}
      {!collapsed && external && <ExternalLink className="h-3 w-3 ml-auto opacity-50" />}
    </>
  )

  const className = cn(
    "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors w-full",
    active
      ? "bg-accent text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
    collapsed && "justify-center px-2"
  )

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        title={collapsed ? label : undefined}
      >
        {content}
      </a>
    )
  }

  if (to) {
    // Use NavLink with end prop for exact matching, but control active state via prop
    return (
      <NavLink
        to={to}
        end={true}
        className={({ isActive }) =>
          cn(
            "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors w-full",
            // Use our controlled active prop, not NavLink's isActive
            active
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
            collapsed && "justify-center px-2",
            // Remove focus styles that might look like active state
            "focus-visible:outline-none focus-visible:ring-0"
          )
        }
        title={collapsed ? label : undefined}
      >
        {content}
      </NavLink>
    )
  }

  return (
    <button onClick={onClick} className={className} title={collapsed ? label : undefined}>
      {content}
    </button>
  )
}

interface NavSectionProps {
  title: string
  children: React.ReactNode
  collapsed?: boolean
  defaultExpanded?: boolean
}

function NavSection({ title, children, collapsed, defaultExpanded = true }: NavSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  if (collapsed) {
    return <div className="py-2">{children}</div>
  }

  return (
    <div className="py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider w-full hover:text-muted-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {title}
      </button>
      {expanded && <div className="mt-1">{children}</div>}
    </div>
  )
}

interface ExpandableNavItemProps {
  icon: React.ElementType
  label: string
  to?: string
  active?: boolean
  collapsed?: boolean
  defaultExpanded?: boolean
  children?: React.ReactNode
}

function ExpandableNavItem({
  icon: Icon,
  label,
  to,
  active,
  collapsed,
  defaultExpanded = false,
  children,
}: ExpandableNavItemProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setExpanded(!expanded)
  }

  const className = cn(
    "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors w-full",
    active
      ? "bg-accent text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
    collapsed && "justify-center px-2"
  )

  const content = (
    <>
      <button
        onClick={handleToggle}
        className="flex items-center shrink-0"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 mr-1" />
        ) : (
          <ChevronRight className="h-3 w-3 mr-1" />
        )}
        <Icon className="h-4 w-4" />
      </button>
      {!collapsed && <span className="truncate">{label}</span>}
    </>
  )

  if (collapsed) {
    return (
      <div>
        {to ? (
          <NavLink
            to={to}
            end={true}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors w-full justify-center px-2",
                // Use our controlled active prop, not NavLink's isActive
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                // Remove focus styles that might look like active state
                "focus-visible:outline-none focus-visible:ring-0"
              )
            }
            title={label}
          >
            <Icon className="h-4 w-4" />
          </NavLink>
        ) : (
          <button 
            onClick={handleToggle} 
            className={cn(
              className,
              "focus-visible:outline-none focus-visible:ring-0"
            )} 
            title={label}
          >
            <Icon className="h-4 w-4" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div>
      {to ? (
        <NavLink
          to={to}
          end={true}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors w-full",
              // Use our controlled active prop, not NavLink's isActive
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
              collapsed && "justify-center px-2",
              // Remove focus styles that might look like active state
              "focus-visible:outline-none focus-visible:ring-0"
            )
          }
        >
          {content}
        </NavLink>
      ) : (
        <button onClick={handleToggle} className={className}>
          {content}
        </button>
      )}
      {expanded && children && (
        <div className="ml-7 pl-2 mt-1 space-y-0.5 border-l border-border/50">{children}</div>
      )}
    </div>
  )
}

interface ProjectItemProps {
  name: string
  projectId: string
  collapsed?: boolean
  workspaceSlug?: string
}

function ProjectItem({ name, projectId, collapsed }: Omit<ProjectItemProps, 'workspaceSlug'>) {
  if (collapsed) return null

  // Navigate to the full-screen project view
  return (
    <Link
      to={`/projects/${projectId}`}
      className="flex items-center gap-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-md w-full truncate"
      title={name}
    >
      <span className="truncate">{name}</span>
    </Link>
  )
}

interface FolderItemProps {
  folder: { id: string; name: string; parentId?: string }
  projects: any[]
  collapsed?: boolean
  onNavigate: (folderId: string) => void
  onRename: (folder: { id: string; name: string }) => void
  onDelete: (folder: { id: string; name: string }) => void
}

function FolderItem({ folder, projects, collapsed, onNavigate, onRename, onDelete }: FolderItemProps) {
  const [expanded, setExpanded] = useState(false)

  // Get projects in this folder
  const folderProjects = projects.filter((p: any) => p.folderId === folder.id)

  if (collapsed) return null

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    setExpanded(!expanded)
  }

  return (
    <div>
      <div className="group flex items-center gap-1 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-md w-full">
        <button
          onClick={handleToggle}
          className="flex items-center justify-center h-4 w-4 shrink-0"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        <button
          onClick={() => onNavigate(folder.id)}
          className="flex items-center gap-1.5 flex-1 truncate"
          title={folder.name}
        >
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{folder.name}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="h-5 w-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-accent"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={() => onRename(folder)}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(folder)}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && folderProjects.length > 0 && (
        <div className="ml-4 pl-2 mt-0.5 space-y-0.5 border-l border-border/50">
          {folderProjects.map((project: any) => (
            <ProjectItem
              key={project.id}
              name={project.name}
              projectId={project.id}
              collapsed={collapsed}
            />
          ))}
        </div>
      )}
      {expanded && folderProjects.length === 0 && (
        <div className="ml-4 pl-2 py-1 text-xs text-muted-foreground/60 italic border-l border-border/50">
          No projects
        </div>
      )}
    </div>
  )
}

/**
 * Invitation data from MCP domain for inbox display
 */
interface PendingInvitation {
  id: string
  email: string
  role: "owner" | "admin" | "member" | "viewer"
  expiresAt: number
  isExpired: boolean
  workspace?: { id: string; name: string }
  project?: { id: string; name: string }
}

/**
 * InboxPopover - Shows pending invitations in a popover
 */
interface InboxPopoverProps {
  collapsed?: boolean
  onInvitationAccepted?: () => void
}

const InboxPopover = observer(function InboxPopover({ collapsed, onInvitationAccepted }: InboxPopoverProps) {
  // Use SDK store and domain actions
  const store = useSDKDomain() as IDomainStore
  const actions = useDomainActions()
  const { data: session } = useSession()
  const userEmail = session?.user?.email
  const userId = session?.user?.id

  const [invitations, setInvitations] = useState<PendingInvitation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [isOpen, setIsOpen] = useState(false)

  // Load invitations when popover opens
  const loadInvitations = useCallback(async () => {
    if (!store?.invitationCollection || !userEmail) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    try {
      // Load invitations from backend using SDK
      await store.invitationCollection.loadAll({ email: userEmail })
      await store.workspaceCollection.loadAll({})

      // Get invitations for current user's email from SDK collection
      const userInvitations = store.invitationCollection.all.filter((i: any) => i.email === userEmail)
      const pending = userInvitations.filter((i: any) => i.status === "pending")

      setInvitations(pending.map((i: any) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        isExpired: Date.now() > i.expiresAt,
        workspace: i.workspaceId ? store.workspaceCollection.get(i.workspaceId) : undefined,
        project: i.projectId ? store.projectCollection.get(i.projectId) : undefined,
      })))
    } catch (err) {
      console.error("[InboxPopover] Failed to load invitations:", err)
    } finally {
      setIsLoading(false)
    }
  }, [userEmail, store])

  // Load invitations on mount and when popover opens
  useEffect(() => {
    loadInvitations()
  }, [loadInvitations])

  // Reload when popover opens (to get fresh data)
  useEffect(() => {
    if (isOpen) {
      loadInvitations()
    }
  }, [isOpen, loadInvitations])

  // Handle accepting an invitation - using SDK domain actions
  const handleAccept = async (invitation: PendingInvitation) => {
    if (!userId) return

    setProcessingId(invitation.id)
    try {
      await actions.acceptInvitation(invitation.id, userId)
      // Remove from local state
      setInvitations((prev) => prev.filter((i) => i.id !== invitation.id))
      // Notify parent to refresh workspaces
      onInvitationAccepted?.()
    } catch (err) {
      console.error("[InboxPopover] Failed to accept invitation:", err)
    } finally {
      setProcessingId(null)
    }
  }

  // Handle declining an invitation - using SDK domain actions
  const handleDecline = async (invitation: PendingInvitation) => {
    if (!userId) return

    setProcessingId(invitation.id)
    try {
      await actions.declineInvitation(invitation.id)
      // Remove from local state
      setInvitations((prev) => prev.filter((i) => i.id !== invitation.id))
    } catch (err) {
      console.error("[InboxPopover] Failed to decline invitation:", err)
    } finally {
      setProcessingId(null)
    }
  }

  // Get resource name for display
  const getResourceName = (invitation: PendingInvitation): string => {
    if (invitation.workspace) return invitation.workspace.name
    if (invitation.project) return invitation.project.name
    return "Unknown"
  }

  // Format time remaining
  const formatTimeRemaining = (expiresAt: number): string => {
    const diff = expiresAt - Date.now()
    if (diff <= 0) return "Expired"
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    if (days > 0) return `${days}d left`
    const hours = Math.floor(diff / (1000 * 60 * 60))
    if (hours > 0) return `${hours}h left`
    return "Expires soon"
  }

  const pendingCount = invitations.length

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8 relative", !collapsed && "ml-auto")}
          title="Inbox"
        >
          <Inbox className="h-4 w-4" />
          {pendingCount > 0 && (
            <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-primary text-[10px] font-medium text-primary-foreground flex items-center justify-center">
              {pendingCount > 9 ? "9+" : pendingCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 p-0">
        <div className="p-3 border-b border-border">
          <h3 className="font-semibold text-sm">Inbox</h3>
          <p className="text-xs text-muted-foreground">Invitations and notifications</p>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : invitations.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No pending invitations</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {invitations.map((invitation) => {
                const isExpired = invitation.isExpired || Date.now() > invitation.expiresAt
                const isProcessing = processingId === invitation.id

                return (
                  <div
                    key={invitation.id}
                    className={cn("p-3", isExpired && "opacity-60")}
                  >
                    <div className="flex items-start gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate">
                            {getResourceName(invitation)}
                          </span>
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            {invitation.role}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {isExpired ? "Expired" : formatTimeRemaining(invitation.expiresAt)}
                        </p>
                      </div>
                    </div>
                    {!isExpired && (
                      <div className="flex gap-2 mt-2 ml-6">
                        <Button
                          size="sm"
                          className="h-7 text-xs flex-1"
                          onClick={() => handleAccept(invitation)}
                          disabled={isProcessing}
                        >
                          {isProcessing ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <>
                              <Check className="h-3 w-3 mr-1" />
                              Accept
                            </>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs flex-1"
                          onClick={() => handleDecline(invitation)}
                          disabled={isProcessing}
                        >
                          {isProcessing ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <>
                              <X className="h-3 w-3 mr-1" />
                              Decline
                            </>
                          )}
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
})

/**
 * AppSidebar component
 *
 * Persistent navigation sidebar that provides global navigation across the app.
 * Collapsible to icons-only mode. State persisted to localStorage.
 */
interface AppSidebarProps {
  /** Force sidebar into collapsed state (for homepage transition animation) */
  forceCollapsed?: boolean
}

export const AppSidebar = observer(function AppSidebar({ forceCollapsed }: AppSidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { setWorkspaceSlug, setFolderId } = useWorkspaceNavigation()
  const { workspaces, currentWorkspace, projects, folders, isLoading, refetchFolders, refetchWorkspaces } = useWorkspaceData()
  const { openCommandPalette } = useCommandPaletteContext()
  // Use SDK store and domain actions
  const store = useSDKDomain() as IDomainStore
  const actions = useDomainActions()
  const { auth } = useDomains() // auth stays with legacy for now
  const sessionCtx = useSessionContext()

  // Sidebar collapse state - persisted to localStorage
  const [internalCollapsed, setInternalCollapsed] = useState(() => {
    const saved = localStorage.getItem("app-sidebar-collapsed")
    return saved === "true"
  })

  // Use forceCollapsed if provided, otherwise use internal state
  const collapsed = forceCollapsed ?? internalCollapsed
  const setCollapsed = setInternalCollapsed

  // Theme state
  const [currentTheme, setCurrentTheme] = useState<"light" | "dark" | "system">(getTheme)

  // Get current theme icon
  const ThemeIcon = currentTheme === "dark" ? Moon : currentTheme === "light" ? Sun : Monitor

  const handleThemeChange = useCallback((value: string) => {
    const theme = value as "light" | "dark" | "system"
    setTheme(theme)
    setCurrentTheme(theme)
  }, [])

  // Folder dialog state
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [folderToRename, setFolderToRename] = useState<{ id: string; name: string } | null>(null)
  const [folderToDelete, setFolderToDelete] = useState<{ id: string; name: string } | null>(null)
  const [newFolderName, setNewFolderName] = useState("")
  const [renameFolderName, setRenameFolderName] = useState("")

  // Get active subscription for current workspace from SDK store
  // Uses MST observer pattern - component re-renders when billing data changes
  const getActiveSubscription = useCallback((workspaceId: string | undefined) => {
    if (!workspaceId || !store?.subscriptionCollection) return null
    try {
      const subscriptions = store.subscriptionCollection.all.filter((s: any) => s.workspaceId === workspaceId)
      // Find active or trialing subscription
      return subscriptions.find((s: any) => s.status === 'active' || s.status === 'trialing') || null
    } catch {
      return null
    }
  }, [store])

  const subscription = getActiveSubscription(currentWorkspace?.id)

  // Determine if current workspace is on a paid plan
  const isPaidPlan = useMemo(() => {
    return subscription && subscription.planId !== "free"
  }, [subscription])

  // Persist collapse state
  useEffect(() => {
    localStorage.setItem("app-sidebar-collapsed", String(collapsed))
  }, [collapsed])

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  // Handle workspace change
  const handleWorkspaceChange = (slug: string) => {
    setWorkspaceSlug(slug)
  }

  // Check if current path matches (exact match only)
  const isActive = (path: string) => {
    // Use exact pathname matching to prevent multiple items being active
    return location.pathname === path
  }
  
  // Check if we're on the home page (exact "/" only, not "/projects" or other routes)
  // This ensures Home button is only active on the true home page
  const isHomePage = location.pathname === "/" && !location.search && !location.hash
  
  // Check if we're viewing projects (either /projects or / with project context)
  // IMPORTANT: This must explicitly exclude the home page to prevent both Home and Recent being active
  // Recent should ONLY be active when on /projects route, never on pure home page
  const isProjectsView = location.pathname.startsWith("/projects") && location.pathname !== "/"

  // Get recent projects (sorted by updatedAt, limit to 5)
  const recentProjects = [...projects]
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, 5)

  // Get root-level folders only for the sidebar
  const rootFolders = folders.filter((f: any) => !f.parentId)

  // Handle folder navigation
  const handleFolderNavigate = (folderId: string) => {
    navigate(`/projects?folder=${folderId}`)
  }

  // Handle create folder - using SDK domain actions
  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !currentWorkspace?.id) return
    try {
      await actions.createFolder(newFolderName.trim(), currentWorkspace.id, null)
      setCreateFolderOpen(false)
      setNewFolderName("")
      refetchFolders()
    } catch (error) {
      console.error("Failed to create folder:", error)
    }
  }

  // Handle rename folder - using SDK domain actions
  const handleRenameFolder = async () => {
    if (!renameFolderName.trim() || !folderToRename) return
    try {
      await actions.updateFolder(folderToRename.id, { name: renameFolderName.trim() })
      setFolderToRename(null)
      setRenameFolderName("")
      refetchFolders()
    } catch (error) {
      console.error("Failed to rename folder:", error)
    }
  }

  // Handle delete folder - using SDK domain actions
  const handleDeleteFolder = async () => {
    if (!folderToDelete) return
    try {
      await actions.deleteFolder(folderToDelete.id)
      setFolderToDelete(null)
      refetchFolders()
    } catch (error) {
      console.error("Failed to delete folder:", error)
    }
  }

  // Open rename dialog
  const openRenameDialog = (folder: { id: string; name: string }) => {
    setFolderToRename(folder)
    setRenameFolderName(folder.name)
  }

  return (
    <aside
      className={cn(
        "h-full border-r border-border bg-card flex flex-col transition-all",
        // Use faster transition for animation-driven collapse (150ms matches commit phase)
        forceCollapsed !== undefined ? "duration-150" : "duration-200",
        collapsed ? "w-16" : "w-64"
      )}
      data-testid="app-sidebar"
    >
      {/* Logo and collapse toggle */}
      <div className={cn(
        "h-14 border-b border-border flex items-center relative",
        collapsed ? "justify-center px-2" : "justify-between px-4"
      )}>
        {!collapsed && (
          <>
            <Link to="/" className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <span className="text-white font-bold text-sm">S</span>
              </div>
              <span className="font-semibold">Shogo</span>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleCollapse}
              className="h-8 w-8"
              title="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </>
        )}
        {collapsed && (
          <div className="group relative flex items-center justify-center w-full">
            <Link 
              to="/" 
              className="flex items-center justify-center transition-opacity duration-150 opacity-100 group-hover:opacity-0"
            >
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <span className="text-white font-bold text-sm">S</span>
              </div>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleCollapse}
              className={cn(
                "h-8 w-8 absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card border border-border rounded-full shadow-sm",
                "opacity-0 group-hover:opacity-100 transition-opacity duration-150"
              )}
              title="Expand sidebar"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Workspace switcher */}
      <div className={cn("p-2 border-b border-border", collapsed && "px-1")}>
        <WorkspaceSwitcher
          workspaces={workspaces}
          currentWorkspace={currentWorkspace ?? null}
          onWorkspaceChange={handleWorkspaceChange}
          isLoading={isLoading}
          collapsed={collapsed}
        />
      </div>

      {/* Main navigation - scrollable */}
      <nav className="flex-1 overflow-y-auto py-2">
        {/* Primary nav */}
        <div className="px-2">
          <NavItem
            icon={Home}
            label="Home"
            to="/"
            active={isHomePage}
            collapsed={collapsed}
          />
          <NavItem
            icon={Search}
            label="Search"
            collapsed={collapsed}
            onClick={openCommandPalette}
            shortcut="⌘K"
          />
        </div>

        {/* Projects section */}
        <NavSection title="Projects" collapsed={collapsed}>
          <div className="px-2">
            {/* Recent - expandable with recent projects */}
            {/* Only active when explicitly viewing recent projects, never on home or /projects */}
            {/* Recent should never be active - it's just a list, not a route */}
            <ExpandableNavItem
              icon={Clock}
              label="Recent"
              to="/"
              active={false}
              collapsed={collapsed}
              defaultExpanded={true}
            >
              {recentProjects.map((project: any) => (
                <ProjectItem
                  key={project.id}
                  name={project.name}
                  projectId={project.id}
                  collapsed={collapsed}
                />
              ))}
            </ExpandableNavItem>

            {/* All projects - expandable with folders */}
            {/* Only active when on /projects route, never on home */}
            <ExpandableNavItem
              icon={LayoutGrid}
              label="All projects"
              to="/projects"
              active={isActive("/projects") && !isHomePage}
              collapsed={collapsed}
              defaultExpanded={true}
            >
              {/* New folder button */}
              {!collapsed && (
                <button
                  onClick={() => setCreateFolderOpen(true)}
                  className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-md w-full"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                  <span>New folder</span>
                </button>
              )}
              {/* Folders list */}
              {rootFolders.map((folder: any) => (
                <FolderItem
                  key={folder.id}
                  folder={folder}
                  projects={projects}
                  collapsed={collapsed}
                  onNavigate={handleFolderNavigate}
                  onRename={openRenameDialog}
                  onDelete={setFolderToDelete}
                />
              ))}
            </ExpandableNavItem>

            <NavItem
              icon={Star}
              label="Starred"
              to="/starred"
              active={isActive("/starred")}
              collapsed={collapsed}
            />
            <NavItem
              icon={Users}
              label="Shared with me"
              to="/shared"
              active={isActive("/shared")}
              collapsed={collapsed}
            />
          </div>
        </NavSection>

        {/* Resources section */}
        <NavSection title="Resources" collapsed={collapsed}>
          <div className="px-2 space-y-0.5">
            <NavItem
              icon={FileCode2}
              label="Templates"
              to="/templates"
              active={isActive("/templates")}
              collapsed={collapsed}
            />
            <NavItem
              icon={ExternalLink}
              label="Docs"
              href="https://docs-staging.shogo.ai/"
              collapsed={collapsed}
            />
          </div>
        </NavSection>
      </nav>

      {/* Bottom section - promotional cards and user avatar */}
      <div className="mt-auto border-t border-border">
        {/* Share card - not functional yet, no backend for referral/credits */}
        {/* {!collapsed && (
          <div className="p-2">
            <button className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-card hover:bg-accent/50 transition-colors text-left">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Share Shogo</div>
                <div className="text-xs text-muted-foreground">Get 10 credits each</div>
              </div>
              <Gift className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        )} */}

        {/* Upgrade CTA (hidden for paid plans) */}
        {!collapsed && !isPaidPlan && (
          <div className="px-2 pb-2">
            <Link
              to="/billing"
              className="flex items-center gap-2 px-3 py-2 rounded-md bg-gradient-to-r from-blue-500/10 to-purple-500/10 hover:from-blue-500/20 hover:to-purple-500/20 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Upgrade to Pro</div>
                <div className="text-xs text-muted-foreground">Unlock more benefits</div>
              </div>
              <Plus className="h-4 w-4 text-primary" />
            </Link>
          </div>
        )}

        {/* User avatar and inbox - bottom left like Lovable */}
        <div className={cn(
          "flex items-center gap-2 p-2 border-t border-border",
          collapsed ? "justify-center" : "px-3"
        )}>
          {/* User dropdown menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center justify-center rounded-full focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:opacity-80 transition-opacity"
                aria-label="User menu"
                title={auth.currentUser?.name || "User menu"}
              >
                <Avatar className="h-8 w-8">
                  {auth.currentUser?.image && (
                    <AvatarImage src={auth.currentUser.image} alt={auth.currentUser?.name || "User"} />
                  )}
                  <AvatarFallback className="text-xs">{getInitials(auth.currentUser?.name)}</AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="start" side="top" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">{auth.currentUser?.name || "User"}</p>
                  <p className="text-xs leading-none text-muted-foreground">
                    {auth.currentUser?.email || ""}
                  </p>
                </div>
              </DropdownMenuLabel>

              <DropdownMenuSeparator />

              <DropdownMenuItem asChild className="cursor-pointer">
                <Link to="/profile">
                  <User className="mr-2 h-4 w-4" />
                  <span>Profile</span>
                </Link>
              </DropdownMenuItem>

              {/* Admin Portal link (super admins only) */}
              {sessionCtx?.isSuperAdmin && (
                <DropdownMenuItem asChild className="cursor-pointer">
                  <Link to="/admin">
                    <Shield className="mr-2 h-4 w-4" />
                    <span>Admin Portal</span>
                  </Link>
                </DropdownMenuItem>
              )}

              {/* Appearance submenu */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ThemeIcon className="mr-2 h-4 w-4" />
                  <span>Appearance</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={currentTheme} onValueChange={handleThemeChange}>
                    <DropdownMenuRadioItem value="light" className="gap-2">
                      <Sun className="h-4 w-4" />
                      Light
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark" className="gap-2">
                      <Moon className="h-4 w-4" />
                      Dark
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system" className="gap-2">
                      <Monitor className="h-4 w-4" />
                      System
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuItem onClick={() => auth.signOut()} className="cursor-pointer">
                <LogOut className="mr-2 h-4 w-4" />
                <span>Sign Out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Inbox with invitations */}
          {!collapsed && (
            <InboxPopover
              collapsed={collapsed}
              onInvitationAccepted={refetchWorkspaces}
            />
          )}
        </div>
      </div>

      {/* Create Folder Dialog */}
      <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Create new folder</DialogTitle>
            <DialogDescription>
              Create a new folder to organize your projects
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="folder-name">Folder name</Label>
            <Input
              id="folder-name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Enter folder name"
              className="mt-2"
              onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateFolderOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>
              Create folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Folder Dialog */}
      <AlertDialog open={!!folderToRename} onOpenChange={(open) => !open && setFolderToRename(null)}>
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
            onKeyDown={(e) => e.key === "Enter" && handleRenameFolder()}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRenameFolder} disabled={!renameFolderName.trim()}>
              Rename
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Folder Dialog */}
      <AlertDialog open={!!folderToDelete} onOpenChange={(open) => !open && setFolderToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{folderToDelete?.name}"? Projects inside will be moved to the parent folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteFolder} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
})
