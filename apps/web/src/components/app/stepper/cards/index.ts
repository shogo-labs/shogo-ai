/**
 * Stepper Cards Barrel Export
 * Task: task-2-3d-barrel-exports
 *
 * Exports all card components for the Studio App stepper phase views.
 *
 * Per design-2-3d-file-structure:
 * - Card components in /components/app/stepper/cards/
 * - Re-exported from /components/app/stepper/index.ts
 *
 * Usage:
 *   import { TaskCard, TestSpecCard, ExecutionProgress } from '@/components/app/stepper/cards'
 */

// TaskCard - displays ImplementationTask entities
export { TaskCard } from "./TaskCard"
export type { TaskCardProps, Task, TaskStatus } from "./TaskCard"

// TestSpecCard - displays TestSpecification entities
export { TestSpecCard } from "./TestSpecCard"
export type { TestSpecCardProps, TestSpec, TestType } from "./TestSpecCard"

// DependencyIndicator - shows task dependencies with status dots
export { DependencyIndicator } from "./DependencyIndicator"
export type { DependencyIndicatorProps, DependencyTask } from "./DependencyIndicator"

// ExecutionProgress - displays ImplementationRun status
export { ExecutionProgress, runStatusVariants } from "./ExecutionProgress"
export type { ExecutionProgressProps, ImplementationRun, RunStatus } from "./ExecutionProgress"

// TaskExecutionRow - displays TaskExecution in list
export { TaskExecutionRow, executionStatusVariants } from "./TaskExecutionRow"
export type { TaskExecutionRowProps, TaskExecution, ExecutionStatus } from "./TaskExecutionRow"
