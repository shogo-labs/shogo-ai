/**
 * ImpactEntityTags Component
 * Task: task-w3-decision-timeline
 *
 * Displays clickable badges/tags representing schema entities
 * affected by a design decision. Tags are interactive and can
 * link to entities in the schema graph.
 *
 * Uses phase-design amber color tokens for consistent styling.
 */

import { memo } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { Box } from "lucide-react"

/**
 * Entity reference type for impact tags
 */
export interface EntityReference {
  /** Entity ID (model name) */
  id: string
  /** Display name */
  name: string
  /** Optional entity type (e.g., "model", "property") */
  type?: "model" | "property" | "reference"
}

/**
 * Props for ImpactEntityTags component
 */
export interface ImpactEntityTagsProps {
  /** Array of affected entities to display */
  entities: EntityReference[]
  /** Callback when an entity tag is clicked */
  onEntityClick?: (entity: EntityReference) => void
  /** Additional CSS classes */
  className?: string
}

/**
 * ImpactEntityTags Component
 *
 * Renders a list of clickable entity badges showing which schema
 * entities are affected by a design decision.
 *
 * @example
 * ```tsx
 * <ImpactEntityTags
 *   entities={[
 *     { id: "User", name: "User", type: "model" },
 *     { id: "Product", name: "Product", type: "model" },
 *   ]}
 *   onEntityClick={(entity) => selectEntity(entity.id)}
 * />
 * ```
 */
export const ImpactEntityTags = memo(function ImpactEntityTags({
  entities,
  onEntityClick,
  className,
}: ImpactEntityTagsProps) {
  // No entities to display
  if (!entities || entities.length === 0) {
    return (
      <div
        data-testid="impact-entity-tags"
        className={cn("text-xs text-muted-foreground italic", className)}
      >
        No affected entities
      </div>
    )
  }

  return (
    <div
      data-testid="impact-entity-tags"
      className={cn("flex flex-wrap gap-2", className)}
    >
      {entities.map((entity) => (
        <Badge
          key={entity.id}
          variant="outline"
          className={cn(
            "cursor-pointer transition-colors",
            "hover:bg-amber-500/20 hover:border-amber-500",
            "text-xs font-normal"
          )}
          onClick={() => onEntityClick?.(entity)}
        >
          <Box className="h-3 w-3 mr-1 text-amber-500" />
          {entity.name}
        </Badge>
      ))}
    </div>
  )
})
