// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client-side shapes for the universal workspace-agent primitives (agent
 * profile, goals, activity) served by `apps/api/src/routes/workspace-agent.ts`.
 *
 * These were previously hand-typed as `Personal*` interfaces directly in
 * `apps/mobile/lib/api.ts` — the only client that used them so far. Moving
 * them here (rather than generating them, since this router predates and
 * sits outside the CRUD route generator) means a future web or desktop
 * companion surface imports the same definitions instead of retyping them,
 * and a field can't drift between mobile's copy and a second one. Named
 * for the universal primitive, not the personal surface, per this
 * feature's "universal primitives get universal names" principle — any
 * workspace runtime can have an agent profile and goals, not just personal
 * ones.
 */

export type GoalStatus = 'active' | 'paused' | 'done'
export type GoalEventKind = 'progress' | 'blocker' | 'approval' | 'note' | 'deliverable'

export interface WorkspaceAgentProfile {
  id: string
  workspaceId: string
  name: string
  avatarUrl: string | null
  tagline: string | null
  personality: string | null
  statusText: string | null
  statusUpdatedAt: string | null
}

export interface AgentScheduleSummary {
  id: string
  goalId: string | null
  name: string
  prompt: string
  cronExpression: string
  timezone: string
  enabled: boolean
  nextRunAt: string
  lastRunAt: string | null
  lastRunStatus: string | null
  lastRunSummary: string | null
  lastError: string | null
}

export interface Goal {
  id: string
  workspaceId: string
  title: string
  why: string | null
  status: GoalStatus
  plan: unknown
  deliverables: unknown
  schedules?: AgentScheduleSummary[]
  nextCheckInAt: string | null
  lastProgressAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * `Goal.plan` is a free-form `Json` column (the agent decides its own plan
 * shape via `goal_create`/`goal_update`) — this is the shape the agent's
 * tool description asks for and the mobile Goal Detail screen renders. Any
 * other shape simply renders no steps rather than throwing.
 */
export interface GoalPlanStep {
  title: string
  done?: boolean
  detail?: string
}

/** Same free-form-`Json` situation as `GoalPlanStep`, for `Goal.deliverables`. */
export interface GoalDeliverable {
  type?: 'url' | 'file' | 'project'
  title?: string
  url?: string
  projectId?: string
  description?: string
}

/** Best-effort parse of `Goal.plan` into a step list; unknown shapes yield []. */
export function parseGoalPlan(plan: unknown): GoalPlanStep[] {
  if (!Array.isArray(plan)) return []
  const steps: GoalPlanStep[] = []
  for (const entry of plan) {
    if (typeof entry === 'string') {
      steps.push({ title: entry })
    } else if (entry && typeof entry === 'object' && typeof (entry as any).title === 'string') {
      steps.push({
        title: (entry as any).title,
        done: (entry as any).done === true,
        detail: typeof (entry as any).detail === 'string' ? (entry as any).detail : undefined,
      })
    }
  }
  return steps
}

/** Best-effort parse of `Goal.deliverables` into artifact cards; unknown shapes yield []. */
export function parseGoalDeliverables(deliverables: unknown): GoalDeliverable[] {
  if (!Array.isArray(deliverables)) return []
  const items: GoalDeliverable[] = []
  for (const entry of deliverables) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    items.push({
      type: e.type === 'file' || e.type === 'project' ? e.type : 'url',
      title: typeof e.title === 'string' ? e.title : undefined,
      url: typeof e.url === 'string' ? e.url : undefined,
      projectId: typeof e.projectId === 'string' ? e.projectId : undefined,
      description: typeof e.description === 'string' ? e.description : undefined,
    })
  }
  return items
}

export interface WorkspaceActivityItem {
  type: 'goal_event' | 'agent_task'
  id: string
  goalId?: string | null
  goalTitle?: string
  kind?: GoalEventKind
  message?: string
  title?: string
  status?: string
  currentStep?: string | null
  resultSummary?: string | null
  errorMessage?: string | null
  /**
   * Free-form per-event detail. For `kind: 'approval'` goal events, an
   * unresolved approval has no `metadata.resolvedAt` — see
   * `isApprovalPending` in the API's `workspace-agent.service.ts` (the
   * read-side match for the approval-resolution write in the same file).
   */
  metadata?: { resolvedAt?: string; decision?: 'approved' | 'declined'; [key: string]: unknown } | null
  createdAt: string
  updatedAt?: string
  completedAt?: string | null
}

/**
 * An `approval` goal-event item with no recorded decision yet — the
 * client-side twin of the API's `isApprovalPending` (`workspace-agent.service.ts`).
 * Kept as one function here so "Needs your OK" filtering can't drift between
 * the Goals screen and the Activity screen.
 */
export function isApprovalPending(item: Pick<WorkspaceActivityItem, 'type' | 'kind' | 'metadata'>): boolean {
  return item.type === 'goal_event' && item.kind === 'approval' && !item.metadata?.resolvedAt
}

/**
 * The raw shape of a single `GoalEvent` row, as returned nested under
 * `Goal.events` by `GET /workspaces/:id/goals/:goalId` (the Goal Detail
 * screen's timeline). This is distinct from `WorkspaceActivityItem`, which
 * is the flattened cross-goal feed used by `/activity` — it has no `type`
 * discriminant or `goalTitle` because it's always scoped to one goal.
 */
export interface GoalEventRecord {
  id: string
  goalId: string
  kind: GoalEventKind
  message: string
  metadata?: { resolvedAt?: string; decision?: 'approved' | 'declined'; [key: string]: unknown } | null
  createdAt: string
}

/** `isApprovalPending` for a goal-detail-scoped `GoalEventRecord` rather than a flattened activity item. */
export function isGoalEventApprovalPending(event: Pick<GoalEventRecord, 'kind' | 'metadata'>): boolean {
  return event.kind === 'approval' && !event.metadata?.resolvedAt
}

/**
 * The (loose) subset of `AgentTask` fields the Goal Detail screen renders,
 * as nested under `Goal.agentTasks` by `GET /workspaces/:id/goals/:goalId`.
 */
export interface AgentTaskSummary {
  id: string
  goalId?: string | null
  title: string
  status: string
  currentStep?: string | null
  resultSummary?: string | null
  errorMessage?: string | null
  createdAt: string
  updatedAt: string
}
