/**
 * OrgSwitcher Component
 * Task: task-2-2-003, task-org-004
 *
 * Dropdown for organization selection using shadcn Select.
 * Displays current org name, lists all user organizations.
 * Includes "Create Organization" button at the bottom of the dropdown.
 *
 * Per design decision design-2-2-clean-break:
 * - Fresh component in /components/app/workspace/
 * - Uses shadcn patterns only
 * - Zero imports from /components/Studio/
 *
 * Per ip-2-2-007:
 * - Props: orgs, currentOrg, onOrgChange
 * - Shows org name
 * - Disabled state when loading
 *
 * Per task-org-004:
 * - Create Organization button at bottom of dropdown
 * - Visual separator from org list
 * - Opens CreateOrgModal for creating new organizations
 */

import { useState } from "react"
import { Plus } from "lucide-react"

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
import { CreateOrgModal } from "./CreateOrgModal"

/**
 * Organization entity shape (from studioCore domain)
 */
export interface Organization {
  id: string
  name: string
  slug: string
}

/**
 * Props for OrgSwitcher component
 */
export interface OrgSwitcherProps {
  /** List of organizations the user has access to */
  orgs: Organization[]
  /** Currently selected organization (by URL slug) */
  currentOrg: Organization | null
  /** Callback when user selects a different organization */
  onOrgChange: (slug: string) => void
  /** Loading state - disables selector while data fetches */
  isLoading?: boolean
}

/**
 * OrgSwitcher - Organization selection dropdown
 *
 * Uses shadcn Select component for accessible dropdown.
 * Shows current org name as trigger, lists all orgs in dropdown.
 * Calls onOrgChange(slug) when selection changes.
 * Includes "Create Organization" button at the bottom.
 *
 * @example
 * ```tsx
 * <OrgSwitcher
 *   orgs={[{ id: "1", name: "Acme", slug: "acme" }]}
 *   currentOrg={{ id: "1", name: "Acme", slug: "acme" }}
 *   onOrgChange={(slug) => setOrg(slug)}
 * />
 * ```
 */
export function OrgSwitcher({
  orgs,
  currentOrg,
  onOrgChange,
  isLoading = false,
}: OrgSwitcherProps) {
  // State for Create Organization modal
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false)

  // Handle selection change
  const handleValueChange = (value: string) => {
    onOrgChange(value)
  }

  // Handle Create Organization button click
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
        value={currentOrg?.slug ?? ""}
        onValueChange={handleValueChange}
        disabled={isLoading}
      >
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder="Select organization" />
        </SelectTrigger>
        <SelectContent>
          {/* Organization list */}
          {orgs.map((org) => (
            <SelectItem key={org.id} value={org.slug}>
              {org.name}
            </SelectItem>
          ))}

          {/* Visual separator */}
          <SelectSeparator />

          {/* Create Organization button */}
          <div className="p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
              onClick={handleCreateClick}
            >
              <Plus className="h-4 w-4" />
              Create Organization
            </Button>
          </div>
        </SelectContent>
      </Select>

      {/* Create Organization Modal */}
      <CreateOrgModal
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
      />
    </>
  )
}
