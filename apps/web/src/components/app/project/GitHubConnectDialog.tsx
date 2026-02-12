/**
 * GitHubConnectDialog - Multi-step dialog for connecting a GitHub repo to a project
 *
 * Flow:
 * 1. Check if GitHub App is configured on the server
 * 2. List GitHub App installations (accounts/orgs)
 * 3. Select installation -> list accessible repos
 * 4. Select repo -> connect project
 * 5. Show success / already connected state
 */

import { useState, useEffect, useCallback } from "react"
import {
  Github,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Check,
  AlertCircle,
  Unlink,
  ChevronRight,
  Lock,
  Globe,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

// =============================================================================
// Types
// =============================================================================

interface GitHubInstallation {
  id: number
  account: {
    login: string
    type: "User" | "Organization"
    avatar_url: string
  }
}

interface GitHubRepo {
  id: number
  name: string
  full_name: string
  private: boolean
  description: string | null
  html_url: string
  default_branch: string
  owner: {
    login: string
    avatar_url: string
  }
}

interface GitHubConnection {
  id: string
  repoOwner: string
  repoName: string
  repoFullName: string
  defaultBranch: string
  isPrivate: boolean
  syncEnabled: boolean
  lastPushAt: string | null
  lastPullAt: string | null
  lastSyncError: string | null
}

type Step =
  | "loading"
  | "not-configured"
  | "no-installations"
  | "select-repo"
  | "connecting"
  | "connected"
  | "error"

// =============================================================================
// Props
// =============================================================================

export interface GitHubConnectDialogProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  onDisconnected?: () => void
}

// =============================================================================
// Component
// =============================================================================

