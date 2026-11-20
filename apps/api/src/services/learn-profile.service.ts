// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person's Shogo Learn summary (level, XP, streak, badges) for the places
 * Shogo shows people: the workspace profile card and the public creator
 * profile. Read-only: badges are only ever awarded by the /api/learn routes.
 * Uses the same rules as learn.shogo.ai, so the numbers match the site.
 */
import { prisma } from '../lib/prisma'
import { LEARN_BADGES, computeLearnStats, learnBadgeById, learnerDay, type CompletionRow } from '../config/learn-gamification'
import { LEARN_COURSES } from '../config/learn-catalog'

export const LEARN_SITE_URL = 'https://learn.shogo.ai'
const SHOWN_BADGES = 8

export interface LearnProfileSummary {
  xp: number
  level: { index: number; name: string; next: { name: string; min: number } | null; min: number }
  streak: { current: number; longest: number }
  lessonsCompleted: number
  coursesCompleted: number
  badgeCount: number
  badgeTotal: number
  /** Most recent first, capped. */
  badges: Array<{ id: string; name: string; description: string; icon: string; hue: number; earnedAt: string }>
  url: string
}

export interface LearnProfileDb {
  learnLessonCompletion: { findMany: (args: any) => Promise<Array<{ courseId: string; lessonId: string; day: string }>> }
  learnBadge: { findMany: (args: any) => Promise<Array<{ badgeId: string; earnedAt: Date }>> }
  courseEnrollment: { findMany: (args: any) => Promise<Array<{ progress: unknown }>> }
}

/** Null when the person has not started learning: callers then show nothing. */
export async function loadLearnProfile(
  userId: string,
  opts: { tz?: string | null; now?: number; db?: LearnProfileDb } = {},
): Promise<LearnProfileSummary | null> {
  const db = (opts.db ?? prisma) as LearnProfileDb
  const solo = LEARN_COURSES.find((c) => c.id === 'solo-founder')
  const soloEnrollmentId = solo?.access.kind === 'purchase' ? solo.access.enrollmentCourseId : null
  const [rows, badges, enrollments] = await Promise.all([
    db.learnLessonCompletion.findMany({ where: { userId }, select: { courseId: true, lessonId: true, day: true } }),
    db.learnBadge.findMany({ where: { userId }, select: { badgeId: true, earnedAt: true }, orderBy: { earnedAt: 'desc' } }),
    soloEnrollmentId
      ? db.courseEnrollment.findMany({ where: { userId, courseId: soloEnrollmentId, status: 'active' }, select: { progress: true } })
      : Promise.resolve([]),
  ])
  const completions: CompletionRow[] = rows.map((r) => ({ courseId: r.courseId, lessonId: r.lessonId, day: r.day }))
  for (const e of enrollments) {
    const list = (e.progress as { completedLessons?: unknown } | null)?.completedLessons
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') completions.push({ courseId: 'solo-founder', lessonId: id })
  }
  const known = badges.filter((b) => learnBadgeById(b.badgeId))
  if (!completions.length && !known.length) return null
  const stats = computeLearnStats({
    completions,
    badgeIds: known.map((b) => b.badgeId),
    today: learnerDay(new Date(opts.now ?? Date.now()), opts.tz),
  })
  return {
    xp: stats.xp,
    level: stats.level,
    streak: { current: stats.streak.current, longest: stats.streak.longest },
    lessonsCompleted: stats.lessonsCompleted,
    coursesCompleted: stats.coursesCompleted.length,
    badgeCount: known.length,
    badgeTotal: LEARN_BADGES.length,
    badges: known.slice(0, SHOWN_BADGES).map((b) => {
      const def = learnBadgeById(b.badgeId)!
      return { id: def.id, name: def.name, description: def.description, icon: def.icon, hue: def.hue, earnedAt: b.earnedAt.toISOString() }
    }),
    url: LEARN_SITE_URL,
  }
}
