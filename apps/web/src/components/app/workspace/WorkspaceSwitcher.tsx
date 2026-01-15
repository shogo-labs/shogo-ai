/**
 * WorkspaceSwitcher Component
 * Refactored from OrgSwitcher as part of Organization -> Workspace rename
 *
 * Dropdown for workspace selection using shadcn Select.
 * Displays current workspace name, lists all user workspaces.
 * Includes "Create Workspace" button at the bottom of the dropdown.
 *
 * Per design decision design-2-2-clean-break:
 * - Fresh component in /components/app/workspace/
 * - Uses shadcn patterns only
 * - Zero imports from /components/Studio/
 */

import { useState } from "react"
import { Link } from "react-router-dom"
import { Plus, Settings, Users, CreditCard } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { CreateWorkspaceModal } from "./CreateWorkspaceModal"

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
 * WorkspaceSwitcher - Workspace selection dropdown
 *
 * Uses shadcn Select component for accessible dropdown.
 * Shows current workspace name as trigger, lists all workspaces in dropdown.
 * Calls onWorkspaceChange(slug) when selection changes.
 * Includes "Create Workspace" button at the bottom.
 *
 * @example
 * ```tsx
 * <WorkspaceSwitcher
 *   workspaces={[{ id: "1", name: "Acme", slug: "acme" }]}
 *   currentWorkspace={{ id: "1", name: "Acme", slug: "acme" }}
 *   onWorkspaceChange={(slug) => setWorkspace(slug)}
 * />
 * ```
 */
export function WorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  onWorkspaceChange,
  isLoading = false,
}: WorkspaceSwitcherProps) {
  // State for Create Workspace modal
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false)

  // Handle selection change
  const handleValueChange = (value: string) => {
    onWorkspaceChange(value)
  }

  // Handle Create Workspace button click
  const handleCreateClick = (e: React.MouseEvent) => {
    // Prevent the select from closing/changing
    e.preventDefault()
    e.stopPropagation()
    setShowCreateModal(true)
  }

  // Show skeleton during loading
  if (isLoading) {
    return <Skeleton className="h-9 w-[180px]" />
  }

  return (
    <>
      <Select
        value={currentWorkspace?.slug ?? ""}
        onValueChange={handleValueChange}
        disabled={isLoading}
      >
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder="Select workspace" />
        </SelectTrigger>
        <SelectContent>
          {/* Workspace list */}
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.slug}>
              {workspace.name}
            </SelectItem>
          ))}

          {/* Workspace actions separator */}
          {currentWorkspace && (
            <>
              <SelectSeparator />
              <div className="p-1 space-y-0.5">
                <Link to="/members">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Users className="h-4 w-4" />
                    Members
                  </Button>
                </Link>
                <Link to="/billing">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <CreditCard className="h-4 w-4" />
                    Billing & Plans
                  </Button>
                </Link>
                <Link to="/profile">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Settings className="h-4 w-4" />
                    Settings
                  </Button>
                </Link>
              </div>
            </>
          )}

          {/* Visual separator */}
          <SelectSeparator />

          {/* Create Workspace button */}
          <div className="p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
              onClick={handleCreateClick}
            >
              <Plus className="h-4 w-4" />
              Create Workspace
            </Button>
          </div>
        </SelectContent>
      </Select>

      {/* Create Workspace Modal */}
      <CreateWorkspaceModal
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
      />
    </>
  )
}
