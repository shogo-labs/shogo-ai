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
 *
 * A `plan` course can also be sold on its own (`standalone`): a one-time
 * payment that unlocks that course for life, recorded as a `CourseEnrollment`
 * for `learnPurchaseCourseId(course)`. Either path opens it.
 */

import { PLAN_RANK, type PlanId } from './usage-plans'
import { SOLO_FOUNDER_COURSE_ID } from './solo-founder-course'

export type LearnAccessRule =
  | { kind: 'public' }
  | { kind: 'account' }
  | { kind: 'plan'; minPlan: Exclude<PlanId, 'free' | 'pro'>; standalone?: LearnStandaloneOffer }
  | { kind: 'purchase'; enrollmentCourseId: string; offer: string }

/** A one-time purchase of one course. The Stripe price is found by `lookupKey`. */
export interface LearnStandaloneOffer {
  courseId: string
  title: string
  priceUsd: number
  lookupKey: string
}

/** `CourseEnrollment.courseId` for a standalone purchase of a learn course. */
export function learnPurchaseCourseId(courseId: string): string {
  return `learn:${courseId}`
}

function standalone(courseId: string, title: string, priceUsd: number): LearnStandaloneOffer {
  return { courseId, title, priceUsd, lookupKey: `learn_course_${courseId.replace(/-/g, '_')}_v1` }
}

export interface LearnCourse {
  id: string
  access: LearnAccessRule
}

export const LEARN_COURSES: readonly LearnCourse[] = [
  { id: 'library', access: { kind: 'public' } },
  { id: 'agents-for-everyone', access: { kind: 'public' } },
  { id: 'start-here', access: { kind: 'account' } },
  { id: 'ai-teammates', access: { kind: 'account' } },
  // Standalone prices sit below a year of Basic ($78), which includes all three.
  {
    id: 'agent-team-playbook',
    access: { kind: 'plan', minPlan: 'basic', standalone: standalone('agent-team-playbook', 'Agent Team Playbook', 49) },
  },
  {
    id: 'first-client',
    access: { kind: 'plan', minPlan: 'basic', standalone: standalone('first-client', 'Land your first AI client', 49) },
  },
  {
    id: 'paid-app',
    access: { kind: 'plan', minPlan: 'basic', standalone: standalone('paid-app', 'Ship a paid app in 14 days', 49) },
  },
  {
    id: 'solo-founder',
    access: { kind: 'purchase', enrollmentCourseId: SOLO_FOUNDER_COURSE_ID, offer: 'solo_founder' },
  },
]

/**
 * Courses that end in a graded check and award a certificate. The questions
 * and options are public (they ship with the learn site); the answer key lives
 * only here, so a pass is decided by the API.
 */
export interface LearnCertificateRule {
  courseTitle: string
  passMark: number
  answers: Record<string, string>
}

export const LEARN_CERTIFICATES: Record<string, LearnCertificateRule> = {
  'agents-for-everyone': {
    courseTitle: 'AI agents for everyone',
    passMark: 5,
    answers: { q1: 'b', q2: 'c', q3: 'b', q4: 'c', q5: 'd', q6: 'b' },
  },
}

export function gradeLearnCheck(
  rule: LearnCertificateRule,
  given: Record<string, unknown>,
): { score: number; total: number; wrong: string[]; passed: boolean } {
  const ids = Object.keys(rule.answers)
  const wrong = ids.filter((id) => given[id] !== rule.answers[id])
  const score = ids.length - wrong.length
  return { score, total: ids.length, wrong, passed: score >= rule.passMark }
}

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
  /** When the course can also be bought on its own: its one-time price. */
  standalone?: { priceUsd: number }
}

export function decideLearnAccess(
  rule: LearnAccessRule,
  learner: { signedIn: boolean; planId: PlanId; enrolledCourseIds: ReadonlySet<string> },
): LearnAccessDecision {
  if (rule.kind === 'public') return { hasAccess: true, reason: 'public' }
  const buyable = rule.kind === 'plan' && rule.standalone ? { standalone: { priceUsd: rule.standalone.priceUsd } } : {}
  if (!learner.signedIn) {
    return {
      hasAccess: false,
      reason: 'signed_out',
      ...(rule.kind === 'plan' ? { requiredPlan: rule.minPlan, ...buyable } : {}),
      ...(rule.kind === 'purchase' ? { offer: rule.offer } : {}),
    }
  }
  switch (rule.kind) {
    case 'account':
      return { hasAccess: true, reason: 'account' }
    case 'plan':
      if (PLAN_RANK[learner.planId] >= PLAN_RANK[rule.minPlan]) return { hasAccess: true, reason: 'plan' }
      if (rule.standalone && learner.enrolledCourseIds.has(learnPurchaseCourseId(rule.standalone.courseId))) {
        return { hasAccess: true, reason: 'purchased' }
      }
      return { hasAccess: false, reason: 'plan_required', requiredPlan: rule.minPlan, ...buyable }
    case 'purchase':
      return learner.enrolledCourseIds.has(rule.enrollmentCourseId)
        ? { hasAccess: true, reason: 'purchased' }
        : { hasAccess: false, reason: 'purchase_required', offer: rule.offer }
  }
}
