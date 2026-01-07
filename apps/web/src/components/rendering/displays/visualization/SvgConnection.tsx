/**
 * SvgConnection Component
 * Task: task-w3-svg-connection-utilities
 *
 * A shared SVG utility component for drawing connection lines between related elements.
 * Used by Evidence Board (finding relationships), Schema Blueprint (reference edges
 * outside ReactFlow), and Dependency Network.
 *
 * Features:
 * - Path types: bezier (curved), straight, step (orthogonal)
 * - Line styles: solid, dashed, dotted
 * - Arrow markers for directional relationships
 * - Optional animated flow effect using CSS
 * - Works with DOM element positioning via coordinates
 */

import { memo, useMemo, useId } from "react"
import { cn } from "@/lib/utils"

/**
 * Path type for connection lines
 */
export type PathType = "bezier" | "straight" | "step"

/**
 * Line style for connection lines
 */
export type LineStyle = "solid" | "dashed" | "dotted"

/**
 * Point coordinates
 */
export interface Point {
  x: number
  y: number
}

/**
 * SvgConnection component props
 */
export interface SvgConnectionProps {
  /** Starting point coordinates */
  from: Point
  /** Ending point coordinates */
  to: Point
  /** Path type: bezier (curved), straight, or step (orthogonal) */
  pathType?: PathType
  /** Line style: solid, dashed, or dotted */
  lineStyle?: LineStyle
  /** Show arrow marker at the end */
  showArrow?: boolean
  /** Enable animated flow effect */
  animated?: boolean
  /** Custom stroke color */
  strokeColor?: string
  /** Custom stroke width */
  strokeWidth?: number
  /** Additional CSS classes */
  className?: string
}

/**
 * Get stroke-dasharray value for line style
 */
function getStrokeDasharray(lineStyle: LineStyle): string {
  switch (lineStyle) {
    case "dashed":
      return "8 4"
    case "dotted":
      return "2 2"
    case "solid":
    default:
      return ""
  }
}

/**
 * Generate bezier curve path
 */
function getBezierPath(from: Point, to: Point): string {
  const dx = to.x - from.x
  const dy = to.y - from.y

  // Control points for smooth curve
  const controlOffset = Math.min(Math.abs(dx) * 0.5, 100)
  const cx1 = from.x + controlOffset
  const cy1 = from.y
  const cx2 = to.x - controlOffset
  const cy2 = to.y

  return `M ${from.x} ${from.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${to.x} ${to.y}`
}

/**
 * Generate straight line path
 */
function getStraightPath(from: Point, to: Point): string {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`
}

/**
 * Generate stepped (orthogonal) path
 */
function getStepPath(from: Point, to: Point): string {
  const midX = (from.x + to.x) / 2

  return `M ${from.x} ${from.y} H ${midX} V ${to.y} H ${to.x}`
}

/**
 * Generate path based on path type
 */
function getPath(from: Point, to: Point, pathType: PathType): string {
  switch (pathType) {
    case "straight":
      return getStraightPath(from, to)
    case "step":
      return getStepPath(from, to)
    case "bezier":
    default:
      return getBezierPath(from, to)
  }
}

/**
 * Calculate viewBox that encompasses the connection with padding
 */
function calculateViewBox(from: Point, to: Point, padding: number = 20): string {
  const minX = Math.min(from.x, to.x) - padding
  const minY = Math.min(from.y, to.y) - padding
  const width = Math.abs(to.x - from.x) + padding * 2
  const height = Math.abs(to.y - from.y) + padding * 2

  // Ensure minimum dimensions for zero-length connections
  const finalWidth = Math.max(width, 40)
  const finalHeight = Math.max(height, 40)

  return `${minX} ${minY} ${finalWidth} ${finalHeight}`
}

/**
 * SvgConnection component
 *
 * @example
 * ```tsx
 * // Basic bezier connection
 * <SvgConnection
 *   from={{ x: 0, y: 50 }}
 *   to={{ x: 200, y: 100 }}
 * />
 *
 * // Dashed connection with arrow
 * <SvgConnection
 *   from={{ x: 0, y: 0 }}
 *   to={{ x: 100, y: 100 }}
 *   lineStyle="dashed"
 *   showArrow={true}
 * />
 *
 * // Animated step connection
 * <SvgConnection
 *   from={{ x: 0, y: 0 }}
 *   to={{ x: 200, y: 100 }}
 *   pathType="step"
 *   animated={true}
 * />
 * ```
 */
export const SvgConnection = memo(function SvgConnection({
  from,
  to,
  pathType = "bezier",
  lineStyle = "solid",
  showArrow = false,
  animated = false,
  strokeColor = "currentColor",
  strokeWidth = 2,
  className,
}: SvgConnectionProps) {
  // Generate unique ID for marker reference
  const markerId = useId()
  const arrowMarkerId = `arrow-${markerId}`

  // Calculate path and viewBox
  const path = useMemo(() => getPath(from, to, pathType), [from, to, pathType])
  const viewBox = useMemo(() => calculateViewBox(from, to), [from, to])
  const dasharray = useMemo(() => getStrokeDasharray(lineStyle), [lineStyle])

  // Animation class for flow effect
  const animationClass = animated ? "animate-flow" : ""

  return (
    <svg
      data-svg-connection
      data-animated={animated ? "true" : "false"}
      viewBox={viewBox}
      className={cn(
        "pointer-events-none overflow-visible",
        className
      )}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
      }}
    >
      {/* Arrow marker definition */}
      {showArrow && (
        <defs>
          <marker
            id={arrowMarkerId}
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <polygon
              points="0 0, 10 3, 0 6"
              fill={strokeColor}
            />
          </marker>
        </defs>
      )}

      {/* Connection path */}
      <path
        d={path}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth.toString()}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={dasharray || undefined}
        markerEnd={showArrow ? `url(#${arrowMarkerId})` : undefined}
        className={animationClass}
        style={animated ? {
          animation: "flowAnimation 1s linear infinite",
          strokeDasharray: dasharray || "8 4",
        } : undefined}
      />

      {/* CSS animation keyframes for flow effect */}
      {animated && (
        <style>{`
          @keyframes flowAnimation {
            from {
              stroke-dashoffset: 24;
            }
            to {
              stroke-dashoffset: 0;
            }
          }

          @media (prefers-reduced-motion: reduce) {
            .animate-flow {
              animation: none !important;
            }
          }
        `}</style>
      )}
    </svg>
  )
})
