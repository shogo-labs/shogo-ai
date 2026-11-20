// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Solo Founder course (SHO-428): one entry per lesson card.
 *
 * This file is the single source for a lesson's title, description, the
 * expected output and the machine check that proves it. `enroll()` creates the
 * cards from `COURSE_LESSONS`; the Course board gate in
 * `work-boards.service.ts` evaluates the card's `check` field against live
 * workspace state, so neither the Coach nor the person can close a lesson by
 * saying they did.
 *
 * Ordering is the course order: Module 0 (install), Modules 1–10, the Capstone.
 * The spec's "10 modules" do not count Module 0 (Sales Funnel Strategy
 * `research/19-solo-founder-99-offer.md` §5).
 */

export const SOLO_FOUNDER_COURSE_ID = 'solo-founder-v1'

/** Board template the course board is created from. The gate keys off it. */
export const SOLO_FOUNDER_COURSE_BOARD_TEMPLATE = 'solo-founder-course'

/** Channel the course lives in. Not in the public department catalogue. */
export const SOLO_FOUNDER_COURSE_CHANNEL = 'course'

export type LessonCheck =
  /** The Solo Founder OS channels exist (Module 0). */
  | { kind: 'os_installed' }
  /** A workspace project has `publishedAt` set. */
  | { kind: 'project_published' }
  /** A board has at least `count` cards. `board` is the board name in its channel. */
  | { kind: 'board_cards'; board: string; count: number }
  /** At least `count` enabled schedules the pack did not create itself. */
  | { kind: 'schedules_enabled'; count: number }
  /** Nothing machine-checkable: the Coach reads the output and decides. */
  | { kind: 'none' }

export interface CourseLesson {
  /** Stable id, recorded in `CourseEnrollment.progress.completedLessons`. */
  id: string
  /** Module number; 0 is the install lesson, 11 the Capstone. */
  module: number
  title: string
  /** What the card says: the outcome, in the person's words. */
  description: string
  /** The one prompt to copy, or the template to install. */
  prompt: string
  /** What must exist in the workspace before the card may move to Done. */
  output: string
  check: LessonCheck
  /** Which column the card is created in. Module 0 starts in `This week`. */
  startsIn: 'this_week' | 'up_next'
  /** Hosted video, when there is one. Filled in later; the card shows the prompt regardless. */
  videoUrl?: string
}

/** The course's module-zero output: the 5 channels of the Solo Founder OS. */
export const SOLO_FOUNDER_OS_CHANNELS = ['build', 'marketing', 'sales', 'support', 'ops'] as const

/**
 * `check` as it is stored on the card and read back by the gate. One string,
 * so board fields stay simple and a lesson can be edited without a migration.
 */
export function encodeLessonCheck(check: LessonCheck): string {
  switch (check.kind) {
    case 'os_installed':
      return 'os_installed'
    case 'project_published':
      return 'project_published'
    case 'board_cards':
      return `board_cards:${check.board}:${check.count}`
    case 'schedules_enabled':
      return `schedules_enabled:${check.count}`
    case 'none':
      return 'none'
  }
}

/** Parse a card's `check` field back into a check. Unknown keys are `none`. */
export function decodeLessonCheck(raw: unknown): LessonCheck {
  const value = String(raw ?? '').trim()
  if (value === 'os_installed') return { kind: 'os_installed' }
  if (value === 'project_published') return { kind: 'project_published' }
  const boardCards = value.match(/^board_cards:([a-z0-9_-]+):(\d+)$/i)
  if (boardCards) return { kind: 'board_cards', board: boardCards[1], count: Number(boardCards[2]) }
  const schedules = value.match(/^schedules_enabled:(\d+)$/)
  if (schedules) return { kind: 'schedules_enabled', count: Number(schedules[1]) }
  return { kind: 'none' }
}