export function GitHubConnectDialog({
  projectId,
  open,
  onOpenChange,
  onConnected,
  onDisconnected,
}: GitHubConnectDialogProps) {
  // State
  const [step, setStep] = useState<Step>("loading")
  const [error, setError] = useState<string | null>(null)
  const [installUrl, setInstallUrl] = useState<string | null>(null)
  const [installations, setInstallations] = useState<GitHubInstallation[]>([])
  const [selectedInstallation, setSelectedInstallation] = useState<GitHubInstallation | null>(null)
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [repoSearch, setRepoSearch] = useState("")
  const [isLoadingRepos, setIsLoadingRepos] = useState(false)
  const [connection, setConnection] = useState<GitHubConnection | null>(null)
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  // Filtered repos
  const filteredRepos = repos.filter((repo) => {
    if (!repoSearch) return true
    const query = repoSearch.toLowerCase()
    return (
      repo.name.toLowerCase().includes(query) ||
      repo.full_name.toLowerCase().includes(query) ||
      (repo.description?.toLowerCase().includes(query) ?? false)
    )
  })

  // Initialize on open
  useEffect(() => {
    if (open) {
      checkStatus()
    } else {
      // Reset state when closing
      setStep("loading")
      setError(null)
      setSelectedInstallation(null)
      setRepos([])
      setRepoSearch("")
    }
  }, [open, projectId])

  // Check GitHub status and existing connection
  const checkStatus = useCallback(async () => {
    setStep("loading")
    setError(null)

    try {
      // Check existing connection first
      const connRes = await fetch(`/api/projects/${projectId}/github`)
      const connData = await connRes.json()

      if (connData.ok && connData.connected && connData.connection) {
        setConnection(connData.connection)
        setStep("connected")
        return
      }

      // Check if GitHub App is configured
      const statusRes = await fetch("/api/github/status")
      const statusData = await statusRes.json()

      if (!statusData.ok || !statusData.configured) {
        setStep("not-configured")
        return
      }

      setInstallUrl(statusData.installUrl)

      // List installations
      const installRes = await fetch("/api/github/installations")
      const installData = await installRes.json()

      if (!installRes.ok || installData.error) {
        setStep("not-configured")
        return
      }

      const installs: GitHubInstallation[] = installData.installations || []

      if (installs.length === 0) {
        setStep("no-installations")
        return
      }

      setInstallations(installs)

      // Auto-select if only one installation
      if (installs.length === 1) {
        setSelectedInstallation(installs[0])
        await loadRepos(installs[0].id)
      }

      setStep("select-repo")
    } catch (err: any) {
      console.error("[GitHubConnect] Status check failed:", err)
      setError(err.message || "Failed to check GitHub status")
      setStep("error")
    }
  }, [projectId])

  // Load repos for an installation
  const loadRepos = useCallback(async (installationId: number) => {
    setIsLoadingRepos(true)
    setRepoSearch("")

    try {
      const res = await fetch(`/api/github/repos?installation_id=${installationId}`)
      const data = await res.json()

      if (data.ok && data.repositories) {
        setRepos(data.repositories)
      } else {
        setRepos([])
        setError(data.error?.message || "Failed to load repositories")
      }
    } catch (err: any) {
      console.error("[GitHubConnect] Load repos failed:", err)
      setRepos([])
      setError(err.message || "Failed to load repositories")
    } finally {
      setIsLoadingRepos(false)
    }
  }, [])

  // Select an installation
  const handleSelectInstallation = useCallback(
    async (installation: GitHubInstallation) => {
      setSelectedInstallation(installation)
      await loadRepos(installation.id)
    },
    [loadRepos]
  )

  // Connect a repo
  const handleConnect = useCallback(
    async (repo: GitHubRepo) => {
      if (!selectedInstallation) return

      setStep("connecting")
      setError(null)

      try {
        const res = await fetch(`/api/projects/${projectId}/github/connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            installation_id: selectedInstallation.id,
            repo_owner: repo.owner.login,
            repo_name: repo.name,
          }),
        })

        const data = await res.json()

        if (!res.ok || data.error) {
          throw new Error(data.error?.message || "Failed to connect repository")
        }

        setConnection(data.connection)
        setStep("connected")
        onConnected?.()
      } catch (err: any) {
        console.error("[GitHubConnect] Connect failed:", err)
        setError(err.message || "Failed to connect repository")
        setStep("select-repo")
      }
    },
    [projectId, selectedInstallation, onConnected]
  )

  // Disconnect
  const handleDisconnect = useCallback(async () => {
    setIsDisconnecting(true)

    try {
      const res = await fetch(`/api/projects/${projectId}/github`, {
        method: "DELETE",
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error?.message || "Failed to disconnect")
      }

      setConnection(null)
      setIsDisconnecting(false)
      onDisconnected?.()
      // Go back to repo selection
      checkStatus()
    } catch (err: any) {
      console.error("[GitHubConnect] Disconnect failed:", err)
      setError(err.message || "Failed to disconnect")
      setIsDisconnecting(false)
    }
  }, [projectId, onDisconnected, checkStatus])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Github className="h-5 w-5" />
            {step === "connected" ? "GitHub Connected" : "Connect GitHub Repository"}
          </DialogTitle>
          <DialogDescription>
            {step === "connected"
              ? "Your project is synced with a GitHub repository."
              : "Sync your project's version history with a GitHub repository."}
          </DialogDescription>
        </DialogHeader>

        {/* Error banner */}
        {error && step !== "error" && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Step: Loading */}
        {step === "loading" && (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Checking GitHub status...</p>
          </div>
        )}

        {/* Step: Not configured */}
        {step === "not-configured" && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground/50 mb-3" />
            <p className="text-sm font-medium mb-1">GitHub App Not Configured</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              The Shogo GitHub App needs to be set up by a server administrator before you can
              connect repositories. Contact your admin to configure the GitHub integration.
            </p>
          </div>
        )}

        {/* Step: No installations */}
        {step === "no-installations" && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Github className="h-8 w-8 text-muted-foreground/50 mb-3" />
            <p className="text-sm font-medium mb-1">Install Shogo on GitHub</p>
            <p className="text-xs text-muted-foreground max-w-sm mb-4">
              Install the Shogo GitHub App on your account or organization to grant access to your
              repositories.
            </p>
            <div className="flex items-center gap-2">
              {installUrl && (
                <Button
                  onClick={() => window.open(installUrl, "_blank")}
                  className="gap-2"
                >
                  <Github className="h-4 w-4" />
                  Install on GitHub
                  <ExternalLink className="h-3 w-3" />
                </Button>
              )}
              <Button variant="outline" onClick={checkStatus} className="gap-2">
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
            </div>
          </div>
        )}

        {/* Step: Select repo */}
        {step === "select-repo" && (
          <div className="space-y-3">
            {/* Installation selector (if multiple) */}
            {installations.length > 1 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Account / Organization</p>
                <div className="flex flex-wrap gap-2">
                  {installations.map((inst) => (
                    <button
                      key={inst.id}
                      onClick={() => handleSelectInstallation(inst)}
                      className={cn(
                        "flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm transition-colors",
                        selectedInstallation?.id === inst.id
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-border text-muted-foreground hover:border-foreground/30"
                      )}
                    >
                      <img
                        src={inst.account.avatar_url}
                        alt={inst.account.login}
                        className="h-5 w-5 rounded-full"
                      />
                      {inst.account.login}
                      {selectedInstallation?.id === inst.id && (
                        <Check className="h-3 w-3 text-primary" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Repo search */}
            {selectedInstallation && (
              <>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search repositories..."
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    className="pl-8 h-9 text-sm"
                  />
                </div>

                {/* Repo list */}
                {isLoadingRepos ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredRepos.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    {repoSearch
                      ? "No repositories match your search"
                      : "No repositories found for this installation"}
                  </div>
                ) : (
                  <ScrollArea className="h-64">
                    <div className="space-y-1">
                      {filteredRepos.map((repo) => (
                        <button
                          key={repo.id}
                          onClick={() => handleConnect(repo)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left
                                     hover:bg-muted/50 transition-colors group"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium truncate">{repo.name}</span>
                              {repo.private ? (
                                <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                              ) : (
                                <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
                              )}
                            </div>
                            {repo.description && (
                              <p className="text-xs text-muted-foreground truncate mt-0.5">
                                {repo.description}
                              </p>
                            )}
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-foreground transition-colors shrink-0" />
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </>
            )}

            {/* Install more prompt */}
            {installUrl && (
              <div className="pt-2 border-t border-border/50">
                <button
                  onClick={() => window.open(installUrl, "_blank")}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                >
                  <Github className="h-3 w-3" />
                  Install on another account
                  <ExternalLink className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step: Connecting */}
        {step === "connecting" && (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Connecting repository...</p>
          </div>
        )}

        {/* Step: Connected */}
        {step === "connected" && connection && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 rounded-lg border border-green-500/20 bg-green-500/5">
              <div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center">
                <Check className="h-5 w-5 text-green-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{connection.repoFullName}</span>
                  {connection.isPrivate ? (
                    <Badge variant="outline" className="text-[10px] h-5">Private</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] h-5">Public</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                  <span>Branch: {connection.defaultBranch}</span>
                  {connection.syncEnabled && (
                    <>
                      <span className="text-border">·</span>
                      <span className="text-green-500">Auto-sync enabled</span>
                    </>
                  )}
                </div>
                {connection.lastPushAt && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last synced: {new Date(connection.lastPushAt).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-xs"
                onClick={() =>
                  window.open(`https://github.com/${connection.repoFullName}`, "_blank")
                }
              >
                <ExternalLink className="h-3 w-3" />
                View on GitHub
              </Button>

              <Button
                variant="ghost"
                size="sm"
                className="gap-2 text-xs text-destructive hover:text-destructive"
                onClick={handleDisconnect}
                disabled={isDisconnecting}
              >
                {isDisconnecting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Unlink className="h-3 w-3" />
                )}
                Disconnect
              </Button>
            </div>
          </div>
        )}

        {/* Step: Error */}
        {step === "error" && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <AlertCircle className="h-8 w-8 text-destructive/50 mb-3" />
            <p className="text-sm font-medium mb-1">Something went wrong</p>
            <p className="text-xs text-muted-foreground max-w-sm mb-4">
              {error || "An unexpected error occurred while connecting to GitHub."}
            </p>
            <Button variant="outline" onClick={checkStatus} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
          </div>
        )}

        {/* Footer: Close button */}
        {(step === "not-configured" || step === "connected" || step === "error") && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
