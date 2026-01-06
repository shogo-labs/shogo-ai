/**
 * ReferenceEdge Component
 * Task: task-2-3c-006
 *
 * Custom ReactFlow edge component for entity references.
 *
 * Per design-2-3c-005:
 * - Solid stroke for required, dashed for optional
 * - Arrow marker at end
 * - Label showing field name
 */

import {
  getSmoothStepPath,
  EdgeLabelRenderer,
  MarkerType,
  type EdgeProps,
} from "@xyflow/react"
import { cn } from "@/lib/utils"
import type { ReferenceEdgeData } from "./utils/schemaTransform"

/**
 * ReferenceEdge Component
 *
 * Custom ReactFlow edge displaying reference relationships.
 * Solid line for required references, dashed for optional.
 */
export function ReferenceEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
}: EdgeProps<ReferenceEdgeData>) {
  const { label, isOptional } = data || { label: "", isOptional: false }

  // Calculate smooth step path
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  // Stroke color based on optionality
  const strokeColor = isOptional
    ? "hsl(var(--muted-foreground))"
    : "hsl(var(--primary))"

  // Stroke style based on optionality
  const strokeStyle = isOptional ? "4" : undefined

  return (
    <>
      <path
        id={id}
        data-testid={`reference-edge-${source}-${target}`}
        className={cn(
          "react-flow__edge-path",
          isOptional ? "stroke-muted-foreground" : "stroke-primary"
        )}
        d={edgePath}
        style={{
          ...style,
          strokeWidth: 2,
          stroke: strokeColor,
          strokeDasharray: strokeStyle,
        }}
        markerEnd={`url(#${MarkerType.ArrowClosed})`}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className="bg-background px-1 rounded text-xs text-muted-foreground border"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
