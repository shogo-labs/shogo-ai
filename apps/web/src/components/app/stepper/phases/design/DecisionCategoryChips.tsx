/**
 * DecisionCategoryChips Component
 * Task: task-w3-filter-controls
 *
 * Filterable category badges for design decisions.
 * Uses FilterControl with chip-select variant for multi-select filtering.
 *
 * Used in DesignDecisionsList to filter decisions by category.
 */

import { memo, useMemo } from "react"
import { cn } from "@/lib/utils"
import { Tags } from "lucide-react"
import {
  FilterControl,
  type FilterOption,
} from "@/components/rendering/displays/visualization/FilterControl"

/**
 * Decision category types
 */
export type DecisionCategory =
  | "architecture"
  | "api"
  | "data"
  | "ui"
  | "integration"
  | "testing"
  | "other"

/**
 * Category configuration with labels and colors
 */
const CATEGORY_CONFIG: Record<DecisionCategory, { label: string; color: string }> = {
  architecture: { label: "Architecture", color: "violet" },
  api: { label: "API", color: "cyan" },
  data: { label: "Data", color: "green" },
  ui: { label: "UI/UX", color: "amber" },
  integration: { label: "Integration", color: "purple" },
  testing: { label: "Testing", color: "red" },
  other: { label: "Other", color: "default" },
}

/**
 * All categories in display order
 */
const CATEGORY_ORDER: DecisionCategory[] = [
  "architecture",
  "api",
  "data",
  "ui",
  "integration",
  "testing",
  "other",
]

/**
 * Props for DecisionCategoryChips component
 */
export interface DecisionCategoryChipsProps {
  /** Currently selected categories */
  selectedCategories: DecisionCategory[]
  /** Callback when category selection changes */
  onSelectionChange: (categories: DecisionCategory[]) => void
  /** Optional counts per category for badges */
  categoryCounts?: Partial<Record<DecisionCategory, number>>
  /** Additional CSS classes */
  className?: string
  /** Show clear all button */
  showClearAll?: boolean
}

/**
 * Extract category from decision name or question
 * Heuristic-based categorization based on keywords
 */
export function inferCategory(decision: {
  name?: string
  question?: string
}): DecisionCategory {
  const text = `${decision.name || ""} ${decision.question || ""}`.toLowerCase()

  if (text.match(/architect|pattern|structure|design/i)) return "architecture"
  if (text.match(/api|endpoint|rest|graphql|interface/i)) return "api"
  if (text.match(/data|schema|model|entity|database|storage/i)) return "data"
  if (text.match(/ui|ux|component|layout|style|visual/i)) return "ui"
  if (text.match(/integrat|connect|wire|hook/i)) return "integration"
  if (text.match(/test|spec|verify|assert/i)) return "testing"

  return "other"
}

/**
 * DecisionCategoryChips Component
 *
 * Multi-select category chips for filtering design decisions.
 *
 * @example
 * ```tsx
 * const [selectedCategories, setSelectedCategories] = useState<DecisionCategory[]>([])
 *
 * <DecisionCategoryChips
 *   selectedCategories={selectedCategories}
 *   onSelectionChange={setSelectedCategories}
 *   categoryCounts={{ architecture: 3, api: 2, data: 5 }}
 * />
 * ```
 */
export const DecisionCategoryChips = memo(function DecisionCategoryChips({
  selectedCategories,
  onSelectionChange,
  categoryCounts,
  className,
  showClearAll = true,
}: DecisionCategoryChipsProps) {
  // Build filter options from category config
  const filterOptions: FilterOption[] = useMemo(() => {
    return CATEGORY_ORDER.map((category) => {
      const config = CATEGORY_CONFIG[category]
      return {
        id: category,
        label: config.label,
        color: config.color,
        count: categoryCounts?.[category],
      }
    })
  }, [categoryCounts])

  // Handle selection change with proper typing
  const handleChange = (value: string[]) => {
    onSelectionChange(value as DecisionCategory[])
  }

  return (
    <div
      data-testid="decision-category-chips"
      className={cn("flex items-center gap-3", className)}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Tags className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wide">
          Categories
        </span>
      </div>
      <FilterControl
        options={filterOptions}
        value={selectedCategories}
        onChange={handleChange}
        variant="chip-select"
        multiSelect
        showClearAll={showClearAll}
        label="Filter decisions by category"
        size="sm"
      />
    </div>
  )
})
