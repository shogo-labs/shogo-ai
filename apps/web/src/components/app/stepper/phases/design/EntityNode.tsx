/**
 * EntityNode Component
 * Task: task-2-3c-005
 *
 * Custom ReactFlow node component for schema entities.
 *
 * Per design-2-3c-004:
 * - Shows entity name as header, property count, reference count
 * - CVA variants for selected/default states
 * - Handle positions: target at top, source at bottom
 */

import { memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import type { EntityNodeData } from "./utils/schemaTransform"

/**
 * CVA variants for EntityNode styling
 */
const entityNodeVariants = cva(
  "px-4 py-3 rounded-lg border-2 bg-card min-w-[180px] transition-all",
  {
    variants: {
      selected: {
        true: "border-primary shadow-lg",
        false: "border-border",
      },
    },
    defaultVariants: {
      selected: false,
    },
  }
)

/**
 * EntityNode Props
 */
export interface EntityNodeProps
  extends NodeProps<EntityNodeData>,
    VariantProps<typeof entityNodeVariants> {}

/**
 * EntityNode Component
 *
 * Custom ReactFlow node displaying entity information.
 * Used within SchemaGraph for schema visualization.
 */
export const EntityNode = memo(function EntityNode({ data }: EntityNodeProps) {
  const { name, propertyCount, referenceCount, isSelected } = data

  return (
    <div
      data-testid={`entity-node-${name}`}
      className={cn(entityNodeVariants({ selected: isSelected }))}
    >
      {/* Target handle at top for incoming edges */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-primary !border-background !w-3 !h-3"
      />

      {/* Entity name header */}
      <div className="font-medium text-sm text-foreground">
        {data.name}
      </div>

      {/* Property and reference counts */}
      <div className="text-xs text-muted-foreground mt-1">
        {propertyCount} properties · {referenceCount} refs
      </div>

      {/* Source handle at bottom for outgoing edges */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-primary !border-background !w-3 !h-3"
      />
    </div>
  )
})

// Export variant function for external use
export { entityNodeVariants }
