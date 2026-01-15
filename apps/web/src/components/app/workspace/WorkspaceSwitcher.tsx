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

import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Plus, Settings, Users, ChevronDown, Check, Zap } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { CreateWorkspaceModal } from "./CreateWorkspaceModal"
import { useSettingsModal } from "../shared"
import { cn } from "@/lib/utils"

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
}

/**
 * WorkspaceSwitcher - Enhanced workspace selection dropdown
 *
 * Uses shadcn DropdownMenu for richer dropdown content.
 * Shows workspace info, plan, credits, and quick actions.
 */
export function WorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  onWorkspaceChange,
  isLoading = false,
}: WorkspaceSwitcherProps) {
  const navigate = useNavigate()
  const { openSettings } = useSettingsModal()
  
  // State for Create Workspace modal
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false)
  const [isOpen, setIsOpen] = useState(false)

  // Mock data for demonstration (in real app, this comes from billing domain)
  // TODO: Connect to actual billing data from useWorkspaceData
  const planType = "Free"
  const memberCount = 1
  const creditsUsed = 0
  const creditsTotal = 5
  const creditsPercent = (creditsUsed / creditsTotal) * 100

  // Show skeleton during loading
  if (isLoading) {
    return <Skeleton className="h-10 w-full" />
  }

  // Get workspace initial for avatar
  const workspaceInitial = currentWorkspace?.name?.[0]?.toUpperCase() ?? "W"

  return (
    <>
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger asChild>
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
        </DropdownMenuTrigger>

        <DropdownMenuContent 
          className="w-72" 
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
                    openSettings("workspace")
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
                    navigate("/members")
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
                  <span className="font-medium">{creditsTotal - creditsUsed} left</span>
                </div>
                <Progress value={100 - creditsPercent} className="h-1.5" />
                <div className="text-xs text-muted-foreground">
                  Daily credits reset at midnight UTC
                </div>
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
                    navigate("/billing")
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
                {workspace.slug === currentWorkspace?.slug && (
                  <>
                    <Badge variant="secondary" className="text-[10px] h-5 mr-2">
                      {planType}
                    </Badge>
                    <Check className="h-4 w-4 text-primary" />
                  </>
                )}
              </DropdownMenuItem>
            ))}
          </div>

          <DropdownMenuSeparator />

          {/* Create workspace button */}
          <div className="p-1">
            <DropdownMenuItem
              onClick={() => {
                setIsOpen(false)
                setShowCreateModal(true)
              }}
              className="px-3 py-2 cursor-pointer"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create new workspace
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Create Workspace Modal */}
      <CreateWorkspaceModal
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
      />
    </>
  )
}
