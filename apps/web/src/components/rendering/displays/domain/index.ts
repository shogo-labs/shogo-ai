/**
 * Domain Display Renderers
 * Task: task-domain-renderers-index
 *
 * Barrel export for all domain-specific display renderers.
 * These renderers provide semantic coloring for platform-features schema enum fields.
 */

// Variants
export * from "./variants"

// Renderers
export { PriorityBadge } from "./PriorityBadge"
export { ArchetypeBadge } from "./ArchetypeBadge"
export { FindingTypeBadge } from "./FindingTypeBadge"
export { TaskStatusBadge } from "./TaskStatusBadge"
export { TestTypeBadge } from "./TestTypeBadge"
export { SessionStatusBadge } from "./SessionStatusBadge"
export { RequirementStatusBadge } from "./RequirementStatusBadge"
export { RunStatusBadge } from "./RunStatusBadge"
export { ExecutionStatusBadge } from "./ExecutionStatusBadge"
export { TestCaseStatusBadge } from "./TestCaseStatusBadge"
export { TaskRenderer } from "./TaskRenderer"
