/**
 * FilterControl Component
 * Task: task-w3-filter-controls
 *
 * A versatile filter control supporting:
 * - chip-select: Multi-select clickable pill buttons
 * - dropdown: Select element with options
 * - toggle: On/off switch controls
 *
 * Used for filtering data-dense views like Analysis findings,
 * Testing specs, and Design decisions.
 */

import { memo } from "react"
import { cn } from "../../utils/cn"
import { X } from "lucide-react"

/**
 * Filter option definition
 */
export interface FilterOption {
  /** Unique option identifier */
  id: string
  /** Display label */
  label: string
  /** Optional color (for chip styling) */
  color?: string
  /** Optional description */
  description?: string
  /** Optional count badge */
  count?: number
}

/**
 * Filter variant types
 */
export type FilterVariant = "chip-select" | "dropdown" | "toggle"

/**
 * FilterControl component props
 */
export interface FilterControlProps {
  /** Available filter options */
  options: FilterOption[]
  /** Currently selected option IDs */
  value: string[]
  /** Callback when selection changes */
  onChange: (value: string[]) => void
  /** Display variant */
  variant?: FilterVariant
  /** Allow multiple selections (for chip-select and toggle) */
  multiSelect?: boolean
  /** Accessible label */
  label?: string
  /** Placeholder text (for dropdown) */
  placeholder?: string
  /** Show "Clear All" button */
  showClearAll?: boolean
  /** Additional CSS classes */
  className?: string
  /** Size variant */
  size?: "sm" | "md" | "lg"
}

/**
 * Get color classes for chip variant
 */
function getChipColorClasses(
  color?: string,
  selected?: boolean
): string {
  const baseColors: Record<string, { selected: string; unselected: string }> = {
    violet: {
      selected: "bg-violet-500/30 text-violet-300 border-violet-500/50",
      unselected: "bg-violet-500/10 text-violet-400 border-violet-500/20 hover:bg-violet-500/20",
    },
    purple: {
      selected: "bg-purple-500/30 text-purple-300 border-purple-500/50",
      unselected: "bg-purple-500/10 text-purple-400 border-purple-500/20 hover:bg-purple-500/20",
    },
    red: {
      selected: "bg-red-500/30 text-red-300 border-red-500/50",
      unselected: "bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20",
    },
    amber: {
      selected: "bg-amber-500/30 text-amber-300 border-amber-500/50",
      unselected: "bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20",
    },
    cyan: {
      selected: "bg-cyan-500/30 text-cyan-300 border-cyan-500/50",
      unselected: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20 hover:bg-cyan-500/20",
    },
    green: {
      selected: "bg-green-500/30 text-green-300 border-green-500/50",
      unselected: "bg-green-500/10 text-green-400 border-green-500/20 hover:bg-green-500/20",
    },
    default: {
      selected: "bg-primary/30 text-primary border-primary/50",
      unselected: "bg-muted text-muted-foreground border-border hover:bg-muted/80",
    },
  }

  const colorKey = color && baseColors[color] ? color : "default"
  return selected ? baseColors[colorKey].selected : baseColors[colorKey].unselected
}

/**
 * Chip-select variant
 */
function ChipSelectVariant({
  options,
  value,
  onChange,
  multiSelect = false,
  label,
  showClearAll,
  size = "md",
  className,
}: FilterControlProps) {
  const sizeClasses = {
    sm: "px-2 py-0.5 text-xs",
    md: "px-3 py-1 text-sm",
    lg: "px-4 py-1.5 text-base",
  }

  const handleChipClick = (optionId: string) => {
    const isSelected = value.includes(optionId)

    if (multiSelect) {
      if (isSelected) {
        onChange(value.filter((id) => id !== optionId))
      } else {
        onChange([...value, optionId])
      }
    } else {
      // Single select: toggle or replace
      if (isSelected) {
        onChange([])
      } else {
        onChange([optionId])
      }
    }
  }

  const handleClearAll = () => {
    onChange([])
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {options.map((option) => {
        const isSelected = value.includes(option.id)
        return (
          <button
            key={option.id}
            type="button"
            data-chip={option.id}
            data-selected={isSelected}
            onClick={() => handleChipClick(option.id)}
            className={cn(
              "rounded-full border font-medium transition-all duration-150",
              "focus:outline-none focus:ring-2 focus:ring-primary/50",
              sizeClasses[size],
              getChipColorClasses(option.color, isSelected)
            )}
          >
            <span className="flex items-center gap-1.5">
              {option.label}
              {option.count !== undefined && (
                <span className="opacity-60">({option.count})</span>
              )}
            </span>
          </button>
        )
      })}

      {showClearAll && value.length > 0 && (
        <button
          type="button"
          data-clear-all
          onClick={handleClearAll}
          className={cn(
            "rounded-full border border-border/50 px-2 py-0.5",
            "text-xs text-muted-foreground hover:text-foreground",
            "flex items-center gap-1 transition-colors"
          )}
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      )}
    </div>
  )
}

