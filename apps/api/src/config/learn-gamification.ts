// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * learn.shogo.ai progress, XP, ranks, streaks and badges.
 *
 * XP ranks are for fun and momentum only. "Level" on Shogo Learn means a
 * Shogo Certified level (`learn-levels.ts`), which XP can never raise.
 *
 * Everything here is pure: the API feeds it the learner's rows
 * (`learn_lesson_completions`, `learn_badges`, Solo Founder enrollment
 * progress) and stores only the badges it says are newly earned. XP, level
 * and rank and streak are always recomputed, never stored, so rule changes apply to
 * everyone at once.
 */

/** Lesson ids per course, in order. Must match the learn site's content. */
export const LEARN_LESSONS: Readonly<Record<string, readonly string[]>> = {
  'agents-for-everyone': ['what-is-an-agent', 'good-at-bad-at', 'how-to-ask', 'first-agent', 'stay-safe', 'final-check'],
  'start-here': ['what-an-agent-is', 'shogo-words', 'first-app', 'review-loop', 'plan-first', 'save-data', 'share-it'],
  'ai-teammates': ['teammates-not-tools', 'where-to-talk', 'talking-to-agents', 'job-descriptions', 'delegation', 'humans-in-the-loop', 'routines'],
  'agent-team-playbook': ['team', 'roles', 'loop', 'review', 'lessons', 'reflect', 'cleanup', 'evals'],
  'first-client': ['the-offer', 'find-prospects', 'demo-in-a-day', 'show-dont-pitch', 'scope-and-price', 'deliver', 'apps-for-clients', 'keep-them'],
  'paid-app': ['day-1-pick', 'days-2-3-core-loop', 'days-4-5-data', 'days-6-7-payments', 'days-8-9-test', 'days-10-11-publish', 'days-12-13-stores', 'day-14-launch'],
  // Past Solo Founder buyers also have progress on their Studio course board (CourseEnrollment.progress).
  'solo-founder': ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'capstone'],
}

/** Courses whose lessons the learner marks complete on learn.shogo.ai. */
export const SELF_PACED_COURSES = Object.keys(LEARN_LESSONS)

/** Lessons a passed final check completes on its own. */
export const CERTIFICATE_LESSON: Readonly<Record<string, string>> = { 'agents-for-everyone': 'final-check' }

const FREE_COURSES = ['agents-for-everyone', 'start-here', 'ai-teammates'] as const

/** Badge art for the Shogo Certified levels. Titles must match `learn-levels.ts` (a test checks). */
const LEVEL_BADGES = [
  { level: 1, title: 'Explorer', hue: 155 },
  { level: 2, title: 'Builder', hue: 25 },
  { level: 3, title: 'Operator', hue: 250 },
  { level: 4, title: 'Professional', hue: 285 },
  { level: 5, title: 'Expert', hue: 45 },
  { level: 6, title: 'Architect', hue: 0 },
] as const
const FOUNDING_BEFORE = '2027-01-01'

export const XP = { lesson: 10, course: 50, badge: 20, certificate: 100 } as const

/** XP ranks. Named so none can be mistaken for a Shogo Certified level title. */
export const RANKS: ReadonlyArray<{ min: number; name: string }> = [
  { min: 0, name: 'Spark' },
  { min: 40, name: 'Ember' },
  { min: 120, name: 'Kindling' },
  { min: 250, name: 'Flame' },
  { min: 400, name: 'Blaze' },
  { min: 600, name: 'Bonfire' },
  { min: 850, name: 'Beacon' },
  { min: 1100, name: 'Supernova' },
]

export interface LearnBadgeDef {
  id: string
  name: string
  description: string
  /** Icon key the site draws (see the site's badge art). */
  icon: string
  /** Hue for the badge art. */
  hue: number
  xp: number
}

