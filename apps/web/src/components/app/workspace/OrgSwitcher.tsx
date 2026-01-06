/**
 * OrgSwitcher Component
 * Task: task-2-2-003
 *
 * Dropdown for organization selection using shadcn Select.
 * Displays current org name, lists all user organizations.
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
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

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
  // Handle selection change
  const handleValueChange = (value: string) => {
    onOrgChange(value)
  }

  // Show skeleton during loading
  if (isLoading) {
    return <Skeleton className="h-9 w-[180px]" />
  }

  return (
    <Select
      value={currentOrg?.slug ?? ""}
      onValueChange={handleValueChange}
      disabled={isLoading}
    >
      <SelectTrigger className="w-[180px]">
        <SelectValue placeholder="Select organization" />
      </SelectTrigger>
      <SelectContent>
        {orgs.map((org) => (
          <SelectItem key={org.id} value={org.slug}>
            {org.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