export const COURSE_LESSONS: readonly CourseLesson[] = [
  {
    id: 'm0',
    module: 0,
    title: 'Install your company',
    description: 'Install your company: five channels, one board and one agent each, all on the economy model. Watch the videos in #course.',
    prompt: 'Read MEMORY.md. Our ICP is: <who, specifically>. Our offer is: <what, for how much>. Our voice is: <three adjectives>. Rewrite MEMORY.md with those three sections, keep everything else, and tell me which model each of my agents is on.',
    output: 'Company brief saved in the #ops doc; your five channels are ready.',
    check: { kind: 'os_installed' },
    startsIn: 'this_week',
  },
  {
    id: 'm1',
    module: 1,
    title: 'Ship your landing page',
    description: 'Ship a landing page with a waitlist form you own. Watch the videos in #course.',
    prompt: 'Build a landing page for <product>: hero with the promise, three benefits, a waitlist form that emails me every signup, and a FAQ. Then publish it and give me the URL.',
    output: 'A published site with a working waitlist form.',
    check: { kind: 'project_published' },
    startsIn: 'up_next',
  },
  {
    id: 'm2',
    module: 2,
    title: 'Build the product',
    description: 'The first version that saves data, has sign-in and takes a test payment. Watch the videos in #course.',
    prompt: 'Turn the landing page into an app: sign-up, one record type with a database, and a Stripe checkout for <price>. Show me a preview link when it runs.',
    output: 'A first version that saves data, has sign-in and takes a test payment. Evidence: preview link + a test payment.',
    check: { kind: 'none' },
    startsIn: 'up_next',
  },
  {
    id: 'm3',
    module: 3,
    title: 'Your build team',
    description: 'One feature from Ideas to Shipped, with the plan and the tests in its thread. Watch the videos in #course.',
    prompt: 'Create one card for <the next feature>: a planner writes the plan and acceptance criteria, a developer implements it on a branch and opens a PR, QA tests it. Hand it off and tell me when it is ready for my review.',
    output: 'One feature taken from Ideas to Shipped on the Build board, with the plan, the test checklist and your approval in its thread.',
    check: { kind: 'none' },
    startsIn: 'up_next',
  },
  {
    id: 'm4',
    module: 4,
    title: 'Your marketing engine',
    description: 'Five posts on the Content board, one of them published by you. Watch the videos in #course.',
    prompt: 'Research what <ICP> is struggling with this week, draft 5 posts for <channel> in our voice, and put them on the Content board. Do not publish anything until I say so.',
    output: '5 posts on the Content board, at least 1 published by you.',
    check: { kind: 'board_cards', board: 'Content', count: 5 },
    startsIn: 'up_next',
  },
  {
    id: 'm5',
    module: 5,
    title: 'Get found',
    description: 'A published guide, a keyword reply routine, and one page written for search. Watch the videos in #course.',
    prompt: 'Set up a comment-keyword automation on <platform> for the word <KEYWORD>: reply with a DM that links my guide page, and write the guide page if it does not exist.',
    output: 'A published free guide, a keyword reply routine, and one page written for search. Evidence: both links.',
    check: { kind: 'none' },
    startsIn: 'up_next',
  },
  {
    id: 'm6',
    module: 6,
    title: 'Ads without an agency',
    description: 'Six ad hooks, three in Building, and your ad rules written down. Watch the videos in #course.',
    prompt: 'Write 6 ad hooks for <product> from the proof on our Content board, put them on the Campaigns board with the kill rule I should use, and move the three strongest to Testing. Do not spend anything without my approval.',
    output: '6 ad hooks on Campaigns, 3 in Building, and your ad rules in the #marketing doc.',
    check: { kind: 'board_cards', board: 'Campaigns', count: 6 },
    startsIn: 'up_next',
  },
  {
    id: 'm7',
    module: 7,
    title: 'Sell',
    description: 'Ten real leads on Pipeline, each with a next step and a date. Watch the videos in #course.',
    prompt: 'Find 10 leads that match our ICP in <source>, put each on the Pipeline board with where they are and what they need, and book a follow-up for Tuesday for every one of them.',
    output: '10 real leads on Pipeline, each with a next step and a date.',
    check: { kind: 'board_cards', board: 'Pipeline', count: 10 },
    startsIn: 'up_next',
  },
  {
    id: 'm8',
    module: 8,
    title: 'Support desk in an afternoon',
    description: 'Your inbox connected and one ticket answered with a reply you approved. Watch the videos in #course.',
    prompt: 'Connect support@ to my Tickets board, write the reply for the first ticket that arrives, and wait for my approval before sending anything.',
    output: 'Your inbox connected; at least 1 ticket on Tickets with a reply you approved.',
    check: { kind: 'board_cards', board: 'Tickets', count: 1 },
    startsIn: 'up_next',
  },
  {
    id: 'm9',
    module: 9,
    title: 'Run it while you sleep',
    description: 'Three routines of your own: morning digest, weekly numbers, weekly review. Watch the videos in #course.',
    prompt: 'Set up three schedules: a 07:00 morning digest of what shipped and what needs me, a Friday revenue report, and a Sunday weekly retro. Use my timezone and post them to #ops.',
    output: '3 routines running: morning digest, weekly numbers, weekly review.',
    check: { kind: 'schedules_enabled', count: 3 },
    startsIn: 'up_next',
  },
  {
    id: 'm10',
    module: 10,
    title: 'Trust but verify',
    description: 'One approval rule, the honesty checklist, and your usage cap confirmed. Watch the videos in #course.',
    prompt: 'Put an approval gate on every write to <the thing I cannot afford to get wrong>, set the monthly spend limit to $<amount>, and show me which agents can act alone and which must ask.',
    output: 'One approval rule, the honesty checklist in your agents\' rules, and your usage cap confirmed. Evidence: one agent reply ending with the checklist.',
    check: { kind: 'none' },
    startsIn: 'up_next',
  },
  {
    id: 'capstone',
    module: 11,
    title: 'Launch week',
    description: 'Launched publicly, payments live, and your showcase page published. Watch the videos in #course.',
    prompt: 'Plan my launch week: what to publish, what to post, who to contact, in which order, with a checklist for every day. Then start on day 1.',
    output: 'Launched publicly, payments live, and your showcase page published.',
    check: { kind: 'project_published' },
    startsIn: 'up_next',
  },
]

/** The column names of the course board, in order. */
export const COURSE_BOARD_COLUMNS = [
  { name: 'Up next', category: 'backlog' as const },
  { name: 'This week', category: 'active' as const },
  { name: 'Checking', category: 'waiting' as const, agent: 'coach' as const },
  { name: 'Done', category: 'done' as const },
  { name: 'Skipped', category: 'dismissed' as const },
]

/** The lesson card the Coach starts the person on. */
export const FIRST_LESSON_ID = COURSE_LESSONS[0].id

export function lessonById(id: string): CourseLesson | undefined {
  return COURSE_LESSONS.find((l) => l.id === id)
}