/**
 * Dropdown variant
 */
function DropdownVariant({
  options,
  value,
  onChange,
  label,
  placeholder = "Select...",
  size = "md",
  className,
}: FilterControlProps) {
  const sizeClasses = {
    sm: "px-2 py-1 text-xs",
    md: "px-3 py-1.5 text-sm",
    lg: "px-4 py-2 text-base",
  }

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedValue = e.target.value
    if (selectedValue === "") {
      onChange([])
    } else {
      onChange([selectedValue])
    }
  }

  return (
    <select
      aria-label={label}
      value={value[0] || ""}
      onChange={handleChange}
      className={cn(
        "rounded-md border border-border bg-card text-foreground",
        "focus:outline-none focus:ring-2 focus:ring-primary/50",
        "cursor-pointer",
        sizeClasses[size],
        className
      )}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
          {option.count !== undefined && ` (${option.count})`}
        </option>
      ))}
    </select>
  )
}

/**
 * Toggle variant
 */
function ToggleVariant({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
}: FilterControlProps) {
  const sizeClasses = {
    sm: { track: "w-8 h-4", thumb: "w-3 h-3", translate: "translate-x-4" },
    md: { track: "w-10 h-5", thumb: "w-4 h-4", translate: "translate-x-5" },
    lg: { track: "w-12 h-6", thumb: "w-5 h-5", translate: "translate-x-6" },
  }

  const config = sizeClasses[size]

  const handleToggle = (optionId: string) => {
    const isChecked = value.includes(optionId)
    if (isChecked) {
      onChange(value.filter((id) => id !== optionId))
    } else {
      onChange([...value, optionId])
    }
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-col gap-2", className)}
    >
      {options.map((option) => {
        const isChecked = value.includes(option.id)
        return (
          <div
            key={option.id}
            className="flex items-center justify-between gap-3"
          >
            <span className="text-sm text-foreground">{option.label}</span>
            <button
              type="button"
              role="switch"
              aria-checked={isChecked}
              data-toggle={option.id}
              data-checked={isChecked}
              onClick={() => handleToggle(option.id)}
              className={cn(
                "relative inline-flex items-center rounded-full",
                "transition-colors duration-200",
                "focus:outline-none focus:ring-2 focus:ring-primary/50",
                config.track,
                isChecked ? "bg-primary" : "bg-muted"
              )}
            >
              <span
                className={cn(
                  "inline-block rounded-full bg-white shadow-sm",
                  "transition-transform duration-200",
                  config.thumb,
                  isChecked ? config.translate : "translate-x-0.5"
                )}
              />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * FilterControl component
 *
 * @example
 * ```tsx
 * // Chip-select for finding types
 * <FilterControl
 *   variant="chip-select"
 *   options={[
 *     { id: "pattern", label: "Patterns", color: "violet" },
 *     { id: "risk", label: "Risks", color: "red" },
 *   ]}
 *   value={selectedTypes}
 *   onChange={setSelectedTypes}
 *   multiSelect
 * />
 *
 * // Dropdown for sort order
 * <FilterControl
 *   variant="dropdown"
 *   options={[
 *     { id: "newest", label: "Newest First" },
 *     { id: "oldest", label: "Oldest First" },
 *   ]}
 *   value={sortOrder}
 *   onChange={setSortOrder}
 *   label="Sort by"
 * />
 *
 * // Toggle for filter flags
 * <FilterControl
 *   variant="toggle"
 *   options={[
 *     { id: "show-passed", label: "Show Passed" },
 *     { id: "show-failed", label: "Show Failed" },
 *   ]}
 *   value={activeFilters}
 *   onChange={setActiveFilters}
 * />
 * ```
 */
export const FilterControl = memo(function FilterControl(
  props: FilterControlProps
) {
  const { variant = "chip-select" } = props

  switch (variant) {
    case "dropdown":
      return <DropdownVariant {...props} />
    case "toggle":
      return <ToggleVariant {...props} />
    case "chip-select":
    default:
      return <ChipSelectVariant {...props} />
  }
})
