/**
 * ProjectTopBar - Lovable.dev-style top navigation bar for project view
 *
 * Exact styling matches Lovable.dev:
 * - Left: Project name dropdown with subtitle + history toggle + chat toggle
 * - Center: Preview controls with grouped viewport icons
 * - Right: Share (avatar + text), GitHub icon, Upgrade link, Publish button
 */

import { useState, useCallback } from "react"
import { History, Zap, Github, PanelLeftClose, PanelLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useNavigate } from "react-router-dom"
import { ProjectNameDropdown } from "./ProjectNameDropdown"
import { PreviewControls, type ViewportSize } from "./PreviewControls"
import { ShareDropdown } from "./ShareDropdown"
import { PublishDropdown, type AccessLevel } from "./PublishDropdown"
import { cn } from "@/lib/utils"

export interface ProjectTopBarProps {
  projectName: string
  projectId: string
  projectIcon?: string
  projectSubtitle?: string
  isStarred?: boolean
  workspaceName?: string
  credits?: number
  maxCredits?: number
  currentUserName?: string
  userInitial?: string
  // Publish state props
  isPublished?: boolean
  publishedAt?: Date
  publishedSubdomain?: string
  accessLevel?: AccessLevel
  siteTitle?: string
  siteDescription?: string
  showChatSessions?: boolean
  isChatCollapsed?: boolean
  onChatSessionsToggle?: () => void
  onChatCollapseToggle?: () => void
  onRename?: (newName: string) => Promise<void>
  onToggleStar?: () => void
  onDuplicate?: () => void
  onShare?: () => void
  onSettings?: () => void
  // Publish callbacks
  onPublish?: (data: {
    subdomain: string
    accessLevel: AccessLevel
    siteTitle?: string
    siteDescription?: string
  }) => Promise<{ url: string; publishedAt: number }>
  onUnpublish?: () => Promise<void>
  onUpdatePublishSettings?: (data: {
    accessLevel?: AccessLevel
    siteTitle?: string
    siteDescription?: string
  }) => Promise<void>
  onViewportChange?: (viewport: ViewportSize) => void
  onRouteChange?: (route: string) => void
  onRefresh?: () => void
  className?: string
}

export function ProjectTopBar({
  projectName,
  projectId,
  projectIcon,
  projectSubtitle = "Previewing last saved version",
  isStarred = false,
  workspaceName = "My Workspace",
  credits,
  maxCredits,
  currentUserName = "You",
  userInitial,
  isPublished = false,
  publishedAt,
  publishedSubdomain,
  accessLevel = "anyone",
  siteTitle,
  siteDescription,
  showChatSessions = false,
  isChatCollapsed = false,
  onChatSessionsToggle,
  onChatCollapseToggle,
  onRename,
  onToggleStar,
  onDuplicate,
  onShare,
  onSettings,
  onPublish,
  onUnpublish,
  onUpdatePublishSettings,
  onViewportChange,
  onRouteChange,
  onRefresh,
  className,
}: ProjectTopBarProps) {
  const navigate = useNavigate()
  const [currentViewport, setCurrentViewport] = useState<ViewportSize>("desktop")
  const [currentRoute, setCurrentRoute] = useState("/")

  const handleViewportChange = useCallback(
    (viewport: ViewportSize) => {
      setCurrentViewport(viewport)
      onViewportChange?.(viewport)
    },
    [onViewportChange]
  )

  const handleRouteChange = useCallback(
    (route: string) => {
      setCurrentRoute(route)
      onRouteChange?.(route)
    },
    [onRouteChange]
  )

  const handleOpenGitHub = useCallback(() => {
    console.log("Open GitHub")
  }, [])

  // Get user initial for avatar
  const initial = userInitial || currentUserName?.charAt(0).toUpperCase() || "U"

  return (
    <nav
      className={cn(
        "h-12 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
        "flex items-center justify-between px-3",
        className
      )}
    >
      {/* Left Section: Project name dropdown + toggle buttons */}
      <div className="flex items-center gap-0.5">
        {/* Project Name Dropdown */}
        <ProjectNameDropdown
          projectName={projectName}
          projectId={projectId}
          projectIcon={projectIcon}
          projectSubtitle={projectSubtitle}
          isStarred={isStarred}
          workspaceName={workspaceName}
          credits={credits}
          maxCredits={maxCredits}
          onRename={onRename}
          onToggleStar={onToggleStar}
          onDuplicate={onDuplicate}
          onOpenSettings={() => navigate("/settings?tab=project")}
        />

        {/* Chat Sessions Toggle Button */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-7 w-7 text-muted-foreground hover:text-foreground",
            showChatSessions && "bg-accent text-foreground ring-1 ring-border"
          )}
          onClick={onChatSessionsToggle}
          title="View chat sessions"
        >
          <History className="h-3.5 w-3.5" />
        </Button>

        {/* Chat Collapse Toggle Button */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-7 w-7 text-muted-foreground hover:text-foreground",
            isChatCollapsed && "bg-accent text-foreground ring-1 ring-border"
          )}
          onClick={onChatCollapseToggle}
          title={isChatCollapsed ? "Show chat panel" : "Hide chat panel"}
        >
          {isChatCollapsed ? (
            <PanelLeft className="h-3.5 w-3.5" />
          ) : (
            <PanelLeftClose className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Center Section: Preview controls */}
      <div className="hidden md:flex items-center">
        <PreviewControls
          currentViewport={currentViewport}
          onViewportChange={handleViewportChange}
          currentRoute={currentRoute}
          onRouteChange={handleRouteChange}
          onRefresh={onRefresh}
        />
      </div>

      {/* Right Section: Share, GitHub, Upgrade, Publish */}
      <div className="flex items-center gap-1.5">
        {/* Share Button with Avatar */}
        <ShareDropdown
          projectId={projectId}
          currentUserName={currentUserName}
          userInitial={initial}
          workspaceName={workspaceName}
          onSharePreview={onShare}
          onPublish={onPublish}
        />

        {/* GitHub Button - minimal icon */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={handleOpenGitHub}
          title="View on GitHub"
        >
          <Github className="h-4 w-4" />
        </Button>

        {/* Upgrade Link - with border */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs font-medium"
          onClick={() => navigate(`/projects/${projectId}/settings?tab=billing`)}
        >
          <Zap className="h-3.5 w-3.5" />
          Upgrade
        </Button>

        {/* Publish Dropdown - primary style */}
        <PublishDropdown
          projectId={projectId}
          currentSubdomain={publishedSubdomain}
          defaultSubdomain={projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}
          isPublished={isPublished}
          publishedAt={publishedAt}
          accessLevel={accessLevel}
          siteTitle={siteTitle}
          siteDescription={siteDescription}
          onPublish={onPublish}
          onUnpublish={onUnpublish}
          onUpdateSettings={onUpdatePublishSettings}
          onViewPublished={(url) => window.open(url, '_blank')}
        />
      </div>
    </nav>
  )
}
