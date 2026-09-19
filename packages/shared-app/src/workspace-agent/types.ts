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

export interface Goal {
  id: string
  workspaceId: string
  title: string
  why: string | null
  status: GoalStatus
  plan: unknown
  deliverables: unknown
  nextCheckInAt: string | null
  lastProgressAt: string | null
  createdAt: string
  updatedAt: string
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
  createdAt: string
  updatedAt?: string
  completedAt?: string | null
}
