// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * learn.shogo.ai course access rules.
 *
 * The site holds the lessons; this file holds who may open them. The site never
 * decides access itself: its server functions ask `/api/learn/me` and only
 * serve a gated lesson when this catalog says the learner has it.
 *
 * Access kinds:
 *  - `public`   anyone, signed in or not
 *  - `account`  any Shogo account, including Free
 *  - `plan`     the learner's best plan across their workspaces is at least
 *               `minPlan` (by `PLAN_RANK`, so a legacy Pro seat counts as Basic+
 *               without Pro being named anywhere)
 *  - `purchase` an active `CourseEnrollment` for `enrollmentCourseId`, in any
 *               workspace the learner belongs to. Plan does not matter.
 */

import { PLAN_RANK, type PlanId } from './usage-plans'
import { SOLO_FOUNDER_COURSE_ID } from './solo-founder-course'

export type LearnAccessRule =
  | { kind: 'public' }
  | { kind: 'account' }
  | { kind: 'plan'; minPlan: Exclude<PlanId, 'free' | 'pro'> }
  | { kind: 'purchase'; enrollmentCourseId: string; offer: string }

export interface LearnCourse {
  id: string
  access: LearnAccessRule
}

export const LEARN_COURSES: readonly LearnCourse[] = [
  { id: 'library', access: { kind: 'public' } },
  { id: 'start-here', access: { kind: 'account' } },
  { id: 'ai-teammates', access: { kind: 'account' } },
  { id: 'agent-team-playbook', access: { kind: 'plan', minPlan: 'basic' } },
  {
    id: 'solo-founder',
    access: { kind: 'purchase', enrollmentCourseId: SOLO_FOUNDER_COURSE_ID, offer: 'solo_founder' },
  },
]

export function learnCourseById(id: string): LearnCourse | undefined {
  return LEARN_COURSES.find((c) => c.id === id)
}

/** Coach replies per learner per UTC day, by plan. Purchases ride on the plan they include. */
export const LEARN_COACH_DAILY_LIMIT: Record<PlanId, number> = {
  free: 10,
  basic: 40,
  pro: 40,
  business: 100,
  enterprise: 200,
}

export type LearnAccessReason = 'public' | 'signed_out' | 'account' | 'plan' | 'plan_required' | 'purchased' | 'purchase_required'

export interface LearnAccessDecision {
  hasAccess: boolean
  reason: LearnAccessReason
  /** For `plan_required`: the plan that unlocks it. */
  requiredPlan?: string
  /** For `purchase_required`: the checkout offer that unlocks it. */
  offer?: string
}

export function decideLearnAccess(
  rule: LearnAccessRule,
  learner: { signedIn: boolean; planId: PlanId; enrolledCourseIds: ReadonlySet<string> },
): LearnAccessDecision {
  if (rule.kind === 'public') return { hasAccess: true, reason: 'public' }
  if (!learner.signedIn) {
    return {
      hasAccess: false,
      reason: 'signed_out',
      ...(rule.kind === 'plan' ? { requiredPlan: rule.minPlan } : {}),
      ...(rule.kind === 'purchase' ? { offer: rule.offer } : {}),
    }
  }
  switch (rule.kind) {
    case 'account':
      return { hasAccess: true, reason: 'account' }
    case 'plan':
      return PLAN_RANK[learner.planId] >= PLAN_RANK[rule.minPlan]
        ? { hasAccess: true, reason: 'plan' }
        : { hasAccess: false, reason: 'plan_required', requiredPlan: rule.minPlan }
    case 'purchase':
      return learner.enrolledCourseIds.has(rule.enrollmentCourseId)
        ? { hasAccess: true, reason: 'purchased' }
        : { hasAccess: false, reason: 'purchase_required', offer: rule.offer }
  }
}