const COURSE_TITLES: Record<string, string> = {
  'agents-for-everyone': 'AI agents for everyone',
  'start-here': 'Start here',
  'ai-teammates': 'Work with AI teammates',
  'agent-team-playbook': 'Agent Team Playbook',
  'first-client': 'Land your first AI client',
  'paid-app': 'Ship a paid app in 14 days',
  'solo-founder': 'Solo Founder',
}
const COURSE_HUES: Record<string, number> = {
  'agents-for-everyone': 155, 'start-here': 25, 'ai-teammates': 285, 'agent-team-playbook': 250,
  'first-client': 70, 'paid-app': 340, 'solo-founder': 200,
}

export const LEARN_BADGES: readonly LearnBadgeDef[] = [
  { id: 'first-lesson', name: 'First step', description: 'Finished your first lesson.', icon: 'footprints', hue: 25, xp: XP.badge },
  { id: 'lessons-10', name: 'On a roll', description: 'Finished 10 lessons.', icon: 'flame', hue: 35, xp: XP.badge },
  { id: 'lessons-25', name: 'Deep in it', description: 'Finished 25 lessons.', icon: 'layers', hue: 280, xp: XP.badge },
  { id: 'lessons-all', name: 'Completionist', description: 'Finished every self-paced lesson on Shogo Learn.', icon: 'crown', hue: 75, xp: XP.badge },
  { id: 'streak-3', name: 'Three in a row', description: 'Learned on 3 days in a row.', icon: 'calendar', hue: 15, xp: XP.badge },
  { id: 'streak-7', name: 'Week streak', description: 'Learned on 7 days in a row.', icon: 'calendar', hue: 330, xp: XP.badge },
  { id: 'streak-30', name: 'Month streak', description: 'Learned on 30 days in a row.', icon: 'calendar', hue: 265, xp: XP.badge },
  ...Object.keys(LEARN_LESSONS).map((c) => ({
    id: `course-${c}`,
    name: `${COURSE_TITLES[c]} graduate`,
    description: `Finished every lesson of ${COURSE_TITLES[c]}.`,
    icon: 'graduation',
    hue: COURSE_HUES[c],
    xp: XP.badge,
  })),
  { id: 'certified-agents-for-everyone', name: 'Certified: AI agents for everyone', description: 'Passed the final check of AI agents for everyone.', icon: 'award', hue: 155, xp: XP.certificate },
  { id: 'foundations', name: 'Foundations', description: 'Finished AI agents for everyone, Start here and Work with AI teammates.', icon: 'blocks', hue: 200, xp: XP.badge },
  { id: 'founding-learner', name: 'Founding learner', description: 'Learning on Shogo Learn in its first months.', icon: 'sparkles', hue: 45, xp: XP.badge },
  ...LEVEL_BADGES.map((l) => ({
    id: `level-${l.level}`,
    name: `Shogo Certified ${l.title}`,
    description: `Earned Shogo Certified Level ${l.level}: ${l.title}.`,
    icon: 'award',
    hue: l.hue,
    xp: XP.certificate,
  })),
]

export function learnBadgeById(id: string): LearnBadgeDef | undefined {
  return LEARN_BADGES.find((b) => b.id === id)
}

export interface CompletionRow {
  courseId: string
  lessonId: string
  /** Learner's calendar day, YYYY-MM-DD. Absent for board-tracked lessons. */
  day?: string | null
}

export interface LearnStats {
  xp: number
  rank: { index: number; name: string; min: number; next: { name: string; min: number } | null }
  streak: { current: number; longest: number; activeToday: boolean }
  lessonsCompleted: number
  /** course id → completed lesson ids, in course order. */
  completedLessons: Record<string, string[]>
  coursesCompleted: string[]
}

/** A YYYY-MM-DD day in `tz` (IANA), falling back to UTC for a bad zone. */
export function learnerDay(at: Date, tz?: string | null): string {
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  try {
    return tz ? fmt(tz) : fmt('UTC')
  } catch {
    return fmt('UTC')
  }
}

function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000)
}

