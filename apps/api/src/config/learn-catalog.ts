// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * learn.shogo.ai course access rules.
 *
 * The site holds the lessons; this file holds who may open them. The site never
 * decides access itself: its server functions ask `/api/learn/me` and only
 * serve a gated lesson when this catalog says the learner has it.
 *
 * Every course is free. Access is earned, not bought (see `learn-levels.ts`):
 *  - `public`  anyone, signed in or not
 *  - `level`   a signed-in learner holding Shogo Certified level `requires`
 *              or higher (level 0 = any Shogo account)
 * Inside a course, lessons open in order: the next lesson opens when the one
 * before it is finished (`unlockedLessons`). The first lesson of every course
 * is a public preview on the site.
 */

import type { PlanId } from './usage-plans'
import { SOLO_FOUNDER_COURSE_ID } from './solo-founder-course'
import { LEARN_LESSONS } from './learn-gamification'
import { courseLevel } from './learn-levels'

export type LearnAccessRule = { kind: 'public' } | { kind: 'level'; requires: number }

export interface LearnCourse {
  id: string
  access: LearnAccessRule
}

/** A course on level N's track needs level N − 1. */
function track(id: string): LearnCourse {
  const level = courseLevel(id)
  return { id, access: level <= 1 ? { kind: 'public' } : { kind: 'level', requires: level - 1 } }
}

export const LEARN_COURSES: readonly LearnCourse[] = [
  { id: 'library', access: { kind: 'public' } },
  track('agents-for-everyone'),
  track('start-here'),
  track('ai-teammates'),
  track('agent-team-playbook'),
  track('paid-app'),
  track('first-client'),
  track('solo-founder'),
]

/**
 * Solo Founder's Studio offer (a discounted Business year with a course board)
 * records a `CourseEnrollment` with this id. The lessons no longer need it; its
 * board progress still counts, and past buyers keep a perk.
 */
export const SOLO_FOUNDER_ENROLLMENT_ID = SOLO_FOUNDER_COURSE_ID

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

/** Coach replies per learner per UTC day, by plan. */
export const LEARN_COACH_DAILY_LIMIT: Record<PlanId, number> = {
  free: 10,
  basic: 40,
  pro: 40,
  business: 100,
  enterprise: 200,
}

export type LearnAccessReason = 'public' | 'signed_out' | 'level' | 'level_required'

export interface LearnAccessDecision {
  hasAccess: boolean
  reason: LearnAccessReason
  /** The Shogo Certified level that opens it (for `signed_out` and `level_required`). */
  requiredLevel?: number
}

export function decideLearnAccess(rule: LearnAccessRule, learner: { signedIn: boolean; level: number }): LearnAccessDecision {
  if (rule.kind === 'public') return { hasAccess: true, reason: 'public' }
  if (!learner.signedIn) return { hasAccess: false, reason: 'signed_out', requiredLevel: rule.requires }
  return learner.level >= rule.requires
    ? { hasAccess: true, reason: 'level' }
    : { hasAccess: false, reason: 'level_required', requiredLevel: rule.requires }
}

/**
 * Lessons the learner may open in a course they have access to: everything they
 * finished, plus the first lesson they haven't. The first lesson is always open.
 */
export function unlockedLessons(courseId: string, completed: readonly string[]): string[] {
  const lessons = LEARN_LESSONS[courseId] ?? []
  const done = new Set(completed)
  const out: string[] = []
  let nextOpen = false
  for (const lesson of lessons) {
    if (done.has(lesson)) out.push(lesson)
    else if (!nextOpen) {
      out.push(lesson)
      nextOpen = true
    }
  }
  return out
}
