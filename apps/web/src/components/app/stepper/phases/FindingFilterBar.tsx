/**
 * FindingFilterBar Component
 * Task: task-w3-filter-controls
 *
 * A multi-select chip filter bar for filtering analysis findings by type.
 * Uses the FilterControl component with chip-select variant.
 *
 * Used in AnalysisView to filter findings by type (pattern, gap, risk, etc.).
 */

import { memo, useMemo } from "react"
import { cn } from "@/lib/utils"
import { Filter } from "lucide-react"
import {
  FilterControl,
  type FilterOption,
} from "@/components/rendering"
import type { FindingType } from "../shared"

/**
 * Finding type configuration with labels and colors
 */
const FINDING_TYPE_CONFIG: Record<FindingType, { label: string; color: string }> = {
  pattern: { label: "Patterns", color: "violet" },
  gap: { label: "Gaps", color: "amber" },
  risk: { label: "Risks", color: "red" },
  classification_evidence: { label: "Evidence", color: "cyan" },
  integration_point: { label: "Integration", color: "green" },
  verification: { label: "Verification", color: "purple" },
  existing_test: { label: "Tests", color: "cyan" },
}

/**
 * All finding types in display order
 */
const FINDING_TYPE_ORDER: FindingType[] = [
  "pattern",
  "gap",
  "risk",
  "classification_evidence",
  "integration_point",
  "verification",
  "existing_test",
]

/**
 * Props for FindingFilterBar component
 */
export interface FindingFilterBarProps {
  /** Currently selected finding types */
  selectedTypes: FindingType[]
  /** Callback when type selection changes */
  onSelectionChange: (types: FindingType[]) => void
  /** Optional counts per type for badges */
  typeCounts?: Partial<Record<FindingType, number>>
  /** Additional CSS classes */
  className?: string
  /** Show clear all button */
  showClearAll?: boolean
}

/**
 * FindingFilterBar Component
 *
 * Multi-select chip filter for analysis findings by type.
 *
 * @example
 * ```tsx
 * const [selectedTypes, setSelectedTypes] = useState<FindingType[]>([])
 *
 * <FindingFilterBar
 *   selectedTypes={selectedTypes}
 *   onSelectionChange={setSelectedTypes}
 *   typeCounts={{ pattern: 5, gap: 2, risk: 3 }}
 * />
 * ```
 */
export const FindingFilterBar = memo(function FindingFilterBar({
  selectedTypes,
  onSelectionChange,
  typeCounts,
  className,
  showClearAll = true,
}: FindingFilterBarProps) {
  // Build filter options from finding type config
  const filterOptions: FilterOption[] = useMemo(() => {
    return FINDING_TYPE_ORDER.map((type) => {
      const config = FINDING_TYPE_CONFIG[type]
      return {
        id: type,
        label: config.label,
        color: config.color,
        count: typeCounts?.[type],
      }
    })
  }, [typeCounts])

  // Handle selection change with proper typing
  const handleChange = (value: string[]) => {
    onSelectionChange(value as FindingType[])
  }

  return (
    <div
      data-testid="finding-filter-bar"
      className={cn("flex items-center gap-3", className)}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Filter className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wide">
          Filter
        </span>
      </div>
      <FilterControl
        options={filterOptions}
        value={selectedTypes}
        onChange={handleChange}
        variant="chip-select"
        multiSelect
        showClearAll={showClearAll}
        label="Filter findings by type"
        size="sm"
      />
    </div>
  )
})
