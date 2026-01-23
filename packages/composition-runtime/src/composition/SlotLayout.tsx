/**
 * SlotLayout Component
 * Task: task-cpv-011
 *
 * Renders CSS Grid layouts from LayoutTemplate data.
 * Maps position hints (top/left/right/bottom) to grid template areas.
 * Children are placed in named slots.
 *
 * Responsive behavior:
 * - Desktop: Side-by-side layout with header/footer spanning
 * - Mobile: Stacked layout
 */

import { memo, useMemo, type ReactNode } from "react"
import { cn } from "../utils/cn"

/**
 * Slot definition from LayoutTemplate
 */
export interface SlotDefinition {
  name: string
  position: string
  required?: boolean
}

/**
 * LayoutTemplate subset needed by SlotLayout
 */
export interface LayoutTemplateData {
  slots: SlotDefinition[]
}

/**
 * SlotLayout component props
 */
export interface SlotLayoutProps {
  /** Layout template defining slots and positions */
  layout: LayoutTemplateData
  /** Content for each slot, keyed by slot name. Can be a single ReactNode or an array for stacking. */
  children: Record<string, ReactNode | ReactNode[]>
  /** Additional CSS classes */
  className?: string
  /** Gap size (Tailwind gap scale: 1, 2, 4, 6, 8, etc.) */
  gap?: number
}

/**
 * Maps position hints to CSS Grid area names
 */
const positionToArea: Record<string, string> = {
  // Basic positions
  top: "header",
  left: "main",
  right: "sidebar",
  bottom: "actions",
  // Single-column layout position
  center: "main",
  // Enhanced layout positions
  "top-full": "hero",
  "left-top": "overview",
  "left-main": "intent",
  "center-main": "requirements",
  "right-sidebar": "insights",
  "right-footer": "context",
  "bottom-full": "actions",
}

/**
 * Get grid area name for a slot based on its position
 */
function getGridArea(position: string): string {
  return positionToArea[position] || position
}

/**
 * Detect layout type based on positions
 */
function detectLayoutType(positions: Set<string>): "basic" | "enhanced" {
  // Enhanced layout has distinctive position patterns
  if (
    positions.has("top-full") ||
    positions.has("left-top") ||
    positions.has("center-main") ||
    positions.has("right-sidebar")
  ) {
    return "enhanced"
  }
  return "basic"
}

/**
 * Generate CSS grid-template-areas based on layout slots
 */
function generateGridTemplateAreas(slots: SlotDefinition[]): string {
  const positions = new Set(slots.map((s) => s.position))
  const layoutType = detectLayoutType(positions)

  // Handle single-slot layouts (center or single left position)
  if (slots.length === 1) {
    const singleArea = getGridArea(slots[0].position)
    return `"${singleArea}"`
  }

  if (layoutType === "enhanced") {
    // Enhanced 3-column grid layout for discovery phase
    const areas: string[] = []

    // Hero row spans all columns
    if (positions.has("top-full")) {
      areas.push('"hero hero hero"')
    }

    // Main content row: left column (2 rows), center, right sidebar
    const hasLeftTop = positions.has("left-top")
    const hasLeftMain = positions.has("left-main")
    const hasCenterMain = positions.has("center-main")
    const hasRightSidebar = positions.has("right-sidebar")
    const hasRightFooter = positions.has("right-footer")

    if (hasLeftTop || hasLeftMain || hasCenterMain || hasRightSidebar || hasRightFooter) {
      // Row 1: overview, requirements, insights
      const row1Parts = [
        hasLeftTop ? "overview" : ".",
        hasCenterMain ? "requirements" : ".",
        hasRightSidebar ? "insights" : ".",
      ]
      areas.push(`"${row1Parts.join(" ")}"`)

      // Row 2: intent, requirements (continued), context or insights (continued)
      const row2Parts = [
        hasLeftMain ? "intent" : ".",
        hasCenterMain ? "requirements" : ".",
        hasRightFooter ? "context" : hasRightSidebar ? "insights" : ".",
      ]
      areas.push(`"${row2Parts.join(" ")}"`)
    }

    // Actions row spans all columns
    if (positions.has("bottom-full")) {
      areas.push('"actions actions actions"')
    }

    return areas.length > 0 ? areas.join(" ") : '". . ."'
  }

  // Basic layout (original logic)
  const hasTop = positions.has("top")
  const hasBottom = positions.has("bottom")
  const hasLeft = positions.has("left")
  const hasRight = positions.has("right")

  const areas: string[] = []

  // Header row spans full width
  if (hasTop) {
    areas.push('"header header"')
  }

  // Main content row
  if (hasLeft || hasRight) {
    if (hasLeft && hasRight) {
      areas.push('"main sidebar"')
    } else if (hasLeft) {
      areas.push('"main main"')
    } else {
      areas.push('"sidebar sidebar"')
    }
  }

  // Actions/footer row spans full width
  if (hasBottom) {
    areas.push('"actions actions"')
  }

  // Handle edge cases
  if (areas.length === 0) {
    // No standard positions - use center or custom areas
    const customAreas = slots.map((s) => getGridArea(s.position)).join(" ")
    if (customAreas) {
      areas.push(`"${customAreas}"`)
    }
  }

  return areas.join(" ")
}