export function streakOf(days: Iterable<string>, today: string): LearnStats['streak'] {
  const nums = [...new Set([...days].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map(dayNumber))].sort((a, b) => a - b)
  let longest = 0
  let run = 0
  for (let i = 0; i < nums.length; i++) {
    run = i > 0 && nums[i] === nums[i - 1] + 1 ? run + 1 : 1
    longest = Math.max(longest, run)
  }
  const t = dayNumber(today)
  const set = new Set(nums)
  const activeToday = set.has(t)
  let current = 0
  for (let d = activeToday ? t : t - 1; set.has(d); d--) current++
  return { current, longest, activeToday }
}

export function rankFor(xp: number): LearnStats['rank'] {
  let index = 0
  for (let i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].min) index = i
  const next = RANKS[index + 1] ?? null
  return { index, name: RANKS[index].name, min: RANKS[index].min, next: next ? { name: next.name, min: next.min } : null }
}

export function computeLearnStats(input: {
  completions: readonly CompletionRow[]
  badgeIds: Iterable<string>
  today: string
}): LearnStats {
  const completedLessons: Record<string, string[]> = {}
  for (const [course, lessons] of Object.entries(LEARN_LESSONS)) {
    const done = new Set(input.completions.filter((c) => c.courseId === course).map((c) => c.lessonId))
    const ordered = lessons.filter((l) => done.has(l))
    if (ordered.length) completedLessons[course] = ordered
  }
  const lessonsCompleted = Object.values(completedLessons).reduce((n, l) => n + l.length, 0)
  const coursesCompleted = Object.keys(LEARN_LESSONS).filter((c) => (completedLessons[c]?.length ?? 0) === LEARN_LESSONS[c].length)
  const badgeXp = [...new Set(input.badgeIds)].reduce((n, id) => n + (learnBadgeById(id)?.xp ?? 0), 0)
  const xp = lessonsCompleted * XP.lesson + coursesCompleted.length * XP.course + badgeXp
  const streak = streakOf(
    input.completions.map((c) => c.day).filter((d): d is string => !!d),
    input.today,
  )
  return { xp, rank: rankFor(xp), streak, lessonsCompleted, completedLessons, coursesCompleted }
}

/**
 * Badges the learner qualifies for from their progress. `certified` lists
 * courses whose final check they passed. The caller awards the ones not held.
 */
export function qualifyingBadges(
  stats: LearnStats,
  opts: { certified?: Iterable<string>; firstActivityDay?: string | null; soloFounderBuyer?: boolean } = {},
): string[] {
  const out: string[] = []
  const selfPacedTotal = SELF_PACED_COURSES.reduce((n, c) => n + LEARN_LESSONS[c].length, 0)
  const selfPacedDone = SELF_PACED_COURSES.reduce((n, c) => n + (stats.completedLessons[c]?.length ?? 0), 0)
  if (stats.lessonsCompleted >= 1) out.push('first-lesson')
  if (stats.lessonsCompleted >= 10) out.push('lessons-10')
  if (stats.lessonsCompleted >= 25) out.push('lessons-25')
  if (selfPacedDone >= selfPacedTotal) out.push('lessons-all')
  if (stats.streak.longest >= 3) out.push('streak-3')
  if (stats.streak.longest >= 7) out.push('streak-7')
  if (stats.streak.longest >= 30) out.push('streak-30')
  for (const c of stats.coursesCompleted) out.push(`course-${c}`)
  const certified = [...(opts.certified ?? [])]
  for (const c of certified) if (learnBadgeById(`certified-${c}`)) out.push(`certified-${c}`)
  // Passing the final check of AI agents for everyone is Shogo Certified Level 1.
  if (certified.includes('agents-for-everyone')) out.push('level-1')
  if (FREE_COURSES.every((c) => stats.coursesCompleted.includes(c))) out.push('foundations')
  if (stats.lessonsCompleted >= 1 && opts.firstActivityDay && opts.firstActivityDay < FOUNDING_BEFORE) out.push('founding-learner')
  // Solo Founder bought the course before it was free: they keep the founding badge.
  if (opts.soloFounderBuyer) out.push('founding-learner')
  return out
}
