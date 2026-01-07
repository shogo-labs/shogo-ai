/**
 * EntityNode Component - Enhanced
 * Task: task-w2-design-view-enhance
 *
 * Custom ReactFlow node component for schema entities with
 * CAD-style technical drawing / blueprint aesthetic.
 *
 * Features:
 * - Blueprint-style border with amber accent
 * - Technical drawing corners
 * - Property and reference count display
 * - Selected state with ring highlight
 */

import { memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Box } from "lucide-react"
import type { EntityNodeData } from "./utils/schemaTransform"

/**
 * CVA variants for EntityNode blueprint styling
 */
const entityNodeVariants = cva(
  [
    "px-4 py-3 rounded-lg min-w-[180px] transition-all",
    "bg-card border-2",
    // Blueprint/CAD aesthetic with amber accents
    "relative",
  ],
  {
    variants: {
      selected: {
        true: [
          "border-amber-500",
          "shadow-lg shadow-amber-500/20",
          "ring-2 ring-amber-500/30",
        ],
        false: [
          "border-amber-500/40",
          "hover:border-amber-500/60",
        ],
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
 * Custom ReactFlow node with blueprint/CAD-style technical drawing aesthetic.
 * Used within SchemaGraph for schema visualization.
 */
export const EntityNode = memo(function EntityNode({ data }: EntityNodeProps) {
  const { name, propertyCount, referenceCount, isSelected } = data

  return (
    <div
      data-testid={`entity-node-${name}`}
      className={cn(entityNodeVariants({ selected: isSelected }))}
    >
      {/* Blueprint corner decorations */}
      <div className="absolute -top-px -left-px w-2 h-2 border-t-2 border-l-2 border-amber-500/60 rounded-tl" />
      <div className="absolute -top-px -right-px w-2 h-2 border-t-2 border-r-2 border-amber-500/60 rounded-tr" />
      <div className="absolute -bottom-px -left-px w-2 h-2 border-b-2 border-l-2 border-amber-500/60 rounded-bl" />
      <div className="absolute -bottom-px -right-px w-2 h-2 border-b-2 border-r-2 border-amber-500/60 rounded-br" />

      {/* Target handle at top for incoming edges */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-amber-500 !border-background !w-3 !h-3"
      />

      {/* Entity header with icon */}
      <div className="flex items-center gap-2 mb-2">
        <Box className="h-4 w-4 text-amber-500" />
        <span className="font-medium text-sm text-foreground">
          {data.name}
        </span>
      </div>

      {/* Technical specifications */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground font-mono">
        <span className="flex items-center gap-1">
          <span className="text-amber-500">{propertyCount}</span>
          <span>props</span>
        </span>
        <span className="text-amber-500/40">|</span>
        <span className="flex items-center gap-1">
          <span className="text-amber-500">{referenceCount}</span>
          <span>refs</span>
        </span>
      </div>

      {/* Source handle at bottom for outgoing edges */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-amber-500 !border-background !w-3 !h-3"
      />
    </div>
  )
})

// Export variant function for external use
export { entityNodeVariants }