/**
 * Get grid columns configuration based on layout type
 */
function getGridColumnsClass(slots: SlotDefinition[]): string {
  // Single-slot layouts always use single column
  if (slots.length === 1) {
    return "grid-cols-1"
  }

  const positions = new Set(slots.map((s) => s.position))
  const layoutType = detectLayoutType(positions)

  if (layoutType === "enhanced") {
    // 3-column layout: left (minmax), center (1fr), right (minmax)
    return "md:grid-cols-[minmax(300px,1fr)_2fr_minmax(300px,400px)]"
  }

  // Basic 2-column layout - only apply if both left and right positions exist
  const hasLeft = positions.has("left")
  const hasRight = positions.has("right")
  // Use equal 1fr columns for split view, creating a 50/50 split
  return hasLeft && hasRight ? "md:grid-cols-2" : "grid-cols-1"
}

/**
 * Get Tailwind gap class from numeric value
 */
function getGapClass(gap: number | undefined): string {
  if (gap === undefined) return "gap-4"
  return `gap-${gap}`
}

/**
 * SlotLayout component
 *
 * @example
 * ```tsx
 * const layout = {
 *   slots: [
 *     { name: "header", position: "top", required: true },
 *     { name: "main", position: "left", required: true },
 *     { name: "sidebar", position: "right" },
 *     { name: "footer", position: "bottom" },
 *   ],
 * }
 *
 * <SlotLayout layout={layout}>
 *   {{
 *     header: <Header />,
 *     main: <MainContent />,
 *     sidebar: <Sidebar />,
 *     footer: <Footer />,
 *   }}
 * </SlotLayout>
 * ```
 */
export const SlotLayout = memo(function SlotLayout({
  layout,
  children,
  className,
  gap,
}: SlotLayoutProps) {
  // Memoize grid template areas calculation
  const gridTemplateAreas = useMemo(
    () => generateGridTemplateAreas(layout.slots),
    [layout.slots]
  )

  // Determine grid columns class based on layout type
  const gridColumnsClass = useMemo(() => getGridColumnsClass(layout.slots), [layout.slots])

  // Build inline styles for grid template
  const gridStyle = useMemo(() => {
    const style: React.CSSProperties = {}

    if (gridTemplateAreas) {
      style.gridTemplateAreas = gridTemplateAreas
      // Count unique rows in the grid template
      // gridTemplateAreas format: '"main"' or '"header" "main"' etc.
      const rowCount = gridTemplateAreas.split('"').filter((_, i) => i % 2 === 1).length
      // Make rows fill available space: auto for all but last, 1fr for last (main content)
      // For single row: '1fr', for multi-row: 'auto 1fr' or 'auto 1fr auto' etc.
      if (rowCount === 1) {
        style.gridTemplateRows = '1fr'
      } else {
        // For multi-row layouts, use minmax(0, 1fr) for flexible row
        style.gridTemplateRows = Array(rowCount).fill('minmax(0, 1fr)').join(' ')
      }
    }

    return style
  }, [gridTemplateAreas])

  return (
    <div
      data-slot-layout="true"
      className={cn(
        "grid h-full",
        getGapClass(gap),
        // Responsive columns
        "grid-cols-1",
        gridColumnsClass,
        // Responsive grid template areas
        className
      )}
      style={gridStyle}
    >
      {layout.slots.map((slot) => {
        const gridArea = getGridArea(slot.position)
        const content = children[slot.name]

        // Handle slot stacking: wrap arrays in flex column container
        const renderedContent = Array.isArray(content) ? (
          content.length > 0 ? (
            <div className="flex flex-col gap-4">
              {content}
            </div>
          ) : null
        ) : (
          content
        )

        return (
          <div
            key={slot.name}
            data-slot={slot.name}
            className="min-h-0 h-full"
            style={{ gridArea }}
          >
            {renderedContent}
          </div>
        )
      })}
    </div>
  )
})

export default SlotLayout
