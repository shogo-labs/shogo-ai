/**
 * HistoryPanel - Project version history panel with checkpoint management
 *
 * Shows a list of project checkpoints (git commits) that can be:
 * - Selected to preview changes
 * - Reverted to restore previous state
 * - Named/bookmarked for easy access
 */

import { useState, useCallback, useEffect } from "react"
import {
  RotateCcw,
  MoreHorizontal,
  Plus,
  GitCommit,
  FileCode,
  Database,
  Loader2,
  ChevronRight,
  AlertCircle,
  Github,
  RefreshCw,
  ExternalLink,
  Check,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { useCheckpoints, type Checkpoint } from "@/hooks/useCheckpoints"
import { GitHubConnectDialog } from "./GitHubConnectDialog"

export interface HistoryEntry {
  id: string
  title: string
  timestamp: Date
  isBookmarked?: boolean
  isCurrent?: boolean
}

export interface HistoryPanelProps {
  projectId: string
  onCheckpointCreated?: () => void
  onRollbackComplete?: () => void
  className?: string
}

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return "Just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function formatCommitMessage(message: string | null | undefined, maxLength = 50): string {
  if (!message) return "Untitled checkpoint"
  if (message.length <= maxLength) return message
  return message.substring(0, maxLength - 3) + "..."
}

