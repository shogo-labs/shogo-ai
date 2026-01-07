/**
 * ReferenceEdge Component - Enhanced
 * Task: task-w2-design-view-enhance
 *
 * Custom ReactFlow edge component for entity references with
 * differentiated styling based on reference type.
 *
 * Edge Types:
 * - single: Solid amber line with arrow
 * - array: Solid amber line with double arrow
 * - maybe-ref: Dashed amber line with arrow (optional)
 *
 * Uses amber color tokens for design phase consistency.
 */

import {
  getSmoothStepPath,
  EdgeLabelRenderer,
  type EdgeProps,
} from "@xyflow/react"
import { cn } from "@/lib/utils"
import type { ReferenceEdgeData } from "./utils/schemaTransform"

/**
 * Get stroke style based on reference type
 */
function getEdgeStyle(referenceType?: string, isOptional?: boolean) {
  // Maybe-reference or optional: dashed line
  if (referenceType === "maybe" || isOptional) {
    return {
      stroke: "#d97706", // amber-600
      strokeDasharray: "6 3",
      strokeWidth: 2,
    }
  }

  // Array reference: slightly thicker solid line
  if (referenceType === "array") {
    return {
      stroke: "#f59e0b", // amber-500
      strokeDasharray: undefined,
      strokeWidth: 3,
    }
  }

  // Single reference (default): solid line
  return {
    stroke: "#f59e0b", // amber-500
    strokeDasharray: undefined,
    strokeWidth: 2,
  }
}

/**
 * ReferenceEdge Component
 *
 * Custom ReactFlow edge displaying reference relationships with
 * differentiated styling based on reference type.
 * - Solid line for single/required references
 * - Thicker solid line for array references
 * - Dashed line for optional/maybe references
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
  markerEnd,
}: EdgeProps<ReferenceEdgeData>) {
  const { label, isOptional, referenceType } = data || { label: "", isOptional: false }

  // Calculate smooth step path
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  // Get edge styling based on type
  const edgeStyle = getEdgeStyle(referenceType, isOptional)

  // Determine label background color based on type
  const labelBgColor = isOptional
    ? "bg-amber-500/10"
    : referenceType === "array"
      ? "bg-amber-500/20"
      : "bg-background"

  return (
    <>
      <path
        id={id}
        data-testid={`reference-edge-${source}-${target}`}
        className="react-flow__edge-path"
        d={edgePath}
        fill="none"
        style={{
          ...style,
          ...edgeStyle,
        }}
        markerEnd={markerEnd as string}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className={cn(
              "px-2 py-0.5 rounded text-xs border border-amber-500/30",
              labelBgColor
            )}
          >
            <span className="text-amber-700 dark:text-amber-300 font-mono">
              {label}
            </span>
            {referenceType === "array" && (
              <span className="ml-1 text-amber-500">[]</span>
            )}
            {isOptional && (
              <span className="ml-1 text-muted-foreground">?</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
