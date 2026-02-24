/**
 * ProjectTopBar - Lovable.dev-style top navigation bar for project view
 *
 * Exact styling matches Lovable.dev:
 * - Left: Project name dropdown with subtitle + history toggle + chat toggle
 * - Center: Preview controls with grouped viewport icons
 * - Right: Share (avatar + text), GitHub icon, Upgrade link, Publish button
 */

import { useState, useCallback, useEffect } from "react"
import { History, Zap, Github, PanelLeftClose, PanelLeft, Cloud, CloudOff, Loader2, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useNavigate } from "react-router-dom"
import { ProjectNameDropdown } from "./ProjectNameDropdown"
import { PreviewControls, type ViewportSize } from "./PreviewControls"
// import { ShareDropdown } from "./ShareDropdown"
import { PublishDropdown, type AccessLevel } from "./PublishDropdown"
import { GitHubConnectDialog } from "./GitHubConnectDialog"
import { SyncIndicator } from "./SyncIndicator"
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
  currentViewport?: ViewportSize
  onViewportChange?: (viewport: ViewportSize) => void
  currentRoute?: string
  onRouteChange?: (route: string) => void
  onRefresh?: () => void
  onOpenPreview?: () => void
  onOpenExternal?: () => void
  onOpenCode?: () => void
  isOpeningExternal?: boolean
  isAgentProject?: boolean
  previewMode?: string
  onPreviewModeChange?: (mode: string) => void
  /** Project ID for sync — only used in desktop mode */
  syncProjectId?: string
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
  currentViewport = "desktop",
  onViewportChange,
  currentRoute = "/",
  onRouteChange,
  onRefresh,
  onOpenPreview,
  onOpenExternal,
  onOpenCode,
  isOpeningExternal = false,
  isAgentProject = false,
  previewMode,
  onPreviewModeChange,
  syncProjectId,
  className,
}: ProjectTopBarProps) {
  const navigate = useNavigate()

  // GitHub connection state
  const [githubConnection, setGithubConnection] = useState<{
    repoFullName: string
  } | null>(null)
  const [isLoadingGitHub, setIsLoadingGitHub] = useState(false)
  const [showGitHubDialog, setShowGitHubDialog] = useState(false)

  // Fetch GitHub connection on mount
  const fetchGitHubConnection = useCallback(async () => {
    if (!projectId) return

    setIsLoadingGitHub(true)
    try {
      const response = await fetch(`/api/projects/${projectId}/github`)
      const data = await response.json()

      if (data.ok && data.connected && data.connection) {
        setGithubConnection({
          repoFullName: data.connection.repoFullName,
        })
      } else {
        setGithubConnection(null)
      }
    } catch {
      setGithubConnection(null)
    } finally {
      setIsLoadingGitHub(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchGitHubConnection()
  }, [fetchGitHubConnection])

  const handleOpenGitHub = useCallback(() => {
    if (githubConnection) {
      // Open GitHub repository in new tab
      const githubUrl = `https://github.com/${githubConnection.repoFullName}`
      window.open(githubUrl, "_blank")
    } else {
      // Open the GitHub connect dialog
      setShowGitHubDialog(true)
    }
  }, [githubConnection])

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

      {/* Center Section: Agent tabs or Preview controls */}
      {isAgentProject ? (
        <div className="hidden md:flex items-center gap-0.5">
          {[
            { id: 'dynamic-app', label: 'Canvas' },
            { id: 'workspace', label: 'Workspace' },
            { id: 'skills', label: 'Skills' },
            { id: 'mcp-servers', label: 'MCP Servers' },
            { id: 'heartbeat', label: 'Heartbeat' },
            { id: 'channels', label: 'Channels' },
            { id: 'analytics', label: 'Analytics' },
            { id: 'logs', label: 'Logs' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => onPreviewModeChange?.(tab.id)}
              className={cn(
                "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                previewMode === tab.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="hidden md:flex items-center">
          <PreviewControls
            currentViewport={currentViewport}
            onViewportChange={onViewportChange}
            currentRoute={currentRoute}
            onRouteChange={onRouteChange}
            onRefresh={onRefresh}
            onOpenPreview={onOpenPreview}
            onOpenExternal={onOpenExternal}
            onOpenCode={onOpenCode}
            isOpeningExternal={isOpeningExternal}
          />
        </div>
      )}

      {/* Right Section: Sync, Share, GitHub, Upgrade, Publish */}
      <div className="flex items-center gap-1.5">
        {/* Sync indicator — desktop mode only */}
        {syncProjectId && (
          <SyncIndicator projectId={syncProjectId} />
        )}

        {/* GitHub Button - minimal icon */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-8 w-8 text-muted-foreground hover:text-foreground",
            githubConnection && "text-foreground"
          )}
          onClick={handleOpenGitHub}
          disabled={isLoadingGitHub}
          title={
            githubConnection
              ? `View on GitHub: ${githubConnection.repoFullName}`
              : "Connect GitHub repository"
          }
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

      {/* GitHub Connect Dialog */}
      <GitHubConnectDialog
        projectId={projectId}
        open={showGitHubDialog}
        onOpenChange={setShowGitHubDialog}
        onConnected={() => {
          fetchGitHubConnection()
        }}
        onDisconnected={() => {
          setGithubConnection(null)
        }}
      />
    </nav>
  )
}
