// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Certified: the level ladder on learn.shogo.ai.
 *
 * Every lesson is free. A course opens when the learner holds the level below
 * it, and a level is only ever earned by meeting its requirements: finished
 * lessons plus evidence read from the learner's own Shogo workspaces. XP never
 * raises a level (XP has its own ranks in `learn-gamification.ts`).
 *
 * A held level is stored as a `learn_badges` row (`level-<n>`), so it shows
 * with the learner's other badges and needs no table of its own.
 *
 * Levels 4–6 are judged by people (portfolio review, proctored build, review
 * board) and are not claimable here yet: `claimable: false`.
 */

import { LEARN_LESSONS } from './learn-gamification'

export type LevelAssessment = 'check' | 'build' | 'operate' | 'portfolio' | 'proctored' | 'board'

export interface LearnLevel {
  level: number
  /** "Explorer": shown as "Shogo Certified Explorer". */
  title: string
  /** One line: what holding it proves. */
  proves: string
  assessment: LevelAssessment
  /** Courses whose lessons this level's track is made of. Their access needs `level - 1`. */
  courses: readonly string[]
  /** Claimable on learn.shogo.ai today. Human-judged levels open later. */
  claimable: boolean
  /** Exam fee in USD, for the human-judged levels that charge one. */
  feeUsd?: number
  /** Years a level stays current before it must be renewed. */
  renewYears?: number
}

export const LEARN_LEVELS: readonly LearnLevel[] = [
  {
    level: 1,
    title: 'Explorer',
    proves: 'Knows what AI agents are, how to ask them for work, and how to stay safe.',
    assessment: 'check',
    courses: ['agents-for-everyone'],
    claimable: true,
  },
  {
    level: 2,
    title: 'Builder',
    proves: 'Has built and published a working app with Shogo, and works with AI teammates.',
    assessment: 'build',
    courses: ['start-here', 'ai-teammates'],
    claimable: true,
  },
  {
    level: 3,
    title: 'Operator',
    proves: 'Runs a team of AI agents on a board: roles, hand-offs, reviews, finished work.',
    assessment: 'operate',
    courses: ['agent-team-playbook'],
    claimable: true,
  },
  {
    level: 4,
    title: 'Professional',
    proves: 'Has shipped real work for real people: paying users or a delivered client project.',
    assessment: 'portfolio',
    courses: ['paid-app', 'first-client', 'solo-founder'],
    claimable: false,
  },
  {
    level: 5,
    title: 'Expert',
    proves: 'Designs and delivers an agent system under exam conditions, unaided, judged by people.',
    assessment: 'proctored',
    courses: [],
    claimable: false,
    feeUsd: 299,
    renewYears: 2,
  },
  {
    level: 6,
    title: 'Architect',
    proves: 'Runs production agent systems that companies depend on, defended before a review board.',
    assessment: 'board',
    courses: [],
    claimable: false,
    feeUsd: 499,
    renewYears: 2,
  },
]

export const MAX_LEARN_LEVEL = LEARN_LEVELS.length

/** Level 3 evidence: cards finished by agents, and how many different agents. */
export const OPERATOR_MIN_AGENT_CARDS = 5
export const OPERATOR_MIN_AGENTS = 2

export function learnLevel(n: number): LearnLevel | undefined {
  return LEARN_LEVELS.find((l) => l.level === n)
}

export function levelBadgeId(n: number): string {
  return `level-${n}`
}

/** The level whose track a course belongs to, or 0 for courses outside the ladder. */
export function courseLevel(courseId: string): number {
  return LEARN_LEVELS.find((l) => l.courses.includes(courseId))?.level ?? 0
}

/** Highest level held without a gap: level-3 counts only if level-1 and level-2 are held too. */
export function heldLevel(badgeIds: Iterable<string>): number {
  const held = new Set(badgeIds)
  let n = 0
  while (n < MAX_LEARN_LEVEL && held.has(levelBadgeId(n + 1))) n++
  return n
}

