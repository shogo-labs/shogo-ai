// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Solo Founder course gate (SHO-428).
 *
 * A lesson card on the Course board may only reach a done-category column when
 * the workspace itself shows the lesson's output. The check is evaluated here,
 * server-side, for agents and people alike — the Coach's `AGENTS.md` says "try
 * the move", and the move is what refuses. That is the Waiver Ledger lesson:
 * an agent that grades its own homework grades itself an A.
 *
 * This module deliberately depends on nothing but `prisma` and the course
 * config, because `work-boards.service` (the move) and
 * `solo-founder.service` (the install) both use it and importing either from
 * the other would cycle.
 */

import { prisma } from '../lib/prisma'
import {
  SOLO_FOUNDER_COURSE_BOARD_TEMPLATE,
  SOLO_FOUNDER_COURSE_ID,
  SOLO_FOUNDER_OS_CHANNELS,
  decodeLessonCheck,
  lessonById,
} from '../config/solo-founder-course'

export interface LessonCheckResult {
  ok: boolean
  /** Plain-language reason, shown to the person moving the card. */
  message: string
}

export type Tick = (label: string, ok: boolean, detail?: string) => void

function pass(message: string): LessonCheckResult {
  return { ok: true, message }
}

function fail(message: string): LessonCheckResult {
  return { ok: false, message }
}

/** The five OS channels, in one query. */
async function osChannelsPresent(workspaceId: string): Promise<string[]> {
  const channels = await prisma.conversation.findMany({
    where: {
      workspaceId,
      archivedAt: null,
      name: { in: [...SOLO_FOUNDER_OS_CHANNELS] },
    },
    select: { name: true },
  })
  const found = new Set(channels.map((c) => String(c.name)))
  return [...found]
}

/** Enabled schedules the course install did not create itself. */
export async function countOwnSchedules(workspaceId: string, packScheduleIds: string[]): Promise<number> {
  const schedules = await prisma.agentSchedule.findMany({
    where: { workspaceId, enabled: true },
    select: { id: true },
  })
  const created = new Set(packScheduleIds)
  return schedules.filter((s) => !created.has(s.id)).length
}

/**
 * The schedule ids the course install owns: its `packBindings.schedules` plus
 * the Coach's own schedule. A replayed install keeps the same ids, so a count
 * taken later still excludes exactly what the pack made.
 */
export async function packScheduleIdsForWorkspace(workspaceId: string): Promise<string[]> {
  const enrollment = await prisma.courseEnrollment.findFirst({
    where: { workspaceId, courseId: SOLO_FOUNDER_COURSE_ID },
    select: { packBindings: true },
  })
  const bindings = (enrollment?.packBindings ?? null) as { schedules?: Record<string, string> } | null
  return Object.values(bindings?.schedules ?? {}).filter((id): id is string => !!id)
}

/**
 * Evaluate one lesson's check against the workspace. Never throws for a check
 * that simply is not met — a not-yet-built workspace is the normal state.
 */
