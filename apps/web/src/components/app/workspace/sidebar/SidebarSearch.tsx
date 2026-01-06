/**
 * SidebarSearch Component
 * Task: task-2-2-005
 *
 * Search input for filtering features in the sidebar.
 * Uses shadcn Input component with search icon.
 * Shows clear button (X) when value is present.
 *
 * Props:
 * - value: Current search value
 * - onChange: Callback when value changes
 * - placeholder: Optional placeholder text
 *
 * Per design-2-2-clean-break:
 * - Built fresh in /components/app/workspace/sidebar/
 * - Zero imports from /components/Studio/
 */

import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * Props for SidebarSearch component
 */
export interface SidebarSearchProps {
  /** Current search value */
  value: string
  /** Callback when value changes */
  onChange: (value: string) => void
  /** Optional placeholder text */
  placeholder?: string
  /** Optional className for styling */
  className?: string
}

/**
 * SidebarSearch Component
 *
 * Renders a search input with:
 * - Search icon on the left
 * - Clear button (X) on the right when value is present
 * - shadcn Input component for consistent styling
 */
export function SidebarSearch({
  value,
  onChange,
  placeholder = "Search features...",
  className,
}: SidebarSearchProps) {
  return (
    <div className={cn("relative", className)} data-testid="sidebar-search">
      {/* Search icon */}
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />

      {/* Search input */}
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-9 pr-8"
        aria-label="Search features"
      />

      {/* Clear button - only shown when value is present */}
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-sm hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
