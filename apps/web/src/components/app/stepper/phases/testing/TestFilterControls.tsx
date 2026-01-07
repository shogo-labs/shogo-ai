/**
 * TestFilterControls Component
 * Task: task-w3-filter-controls
 *
 * Filter and sort controls for the TestingView:
 * - Type filter: dropdown to filter by test type (unit, integration, acceptance)
 * - Sort dropdown: order tests by various criteria
 *
 * Uses FilterControl component with dropdown variant.
 */

import { memo, useMemo } from "react"
import { cn } from "@/lib/utils"
import { Filter, ArrowUpDown } from "lucide-react"
import {
  FilterControl,
  type FilterOption,
} from "@/components/rendering/displays/visualization/FilterControl"

/**
 * Test type for filtering
 */
export type TestType = "all" | "unit" | "integration" | "acceptance"

/**
 * Sort order options
 */
export type SortOrder = "newest" | "oldest" | "alphabetical" | "type"

/**
 * Test type filter options
 */
const TEST_TYPE_OPTIONS: FilterOption[] = [
  { id: "all", label: "All Types" },
  { id: "unit", label: "Unit Tests" },
  { id: "integration", label: "Integration Tests" },
  { id: "acceptance", label: "Acceptance / E2E" },
]

/**
 * Sort order options
 */
const SORT_OPTIONS: FilterOption[] = [
  { id: "newest", label: "Newest First" },
  { id: "oldest", label: "Oldest First" },
  { id: "alphabetical", label: "Alphabetical" },
  { id: "type", label: "By Type" },
]

/**
 * Props for TestFilterControls component
 */
export interface TestFilterControlsProps {
  /** Currently selected test type filter */
  typeFilter: TestType
  /** Callback when type filter changes */
  onTypeChange: (type: TestType) => void
  /** Current sort order */
  sortOrder: SortOrder
  /** Callback when sort order changes */
  onSortChange: (order: SortOrder) => void
  /** Optional counts per type for badges */
  typeCounts?: Partial<Record<TestType, number>>
  /** Additional CSS classes */
  className?: string
}

/**
 * TestFilterControls Component
 *
 * Filter and sort controls for testing view.
 *
 * @example
 * ```tsx
 * const [typeFilter, setTypeFilter] = useState<TestType>("all")
 * const [sortOrder, setSortOrder] = useState<SortOrder>("newest")
 *
 * <TestFilterControls
 *   typeFilter={typeFilter}
 *   onTypeChange={setTypeFilter}
 *   sortOrder={sortOrder}
 *   onSortChange={setSortOrder}
 *   typeCounts={{ unit: 10, integration: 5, acceptance: 3 }}
 * />
 * ```
 */
export const TestFilterControls = memo(function TestFilterControls({
  typeFilter,
  onTypeChange,
  sortOrder,
  onSortChange,
  typeCounts,
  className,
}: TestFilterControlsProps) {
  // Build type options with counts
  const typeOptions: FilterOption[] = useMemo(() => {
    return TEST_TYPE_OPTIONS.map((option) => ({
      ...option,
      count: option.id === "all" ? undefined : typeCounts?.[option.id as TestType],
    }))
  }, [typeCounts])

  // Handle type filter change
  const handleTypeChange = (value: string[]) => {
    const selected = value[0] as TestType | undefined
    onTypeChange(selected || "all")
  }

  // Handle sort change
  const handleSortChange = (value: string[]) => {
    const selected = value[0] as SortOrder | undefined
    onSortChange(selected || "newest")
  }

  return (
    <div
      data-testid="test-filter-controls"
      className={cn("flex items-center gap-4 flex-wrap", className)}
    >
      {/* Type filter dropdown */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Filter className="h-4 w-4" />
          <span className="text-xs font-medium">Type</span>
        </div>
        <FilterControl
          options={typeOptions}
          value={typeFilter === "all" ? [] : [typeFilter]}
          onChange={handleTypeChange}
          variant="dropdown"
          placeholder="All Types"
          label="Filter by test type"
          size="sm"
        />
      </div>

      {/* Sort dropdown */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <ArrowUpDown className="h-4 w-4" />
          <span className="text-xs font-medium">Sort</span>
        </div>
        <FilterControl
          options={SORT_OPTIONS}
          value={[sortOrder]}
          onChange={handleSortChange}
          variant="dropdown"
          placeholder="Sort by"
          label="Sort test specifications"
          size="sm"
        />
      </div>
    </div>
  )
})