export async function evaluateLessonCheck(workspaceId: string, rawCheck: unknown): Promise<LessonCheckResult> {
  const check = decodeLessonCheck(rawCheck)
  switch (check.kind) {
    case 'os_installed': {
      const found = await osChannelsPresent(workspaceId)
      if (found.length >= SOLO_FOUNDER_OS_CHANNELS.length) {
        return pass('The five Solo Founder OS channels are in your workspace.')
      }
      const missing = SOLO_FOUNDER_OS_CHANNELS.filter((c) => !found.includes(c))
      return fail(
        `The Solo Founder OS is not installed yet: ${missing.map((c) => `#${c}`).join(', ')} missing. Ask the Coach to install it, then move this card again.`,
      )
    }
    case 'project_published': {
      const published = await prisma.project.findFirst({
        where: { workspaceId, publishedAt: { not: null } },
        select: { name: true },
      })
      if (published) return pass(`${published.name} is published.`)
      return fail('No published project yet. Publish your site, then move this card again.')
    }
    case 'board_cards': {
      const boards = await prisma.board.findMany({
        where: { workspaceId, archivedAt: null },
        select: { id: true, name: true },
      })
      const matching = boards.filter((b) => b.name.toLowerCase() === check.board.toLowerCase())
      if (!matching.length) {
        return fail(`There is no ${check.board} board in this workspace yet. Create it, then move this card again.`)
      }
      const count = await prisma.workItem.count({
        where: { boardId: { in: matching.map((b) => b.id) }, archivedAt: null },
      })
      if (count >= check.count) return pass(`${count} cards on ${check.board}.`)
      return fail(
        `${check.board} has ${count} card${count === 1 ? '' : 's'}; this lesson needs ${check.count}. Add the rest, then move this card again.`,
      )
    }
    case 'schedules_enabled': {
      const own = await countOwnSchedules(workspaceId, await packScheduleIdsForWorkspace(workspaceId))
      if (own >= check.count) return pass(`${own} schedules of your own are running.`)
      return fail(
        `You have ${own} enabled schedule${own === 1 ? '' : 's'} of your own; this lesson needs ${check.count}. Create the rest, then move this card again.`,
      )
    }
    case 'none':
      return pass('This lesson has no machine check; the Coach confirms the output.')
  }
}

/**
 * The gate `moveWorkItem` calls before a card enters a done-category column.
 *
 * Only boards created from the course template are gated, and only a card that
 * carries a lesson id is a lesson. Everything else moves as it always has.
 */
export async function checkCourseLessonMove(params: {
  workspaceId: string
  board: { templateId?: string | null; name: string }
  columnCategory: string
  itemFields: unknown
  itemKey: string
}): Promise<LessonCheckResult | null> {
  if (params.board.templateId !== SOLO_FOUNDER_COURSE_BOARD_TEMPLATE) return null
  if (params.columnCategory !== 'done') return null
  const fields = (params.itemFields ?? {}) as Record<string, unknown>
  if (!fields.check) {
    return fail(
      `${params.itemKey} is not a lesson card (no check), so it cannot be closed on the Course board. Ask the Coach to reinstall the course.`,
    )
  }
  return evaluateLessonCheck(params.workspaceId, fields.check)
}

/**
 * Record a lesson as done: `progress.completedLessons`, `lastLessonAt`, and
 * `completedAt` when the Capstone is the one that finished. Idempotent — the
 * same lesson moved in and out twice records once.
 */
export async function recordLessonDone(params: {
  workspaceId: string
  lessonId: string
  at?: Date
}): Promise<void> {
  const lesson = lessonById(params.lessonId)
  const at = params.at ?? new Date()
  const enrollment = await prisma.courseEnrollment.findFirst({
    where: { workspaceId: params.workspaceId, courseId: SOLO_FOUNDER_COURSE_ID },
    select: { id: true, progress: true, courseBoardId: true },
  })
  if (!enrollment) return
  const progress = (enrollment.progress ?? {}) as {
    completedLessons?: string[]
    lastLessonAt?: string | null
  }
  const completed = Array.isArray(progress.completedLessons) ? progress.completedLessons : []
  if (completed.includes(params.lessonId)) return
  const next = [...completed, params.lessonId]
  const capstone = lesson ? lesson.id === 'capstone' : params.lessonId === 'capstone'
  await prisma.courseEnrollment.update({
    where: { id: enrollment.id },
    data: {
      progress: { completedLessons: next, lastLessonAt: at.toISOString() },
      ...(capstone ? { completedAt: at } : {}),
    },
  })
}

/** A card's lesson id, from its `fields.lessonId` (set when the card was created). */
export function lessonIdFromFields(fields: unknown): string | null {
  const value = (fields ?? {}) as Record<string, unknown>
  return typeof value.lessonId === 'string' && value.lessonId ? value.lessonId : null
}
