/**
 * Visualization Primitives Index
 * Task: task-w2-registry-integration
 *
 * Exports all visualization primitives for use in the component registry.
 * These components are registered in studioRegistry.ts at priority 200
 * and discoverable via x-renderer schema extension.
 */

// Shared visualization primitives
export { ProgressBar } from "./ProgressBar"
export type { ProgressBarProps, ProgressSegment } from "./ProgressBar"

export { DataCard } from "./DataCard"
export type { DataCardProps, DataCardVariant } from "./DataCard"

export { GraphNode } from "./GraphNode"
export type {
  GraphNodeProps,
  GraphNodeData,
  GraphNodeVariant,
  TaskStatus,
} from "./GraphNode"

export { StatusIndicator } from "./StatusIndicator"
export type {
  StatusIndicatorProps,
  Stage,
  IndicatorLayout,
  StageStatus,
} from "./StatusIndicator"

export { FilterControl } from "./FilterControl"
export type {
  FilterControlProps,
  FilterOption,
  FilterVariant,
} from "./FilterControl"

export { SvgConnection } from "./SvgConnection"
export type {
  SvgConnectionProps,
  Point,
  PathType,
  LineStyle,
} from "./SvgConnection"
