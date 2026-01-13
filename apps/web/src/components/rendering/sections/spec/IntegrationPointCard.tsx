/**
 * IntegrationPointCard - Internal sub-component for SpecContainerSection
 * Task: task-spec-003
 *
 * Displays a single IntegrationPoint with PropertyRenderer-based fields:
 * - Header: name (font-medium) + changeType badge (via ChangeTypeBadge)
 * - File path: via CodePathDisplay with truncate=50
 * - Description: via LongTextDisplay with truncate=100
 *
 * Card styling uses emerald phase colors (Spec phase):
 * - p-3 rounded-lg border bg-card
 * - border-emerald-500/20 hover:border-emerald-500/40
 *
 * This is an INTERNAL sub-component - NOT registered in sectionImplementationMap.
 * Used by SpecContainerSection's TaskDetailsPanel.
 */

import { cn } from "@/lib/utils"
import { PropertyRenderer } from "@/components/rendering/PropertyRenderer"
import type { PropertyMetadata } from "@/components/rendering/types"

/**
 * IntegrationPoint interface
 * Task: task-spec-003
 *
 * Represents a single integration point in the Spec phase.
 * Required fields: id, name, filePath, description
 * Optional fields: changeType, package, targetFunction
 */
export interface IntegrationPoint {
  id: string
  name: string
  filePath: string
  description: string
  changeType?: string
  package?: string
  targetFunction?: string
}

/**
 * Props for IntegrationPointCard component
 */
export interface IntegrationPointCardProps {
  /** The integration point data to display */
  integrationPoint: IntegrationPoint
}

// =============================================================================
// PropertyMetadata definitions for PropertyRenderer
// =============================================================================

/**
 * PropertyMetadata for changeType field
 * Uses change-type-badge renderer for semantic coloring
 */
const changeTypeMeta: PropertyMetadata = {
  name: "changeType",
  type: "string",
  xRenderer: "change-type-badge",
}

/**
 * PropertyMetadata for filePath field
 * Uses code-path-display renderer with truncation
 */
const filePathMeta: PropertyMetadata = {
  name: "filePath",
  type: "string",
  xRenderer: "code-path-display",
}

/**
 * PropertyMetadata for description field
 * Uses long-text renderer with truncation
 */
const integrationPointDescriptionMeta: PropertyMetadata = {
  name: "description",
  type: "string",
  xRenderer: "long-text",
}

// =============================================================================
// IntegrationPointCard Component
// =============================================================================

/**
 * IntegrationPointCard - displays a single IntegrationPoint
 * Task: task-spec-003
 *
 * Features:
 * - Header with name (font-medium) and changeType badge
 * - File path with code-path-display renderer (truncate=50)
 * - Description with long-text renderer (truncate=100)
 * - Emerald phase colors for Spec phase styling
 *
 * @param integrationPoint - The integration point data to display
 */
export function IntegrationPointCard({ integrationPoint }: IntegrationPointCardProps) {
  return (
    <div
      className={cn(
        "p-3 rounded-lg border bg-card",
        "border-emerald-500/20 hover:border-emerald-500/40",
        "transition-colors"
      )}
    >
      {/* Header: name + changeType badge */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="font-medium text-sm truncate">
          {integrationPoint.name}
        </span>
        {integrationPoint.changeType && (
          <PropertyRenderer
            property={changeTypeMeta}
            value={integrationPoint.changeType}
          />
        )}
      </div>

      {/* File path */}
      <div className="mb-2">
        <PropertyRenderer
          property={filePathMeta}
          value={integrationPoint.filePath}
          config={{ truncate: 50 }}
        />
      </div>

      {/* Description */}
      <div className="text-sm">
        <PropertyRenderer
          property={integrationPointDescriptionMeta}
          value={integrationPoint.description}
          config={{ truncate: 100 }}
        />
      </div>
    </div>
  )
}

export default IntegrationPointCard