export function HistoryPanel({
  projectId,
  onCheckpointCreated,
  onRollbackComplete,
  className,
}: HistoryPanelProps) {
  const {
    checkpoints,
    gitStatus,
    isLoading,
    isMutating,
    error,
    createCheckpoint,
    rollback,
    refetch,
  } = useCheckpoints(projectId)

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  
  // Create checkpoint dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newCheckpointMessage, setNewCheckpointMessage] = useState("")
  const [newCheckpointName, setNewCheckpointName] = useState("")
  const [includeDatabase, setIncludeDatabase] = useState(false)
  
  // Rollback confirmation dialog state
  const [rollbackTarget, setRollbackTarget] = useState<Checkpoint | null>(null)
  const [rollbackIncludeDb, setRollbackIncludeDb] = useState(false)

  // GitHub connection state
  const [githubConnection, setGithubConnection] = useState<{
    repoFullName: string
    syncEnabled: boolean
    lastPushAt: string | null
    lastSyncError: string | null
  } | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncSuccess, setSyncSuccess] = useState(false)
  const [showGitHubDialog, setShowGitHubDialog] = useState(false)

  // Fetch GitHub connection status
  const fetchGitHubConnection = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await fetch(`/api/projects/${projectId}/github`)
      const data = await res.json()
      if (data.ok && data.connected && data.connection) {
        setGithubConnection({
          repoFullName: data.connection.repoFullName,
          syncEnabled: data.connection.syncEnabled,
          lastPushAt: data.connection.lastPushAt,
          lastSyncError: data.connection.lastSyncError,
        })
      } else {
        setGithubConnection(null)
      }
    } catch {
      setGithubConnection(null)
    }
  }, [projectId])

  useEffect(() => {
    fetchGitHubConnection()
  }, [fetchGitHubConnection])

  // Manual sync handler
  const handleSync = useCallback(async () => {
    if (!projectId) return
    setIsSyncing(true)
    setSyncSuccess(false)
    try {
      const res = await fetch(`/api/projects/${projectId}/github/sync`, {
        method: "POST",
      })
      const data = await res.json()
      if (data.ok) {
        setSyncSuccess(true)
        setTimeout(() => setSyncSuccess(false), 3000)
        // Refresh connection to update lastPushAt
        fetchGitHubConnection()
      }
    } catch (err) {
      console.error("[HistoryPanel] Sync failed:", err)
    } finally {
      setIsSyncing(false)
    }
  }, [projectId, fetchGitHubConnection])

  // Create checkpoint handler
  const handleCreateCheckpoint = useCallback(async () => {
    if (!newCheckpointMessage.trim()) return

    const checkpoint = await createCheckpoint({
      message: newCheckpointMessage.trim(),
      name: newCheckpointName.trim() || undefined,
      includeDatabase,
    })

    if (checkpoint) {
      setShowCreateDialog(false)
      setNewCheckpointMessage("")
      setNewCheckpointName("")
      setIncludeDatabase(false)
      onCheckpointCreated?.()
    }
  }, [newCheckpointMessage, newCheckpointName, includeDatabase, createCheckpoint, onCheckpointCreated])

  // Rollback handler
  const handleRollback = useCallback(async () => {
    if (!rollbackTarget) return

    const success = await rollback(rollbackTarget.id, rollbackIncludeDb)
    
    if (success) {
      setRollbackTarget(null)
      setRollbackIncludeDb(false)
      onRollbackComplete?.()
    }
  }, [rollbackTarget, rollbackIncludeDb, rollback, onRollbackComplete])

  // Determine if there are uncommitted changes
  const hasUncommittedChanges = gitStatus?.hasChanges ?? false

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header with create button */}
      <div className="px-3 py-3 border-b border-border/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitCommit className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Version History</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowCreateDialog(true)}
          disabled={isMutating || !hasUncommittedChanges}
          className="h-7 px-2 text-xs"
        >
          <Plus className="h-3 w-3 mr-1" />
          Checkpoint
        </Button>
      </div>

      {/* Status bar */}
      {gitStatus && (
        <div className="px-3 py-2 border-b border-border/30 bg-muted/30">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{gitStatus.branch || "main"}</span>
            {hasUncommittedChanges && (
              <>
                <span className="text-border">·</span>
                <span className="text-amber-500">
                  {(gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length)} uncommitted changes
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* GitHub sync status bar */}
      {githubConnection ? (
        <div className="px-3 py-2 border-b border-border/30 bg-muted/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
              <Github className="h-3 w-3 shrink-0" />
              <a
                href={`https://github.com/${githubConnection.repoFullName}`}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate hover:text-foreground transition-colors"
              >
                {githubConnection.repoFullName}
              </a>
              {githubConnection.syncEnabled && (
                <>
                  <span className="text-border shrink-0">·</span>
                  {githubConnection.lastPushAt ? (
                    <span className="text-green-500 shrink-0 whitespace-nowrap">
                      Synced {formatTimestamp(githubConnection.lastPushAt)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/70 shrink-0">Not synced yet</span>
                  )}
                </>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs gap-1 shrink-0"
              onClick={handleSync}
              disabled={isSyncing}
            >
              {isSyncing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : syncSuccess ? (
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {syncSuccess ? "Synced" : "Sync"}
            </Button>
          </div>
          {githubConnection.lastSyncError && (
            <p className="text-xs text-destructive mt-1 truncate">
              {githubConnection.lastSyncError}
            </p>
          )}
        </div>
      ) : (
        <div className="px-3 py-2 border-b border-border/30">
          <button
            onClick={() => setShowGitHubDialog(true)}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            <Github className="h-3 w-3" />
            <span>Connect GitHub to sync your checkpoints</span>
            <ExternalLink className="h-3 w-3 ml-auto" />
          </button>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="px-3 py-2 bg-destructive/10 text-destructive text-xs flex items-center gap-2">
          <AlertCircle className="h-3 w-3" />
          {error.message}
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Checkpoints list */}
      {!isLoading && (
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {checkpoints.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <GitCommit className="h-8 w-8 mx-auto mb-3 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground mb-1">
                No checkpoints yet
              </p>
              <p className="text-xs text-muted-foreground/70">
                {hasUncommittedChanges
                  ? "Create a checkpoint to save your current state"
                  : "Make some changes and create a checkpoint"}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {checkpoints.map((checkpoint, index) => {
                const isHovered = hoveredId === checkpoint.id
                const isExpanded = expandedId === checkpoint.id
                const isCurrent = index === 0 // Most recent is current

                return (
                  <div
                    key={checkpoint.id}
                    className={cn(
                      "group relative rounded-md transition-colors border border-transparent",
                      isHovered && "bg-muted/50 border-border/30"
                    )}
                    onMouseEnter={() => setHoveredId(checkpoint.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    <button
                      className="w-full text-left px-3 py-2.5 rounded-md"
                      onClick={() => setExpandedId(isExpanded ? null : checkpoint.id)}
                    >
                      <div className="flex items-start gap-2">
                        {/* Commit icon with timeline */}
                        <div className="flex flex-col items-center pt-0.5">
                          <div className={cn(
                            "w-2 h-2 rounded-full",
                            isCurrent ? "bg-green-500" : "bg-muted-foreground/30"
                          )} />
                          {index < checkpoints.length - 1 && (
                            <div className="w-px h-full bg-border/30 mt-1" />
                          )}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium truncate">
                              {checkpoint.name || formatCommitMessage(checkpoint.commitMessage)}
                            </span>
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              {formatTimestamp(checkpoint.createdAt)}
                            </span>
                          </div>
                          
                          {/* Stats row */}
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <FileCode className="h-3 w-3" />
                              {checkpoint.filesChanged} files
                            </span>
                            {checkpoint.additions > 0 && (
                              <span className="text-green-500">+{checkpoint.additions}</span>
                            )}
                            {checkpoint.deletions > 0 && (
                              <span className="text-red-500">-{checkpoint.deletions}</span>
                            )}
                            {checkpoint.includesDb && (
                              <span className="flex items-center gap-1 text-blue-400">
                                <Database className="h-3 w-3" />
                                DB
                              </span>
                            )}
                          </div>

                          {/* Expanded details */}
                          {isExpanded && (
                            <div className="mt-2 pt-2 border-t border-border/30">
                              <p className="text-xs text-muted-foreground mb-2">
                                {checkpoint.commitMessage}
                              </p>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
                                <span>{checkpoint.commitSha.substring(0, 7)}</span>
                                <span>•</span>
                                <span>{checkpoint.branch}</span>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Expand indicator */}
                        <ChevronRight className={cn(
                          "h-4 w-4 text-muted-foreground/50 transition-transform",
                          isExpanded && "rotate-90"
                        )} />
                      </div>
                    </button>

                    {/* Action buttons - show on hover */}
                    {isHovered && !isCurrent && (
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-background/80 backdrop-blur-sm rounded px-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-foreground"
                          onClick={(e) => {
                            e.stopPropagation()
                            setRollbackTarget(checkpoint)
                          }}
                          disabled={isMutating}
                          title="Revert to this version"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-muted-foreground hover:text-foreground"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => setRollbackTarget(checkpoint)}
                              disabled={isMutating}
                            >
                              <RotateCcw className="h-3.5 w-3.5 mr-2" />
                              Revert to this version
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => {
                                navigator.clipboard.writeText(checkpoint.commitSha)
                              }}
                            >
                              Copy commit SHA
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Create Checkpoint Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Checkpoint</DialogTitle>
            <DialogDescription>
              Save the current state of your project. You can revert to this checkpoint later.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="message">Commit Message *</Label>
              <Input
                id="message"
                placeholder="Describe your changes..."
                value={newCheckpointMessage}
                onChange={(e) => setNewCheckpointMessage(e.target.value)}
                autoFocus
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="name">Checkpoint Name (optional)</Label>
              <Input
                id="name"
                placeholder="e.g., Before auth changes"
                value={newCheckpointName}
                onChange={(e) => setNewCheckpointName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Give this checkpoint a memorable name for easy identification
              </p>
            </div>
            
            <div className="flex items-center space-x-2">
              <Checkbox
                id="includeDb"
                checked={includeDatabase}
                onCheckedChange={(checked) => setIncludeDatabase(checked === true)}
              />
              <Label htmlFor="includeDb" className="text-sm font-normal">
                Include database snapshot
              </Label>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleCreateCheckpoint}
              disabled={!newCheckpointMessage.trim() || isMutating}
            >
              {isMutating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Checkpoint"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rollback Confirmation Dialog */}
      <Dialog open={!!rollbackTarget} onOpenChange={() => setRollbackTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revert to Checkpoint</DialogTitle>
            <DialogDescription>
              This will restore your project to the state at "{rollbackTarget?.name || rollbackTarget?.commitMessage}".
              Your current changes will be saved as a new checkpoint before reverting.
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-4">
            {rollbackTarget?.includesDb && (
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="rollbackDb"
                  checked={rollbackIncludeDb}
                  onCheckedChange={(checked) => setRollbackIncludeDb(checked === true)}
                />
                <Label htmlFor="rollbackDb" className="text-sm font-normal">
                  Also restore database snapshot
                </Label>
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setRollbackTarget(null)}>
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={handleRollback}
              disabled={isMutating}
            >
              {isMutating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Reverting...
                </>
              ) : (
                "Revert"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </div>
  )
}