/** `level-<n>` certificate ids ride on the course certificate format. */
export function levelCertificateCourseId(n: number): string {
  return `level-${n}`
}

export function levelFromCertificateCourseId(courseId: string): LearnLevel | undefined {
  const m = /^level-(\d)$/.exec(courseId)
  return m ? learnLevel(Number(m[1])) : undefined
}

export interface LevelEvidence {
  /** Projects the learner created, in their workspaces, that are published. */
  publishedApps: number
  /** Cards an agent finished, created by the learner or on a board they created. */
  agentCardsDone: number
  /** Distinct agents across those cards. */
  agentsWithDoneCards: number
}

export interface LevelRequirement {
  id: string
  label: string
  ok: boolean
  /** Progress, e.g. "3 of 5". */
  detail?: string
}

/**
 * What a learner still needs for `level`. Level 1 is earned by passing the
 * graded final check, so its claim always goes through `/certificate`.
 */
export function levelRequirements(
  level: number,
  input: { heldLevel: number; completedLessons: Record<string, readonly string[]>; evidence?: LevelEvidence | null },
): LevelRequirement[] {
  const def = learnLevel(level)
  if (!def) return []
  const out: LevelRequirement[] = []
  if (level > 1) {
    const prev = learnLevel(level - 1)!
    out.push({ id: 'previous-level', label: `Hold Level ${level - 1} (${prev.title})`, ok: input.heldLevel >= level - 1 })
  }
  for (const course of def.courses) {
    const lessons = LEARN_LESSONS[course] ?? []
    const done = lessons.filter((l) => input.completedLessons[course]?.includes(l)).length
    out.push({ id: `course-${course}`, label: `Finish every lesson of ${courseTitleFor(course)}`, ok: lessons.length > 0 && done === lessons.length, detail: `${done} of ${lessons.length}` })
  }
  const ev = input.evidence
  if (def.assessment === 'check') {
    out.push({ id: 'final-check', label: 'Pass the graded final check', ok: input.heldLevel >= 1 })
  } else if (def.assessment === 'build') {
    const n = ev?.publishedApps ?? 0
    out.push({ id: 'published-app', label: 'Publish an app you built in your Shogo workspace', ok: n >= 1, detail: ev ? `${n} published` : undefined })
  } else if (def.assessment === 'operate') {
    const cards = ev?.agentCardsDone ?? 0
    const agents = ev?.agentsWithDoneCards ?? 0
    out.push({
      id: 'agent-cards',
      label: `Have AI agents finish ${OPERATOR_MIN_AGENT_CARDS} cards you put on a board`,
      ok: cards >= OPERATOR_MIN_AGENT_CARDS,
      detail: ev ? `${Math.min(cards, OPERATOR_MIN_AGENT_CARDS)} of ${OPERATOR_MIN_AGENT_CARDS}` : undefined,
    })
    out.push({
      id: 'agent-team',
      label: `With at least ${OPERATOR_MIN_AGENTS} different agents doing the work`,
      ok: agents >= OPERATOR_MIN_AGENTS,
      detail: ev ? `${Math.min(agents, OPERATOR_MIN_AGENTS)} of ${OPERATOR_MIN_AGENTS}` : undefined,
    })
  } else {
    out.push({ id: 'review', label: 'Reviewed by the Shogo certification team (opens in 2027)', ok: false })
  }
  return out
}

const TRACK_TITLES: Record<string, string> = {
  'agents-for-everyone': 'AI agents for everyone',
  'start-here': 'Start here',
  'ai-teammates': 'Work with AI teammates',
  'agent-team-playbook': 'Agent Team Playbook',
  'first-client': 'Land your first AI client',
  'paid-app': 'Ship a paid app in 14 days',
  'solo-founder': 'Solo Founder',
}

function courseTitleFor(id: string): string {
  return TRACK_TITLES[id] ?? id
}
