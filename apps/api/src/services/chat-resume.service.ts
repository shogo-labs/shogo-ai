// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Interrupted-turn resume (SHO-121).
 *
 * A turn can be cut off by something nobody in the conversation caused: the
 * runtime is killed mid-tool, or the API pod tracking it goes away with the
 * runtime behind it. Either way the transcript stops mid-work and there is no
 * final message, which the user reads as the app dropping their request.
 *
 * This module speaks for the turn: one deterministic assistant line naming the
 * interrupted step, and — the first time — one queued message that resumes it
 * with no human typing "continue". The copy is shared with the runtime
 * (`@shogo/shared-runtime/interrupted-turn`) so the two paths cannot drift.
 */
import {
  interruptedTurnNote,
  interruptedTurnResumeInstruction,
  isInterruptedTurnNote,
} from '@shogo/shared-runtime/interrupted-turn'
import { prisma } from '../lib/prisma'
import { dispatchNext } from './chat-queue-dispatcher.service'

export interface InterruptedResumeResult {
  /** An assistant row carrying the note was written. */
  noted: boolean
  /** A `kind: 'resume'` queued message was created (and dispatched). */
  queued: boolean
}

/** How far back an identical note counts as the same death. */
const NOTE_DEDUPE_WINDOW_MS = 5 * 60_000

/**
 * The step that never returned, read off the transcript.
 *
 * `project-chat` persists every tool call as a `dynamic-tool` part the moment
 * its input arrives and flips it to `output-available` when the result lands
 * (`routes/project-chat.ts:588-603`), so the newest part still in
 * `input-available` is exactly the tool that was running when the process
 * died. `parts` is JSON in the database but an array in memory, and a row from
 * an older build may hold neither.
 */
export function inFlightToolName(parts: unknown): string | null {
  let list: any[] = []
  if (Array.isArray(parts)) list = parts
  else if (typeof parts === 'string' && parts.trim()) {
    try {
      const parsed = JSON.parse(parts)
      if (Array.isArray(parsed)) list = parsed
    } catch {
      return null
    }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const part = list[i]
    if (!part || typeof part !== 'object' || part.type !== 'dynamic-tool' || part.state !== 'input-available') continue
    const name = typeof part.toolName === 'string' ? part.toolName.trim() : ''
    if (name) return name
  }
  return null
}

/**
 * Say the turn was interrupted, and queue its resume unless one is already
 * waiting.
 *
 * @param opts.resume `false` posts the note only — what a second death gets, so
 *   a resume that keeps dying cannot restart itself forever.
 */
export async function postInterruptedResume(
  chatSessionId: string,
  opts: { toolName?: string | null; resume?: boolean } = {},
): Promise<InterruptedResumeResult> {
  const session = await prisma.chatSession.findUnique({
    where: { id: chatSessionId },
    select: { id: true, createdByUserId: true, workspaceId: true, contextType: true, contextId: true },
  })
  if (!session) return { noted: false, queued: false }

  const resuming = opts.resume !== false
  const result: InterruptedResumeResult = { noted: false, queued: false }

  // The step that was in flight is already on the transcript, and naming it is
  // the difference between "something went wrong" and "the shell command you
  // were waiting on never came back". The newest assistant row is also what
  // carries the other path's note, so one read answers both questions.
  let latestAssistant: { content: string | null; parts: string | null; createdAt: Date } | null = null
  try {
    latestAssistant = await prisma.chatMessage.findFirst({
      where: { sessionId: chatSessionId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
      select: { content: true, parts: true, createdAt: true },
    })
  } catch {
    latestAssistant = null
  }

  const explicit = typeof opts.toolName === 'string' && opts.toolName.trim() ? opts.toolName.trim() : null
  const toolName = explicit ?? inFlightToolName(latestAssistant?.parts ?? null)
  const note = interruptedTurnNote(toolName, { resuming })

  // The note is a transcript row, so it is visible even when nothing resumes
  // and even if the queued turn never runs. The runtime's own boot sweep and
  // this job can both notice the same dead turn, so a note of the same kind
  // written moments ago — whichever wording, whichever tool name — is not
  // written twice. A `resume: false` note still replaces a `resume: true` one:
  // that is the resume that died, and the transcript must stop promising it.
  const notedRecently =
    latestAssistant != null &&
    latestAssistant.createdAt.getTime() >= Date.now() - NOTE_DEDUPE_WINDOW_MS &&
    isInterruptedTurnNote(latestAssistant.content, { resuming })

  if (!notedRecently) {
    await prisma.chatMessage
      .create({
        data: {
          sessionId: chatSessionId,
          role: 'assistant',
          content: note,
          parts: JSON.stringify([{ type: 'text', text: note }]),
          agent: 'technical',
          model: 'auto',
        },
      })
      .then(() => {
        result.noted = true
      })
      .catch(() => {})
  }

  if (!resuming) return result

  const userId = session.createdByUserId ?? (await ownerOf(session.workspaceId, session.contextType, session.contextId))
  if (!userId) return result

  // One waiting resume is enough: a second would queue a duplicate turn on the
  // same interrupted work.
  const alreadyQueued = await prisma.chatQueuedMessage.findFirst({
    where: { sessionId: chatSessionId, kind: 'resume', status: { in: ['pending', 'dispatching'] } },
    select: { id: true },
  })
  if (alreadyQueued) return result

  const latest = await prisma.chatQueuedMessage.findFirst({
    where: { sessionId: chatSessionId },
    orderBy: [{ position: 'desc' }, { createdAt: 'desc' }],
    select: { position: true },
  })
  // The note above is the message right before this one, so the resume itself is
  // only the instruction — saying it was interrupted twice would read as two
  // separate failures.
  const prompt = interruptedTurnResumeInstruction()
  await prisma.chatQueuedMessage.create({
    data: {
      sessionId: chatSessionId,
      userId,
      position: (latest?.position ?? -1) + 1,
      status: 'pending',
      kind: 'resume',
      content: prompt,
      // No `data-task-notification` part on purpose: this is not a task wake, so
      // the wake-pause rules must not count it (see `consecutiveWakeWaits`).
      parts: JSON.stringify([{ type: 'text', text: prompt }, { type: 'data-resume', data: { toolName } }]),
      body: JSON.stringify({ text: prompt }),
    },
  })
  result.queued = true

  void dispatchNext(chatSessionId).catch(() => {})
  return result
}

async function ownerOf(
  workspaceId: string | null,
  contextType: string | null,
  contextId: string | null,
): Promise<string | null> {
  let resolved = workspaceId
  if (!resolved && contextType === 'project' && contextId) {
    resolved = (await prisma.project.findUnique({ where: { id: contextId }, select: { workspaceId: true } }))?.workspaceId ?? null
  }
  if (!resolved) return null
  const owner = await prisma.member.findFirst({
    where: { workspaceId: resolved, role: 'owner' },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  })
  return owner?.userId ?? null
}
