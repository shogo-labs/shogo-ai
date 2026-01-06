/**
 * Studio Component Registry Configuration
 * Task: task-studio-registry
 *
 * Extended registry with domain-specific renderers for Studio App.
 * Domain renderers register at priority 200 to override the generic EnumBadge (50).
 */

import { createDefaultRegistry } from "./defaultRegistry"
import {
  PriorityBadge,
  ArchetypeBadge,
  FindingTypeBadge,
  TaskStatusBadge,
  TestTypeBadge,
  SessionStatusBadge,
  RequirementStatusBadge,
  RunStatusBadge,
  ExecutionStatusBadge,
  TestCaseStatusBadge,
} from "./displays/domain"

/**
 * Creates a registry with default renderers plus Studio domain renderers.
 *
 * Domain renderers are registered at priority 200, overriding the generic
 * EnumBadge (50) when x-renderer is specified in the schema.
 *
 * Priority cascade:
 * 1. xRenderer explicit (200) - domain-specific badges
 * 2. xComputed (100)
 * 3. xReferenceType (100)
 * 4. enum (50) - generic EnumBadge fallback
 * 5. format (30)
 * 6. type (10)
 * 7. fallback (0)
 */
export function createStudioRegistry() {
  const registry = createDefaultRegistry()

  // Register domain renderers at priority 200 (xRenderer explicit binding)
  registry.register({
    id: "priority-badge",
    matches: (meta) => meta.xRenderer === "priority-badge",
    component: PriorityBadge,
    priority: 200,
  })

  registry.register({
    id: "archetype-badge",
    matches: (meta) => meta.xRenderer === "archetype-badge",
    component: ArchetypeBadge,
    priority: 200,
  })

  registry.register({
    id: "finding-type-badge",
    matches: (meta) => meta.xRenderer === "finding-type-badge",
    component: FindingTypeBadge,
    priority: 200,
  })

  registry.register({
    id: "task-status-badge",
    matches: (meta) => meta.xRenderer === "task-status-badge",
    component: TaskStatusBadge,
    priority: 200,
  })

  registry.register({
    id: "test-type-badge",
    matches: (meta) => meta.xRenderer === "test-type-badge",
    component: TestTypeBadge,
    priority: 200,
  })

  registry.register({
    id: "session-status-badge",
    matches: (meta) => meta.xRenderer === "session-status-badge",
    component: SessionStatusBadge,
    priority: 200,
  })

  registry.register({
    id: "requirement-status-badge",
    matches: (meta) => meta.xRenderer === "requirement-status-badge",
    component: RequirementStatusBadge,
    priority: 200,
  })

  registry.register({
    id: "run-status-badge",
    matches: (meta) => meta.xRenderer === "run-status-badge",
    component: RunStatusBadge,
    priority: 200,
  })

  registry.register({
    id: "execution-status-badge",
    matches: (meta) => meta.xRenderer === "execution-status-badge",
    component: ExecutionStatusBadge,
    priority: 200,
  })

  registry.register({
    id: "test-case-status-badge",
    matches: (meta) => meta.xRenderer === "test-case-status-badge",
    component: TestCaseStatusBadge,
    priority: 200,
  })

  return registry
}
