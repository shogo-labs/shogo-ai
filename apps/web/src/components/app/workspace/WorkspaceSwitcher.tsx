/**
 * WorkspaceSwitcher Component
 * Refactored from OrgSwitcher as part of Organization -> Workspace rename
 *
 * Enhanced dropdown for workspace selection with:
 * - Workspace avatar and name
 * - Plan badge and member count
 * - Credits progress bar
 * - Quick actions (Settings, Invite members)
 * - Upgrade CTA
 * - All workspaces list
 * - Create workspace button
 *
 * Per design decision design-2-2-clean-break:
 * - Fresh component in /components/app/workspace/
 * - Uses shadcn patterns only
 * - Zero imports from /components/Studio/
 * 
 * Inspired by Lovable.dev's workspace dropdown design.
 */

import { useState, useCallback, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { observer } from "mobx-react-lite"
import { Plus, Settings, Users, ChevronDown, Check, Zap, ArrowLeft } from "lucide-react"
import { useSDKDomain } from "@/contexts/DomainProvider"
import { useSession } from "@/contexts/SessionProvider"
import type { IDomainStore } from "@/generated/domain"
import { useDomainActions } from "@/generated/domain-actions"

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
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { PlanSelector } from "../billing/PlanSelector"

/**
 * Workspace entity shape (from studioCore domain)
 */
export interface Workspace {
  id: string
  name: string
  slug: string
}

/**
 * Props for WorkspaceSwitcher component
 */
export interface WorkspaceSwitcherProps {
  /** List of workspaces the user has access to */
  workspaces: Workspace[]
  /** Currently selected workspace (by URL slug) */
  currentWorkspace: Workspace | null
  /** Callback when user selects a different workspace */
  onWorkspaceChange: (slug: string) => void
  /** Loading state - disables selector while data fetches */
  isLoading?: boolean
  /** Collapsed mode - shows compact icon-only trigger */
  collapsed?: boolean
}

/**
 * WorkspaceSwitcher - Enhanced workspace selection dropdown
 *
 * Uses shadcn DropdownMenu for richer dropdown content.
 * Shows workspace info, plan, credits, and quick actions.
 *
 * Wrapped with observer() to react to billing domain changes.
 */
export const WorkspaceSwitcher = observer(function WorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  onWorkspaceChange,
  isLoading = false,
  collapsed = false,
}: WorkspaceSwitcherProps) {
  const navigate = useNavigate()
  // Use SDK store and domain actions
  const store = useSDKDomain() as IDomainStore
  const actions = useDomainActions()
  const { data: session } = useSession()
  const [isOpen, setIsOpen] = useState(false)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const [selectPlanOpen, setSelectPlanOpen] = useState(false)
  const [newWorkspaceName, setNewWorkspaceName] = useState("")

  // Callback to create workspace before checkout
  const handleCreateWorkspace = useCallback(async (name: string): Promise<string> => {
    const userId = session?.user?.id
    if (!userId) {
      throw new Error("You must be logged in to create a workspace")
    }
    const workspace = await actions.createWorkspace(name, undefined, userId)
    // Switch to the new workspace
    if (workspace) {
      onWorkspaceChange(workspace.slug)
      return workspace.id
    }
    throw new Error("Failed to create workspace")
  }, [actions, session?.user?.id, onWorkspaceChange])

  // Load credit ledger for current workspace on mount / workspace change
  // This ensures the credits display has fresh data from the server
  useEffect(() => {
    if (currentWorkspace?.id && store?.creditLedgerCollection) {
      store.creditLedgerCollection.loadAll({ workspaceId: currentWorkspace.id }).catch((err: any) => {
        console.error("[WorkspaceSwitcher] Failed to load credit ledger:", err)
      })
    }
  }, [currentWorkspace?.id, store])

  // Get subscription for current workspace from SDK store
  // Uses MST observer pattern - component re-renders when billing data changes
  const getActiveSubscription = useCallback((workspaceId: string) => {
    if (!store?.subscriptionCollection) return null
    try {
      const subscriptions = store.subscriptionCollection.all.filter((s: any) => s.workspaceId === workspaceId)
      // Find active or trialing subscription
      return subscriptions.find((s: any) => s.status === 'active' || s.status === 'trialing') || null
    } catch {
      return null
    }
  }, [store])

  const subscription = currentWorkspace ? getActiveSubscription(currentWorkspace.id) : null

  // Determine plan type from subscription
  const planType = subscription
    ? subscription.planId.charAt(0).toUpperCase() + subscription.planId.slice(1) // Capitalize: pro -> Pro
    : "Free"

  // Helper to get plan type for any workspace
  const getPlanTypeForWorkspace = useCallback((workspaceId: string) => {
    const sub = getActiveSubscription(workspaceId)
    if (sub) {
      return sub.planId.charAt(0).toUpperCase() + sub.planId.slice(1)
    }
    return "Free"
  }, [getActiveSubscription])

  // Get actual credit values from SDK store
  const creditLedger = currentWorkspace
    ? store?.creditLedgerCollection?.all.find((cl: any) => cl.workspaceId === currentWorkspace.id)
    : null
  // Compute effective balance with lazy daily reset
  const effectiveBalance = creditLedger ? (() => {
    const lastReset = creditLedger.lastDailyReset ? new Date(creditLedger.lastDailyReset).toDateString() : ''
    const needsReset = lastReset !== new Date().toDateString()
    const daily = needsReset ? 5 : (creditLedger.dailyCredits ?? 0)
    const monthly = creditLedger.monthlyCredits ?? 0
    const rollover = creditLedger.rolloverCredits ?? 0
    return { dailyCredits: daily, monthlyCredits: monthly, rolloverCredits: rollover, total: daily + monthly + rollover }
  })() : null

  // TODO: Get actual member count from domain
  const memberCount = 1
  const creditsRemaining = effectiveBalance?.total ?? 5
  // creditsTotal = initial monthly allocation + 5 daily (read from ledger, not subscription)
  // The ledger stores the actual allocated amount (e.g. 800 for "pro_800" tier)
  const creditsTotal = (creditLedger?.monthlyCredits ?? 50) + 5
  const creditsPercent = Math.max(0, Math.min(100, ((creditsTotal - creditsRemaining) / creditsTotal) * 100))

  // Show skeleton during loading
  if (isLoading) {
    return <Skeleton className={collapsed ? "h-10 w-10" : "h-10 w-full"} />
  }

  // Get workspace initial for avatar
  const workspaceInitial = currentWorkspace?.name?.[0]?.toUpperCase() ?? "W"

  return (
    <>
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger asChild>
          {collapsed ? (
            <Button
              variant="ghost"
              size="icon"
              className="w-full h-10"
              title={currentWorkspace?.name || "Select workspace"}
            >
              <div className="h-6 w-6 rounded bg-primary/10 flex items-center justify-center text-xs font-medium">
                {workspaceInitial}
              </div>
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 h-10 px-2"
            >
              {/* Workspace avatar */}
              <div className="h-6 w-6 rounded bg-primary/10 flex items-center justify-center text-xs font-medium shrink-0">
                {workspaceInitial}
              </div>
              {/* Workspace name */}
              <span className="flex-1 text-left truncate text-sm">
                {currentWorkspace?.name ?? "Select workspace"}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
            </Button>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent 
          className="w-[232px] max-w-[232px] overflow-x-hidden" 
          align="start"
          sideOffset={4}
        >
          {/* Current workspace header */}
          {currentWorkspace && (
            <div className="px-3 py-2.5">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center text-sm font-medium shrink-0">
                  {workspaceInitial}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{currentWorkspace.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {planType} Plan • {memberCount} member{memberCount !== 1 ? "s" : ""}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Quick actions */}
          {currentWorkspace && (
            <>
              <div className="px-2 py-1.5 flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 h-8 text-xs"
                  onClick={() => {
                    setIsOpen(false)
                    navigate("/settings?tab=workspace")
                  }}
                >
                  <Settings className="h-3.5 w-3.5 mr-1.5" />
                  Settings
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 h-8 text-xs"
                  onClick={() => {
                    setIsOpen(false)
                    navigate("/settings?tab=people")
                  }}
                >
                  <Users className="h-3.5 w-3.5 mr-1.5" />
                  Invite
                </Button>
              </div>
              <DropdownMenuSeparator />
            </>
          )}

          {/* Credits section */}
          {currentWorkspace && (
            <>
              <div className="px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Credits</span>
                  <span className="font-medium">{creditsRemaining.toFixed(1)} left</span>
                </div>
                <Progress value={100 - creditsPercent} className="h-1.5" />
                {effectiveBalance && (
                  <div className="text-xs text-muted-foreground">
                    Daily: {effectiveBalance.dailyCredits.toFixed(1)} • Monthly: {effectiveBalance.monthlyCredits.toFixed(1)}
                  </div>
                )}
                {!effectiveBalance && (
                  <div className="text-xs text-muted-foreground">
                    Daily credits reset at midnight UTC
                  </div>
                )}
              </div>
              <DropdownMenuSeparator />
            </>
          )}

          {/* Upgrade CTA */}
          {currentWorkspace && planType === "Free" && (
            <>
              <div className="px-2 py-1.5">
                <Button
                  variant="default"
                  size="sm"
                  className="w-full h-9 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
                  onClick={() => {
                    setIsOpen(false)
                    navigate("/settings?tab=billing")
                  }}
                >
                  <Zap className="h-4 w-4 mr-2" />
                  Upgrade to Pro
                </Button>
              </div>
              <DropdownMenuSeparator />
            </>
          )}

          {/* All workspaces list */}
          <div className="py-1">
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
              All workspaces
            </div>
            {workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                onClick={() => {
                  onWorkspaceChange(workspace.slug)
                  setIsOpen(false)
                }}
                className="px-3 py-2 cursor-pointer"
              >
                <div className="h-6 w-6 rounded bg-primary/10 flex items-center justify-center text-xs font-medium mr-2">
                  {workspace.name[0]?.toUpperCase() ?? "W"}
                </div>
                <span className="flex-1 truncate">{workspace.name}</span>
                <Badge variant="secondary" className="text-[10px] h-5 mr-2">
                  {getPlanTypeForWorkspace(workspace.id)}
                </Badge>
                {workspace.slug === currentWorkspace?.slug && (
                  <Check className="h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </div>

          <DropdownMenuSeparator />

          {/* Create workspace button - opens modal first */}
          <div className="p-1">
            <DropdownMenuItem
              onClick={() => {
                setIsOpen(false)
                setCreateWorkspaceOpen(true)
              }}
              className="px-3 py-2 cursor-pointer"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create new workspace
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Step 1: Create Workspace Modal - Name entry */}
      <Dialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Create new workspace</DialogTitle>
            <DialogDescription>
              Name your workspace. You'll select a plan next.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="workspace-name">Workspace name</Label>
            <Input
              id="workspace-name"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="My Workspace"
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newWorkspaceName.trim()) {
                  setCreateWorkspaceOpen(false)
                  setSelectPlanOpen(true)
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateWorkspaceOpen(false)
                setNewWorkspaceName("")
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (newWorkspaceName.trim()) {
                  setCreateWorkspaceOpen(false)
                  setSelectPlanOpen(true)
                }
              }}
              disabled={!newWorkspaceName.trim()}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Step 2: Select Plan Modal */}
      <Dialog open={selectPlanOpen} onOpenChange={(open) => {
        setSelectPlanOpen(open)
        if (!open) setNewWorkspaceName("")
      }}>
        <DialogContent className="sm:max-w-[800px]">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  setSelectPlanOpen(false)
                  setCreateWorkspaceOpen(true)
                }}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <DialogTitle>Select a plan</DialogTitle>
                <DialogDescription>
                  Choose a plan for "{newWorkspaceName}"
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <PlanSelector
            workspaceName={newWorkspaceName.trim()}
            onCreateWorkspace={handleCreateWorkspace}
            onCheckoutStart={() => setSelectPlanOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  )
})
