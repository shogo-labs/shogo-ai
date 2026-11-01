// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Rebuild a dead turn's assistant row from its journal (SHO-274).
 *
 * The journal holds exactly the frames the client received, so replaying them
 * through `trackUsageFromStream` — the same parser that writes the row during a
 * normal turn — produces exactly the row the person was reading. That is the
 * whole point of writing before forwarding: recovery cannot show less than what
 * was seen, and does not need its own parser to drift from the real one.
 *
 * Callers, one per way this platform dies:
 *   - desktop boot (`createLocalApp`, before the channel settle) — every runtime
 *     was killed on boot, so every `activeTurnId` is dead;
 *   - the cloud reattach job, when the runtime or its buffer is gone;
 *   - `postInterruptedResume`, so the resume message can carry the partial.
 */
import { readTurnFrames, deleteTurnFrames } from './chat-turn-journal'
import { stampTurnInterrupted } from './chat-resume.service'
import type { trackUsageFromStream } from '../routes/project-chat'

export interface JournalRecoveryResult {
  /** Frames were found and replayed into the row. */
  recovered: boolean
  /** Frames replayed. */
  frames: number
  /** The assistant row the replay wrote or updated. */
  assistantMessageId: string | null
}

/**
 * Stream the journaled frames back through the turn parser.
 *
 * `project: null` is deliberate: recovery rebuilds a row, it never bills. The
 * usage in these frames was already charged as it streamed (or written off with
 * the process that died), and charging it a second time on boot would be a real
 * overcharge for a crash the person did not cause.
 */
export async function recoverTurnFromJournal(
  sessionId: string,
  turnId: string,
  opts: {
    existingAssistantMessageId?: string | null
    keepFrames?: boolean
    /**
     * The turn parser. Imported lazily by default: this module is reached from
     * boot paths (`chat-turn-state`) that must not pull the whole chat route in
     * at load time, and tests replace it to assert the replay without a
     * database-coupled parser.
     */
    track?: typeof trackUsageFromStream
  } = {},
): Promise<JournalRecoveryResult> {
  const frames = await readTurnFrames(turnId)
  if (frames.length === 0) return { recovered: false, frames: 0, assistantMessageId: null }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })

  let assistantMessageId: string | null = null
  try {
    const track = opts.track ?? (await import('../routes/project-chat')).trackUsageFromStream
    const result = await track(
      stream,
      { chatSessionId: sessionId, agentMode: 'auto' },
      null,
      {
        chatSessionId: sessionId,
        // No runtime to ask: the journal is the whole turn we have. The retry
        // backoff would otherwise stall boot for seconds per dead turn.
        resume: async () => null,
        resumeRetryDelaysMs: [0],
        ...(opts.existingAssistantMessageId ? { existingAssistantMessageId: opts.existingAssistantMessageId } : {}),
      },
    )
    assistantMessageId = result.assistantMessageId ?? opts.existingAssistantMessageId ?? null
  } catch (error: any) {
    console.warn(`[ChatTurnJournal] Recovery replay failed for turn ${turnId}:`, error?.message ?? error)
    return { recovered: false, frames: frames.length, assistantMessageId: null }
  }

  // The frames ended without a terminal marker (that is why this turn is dead),
  // so the row must say the turn ended — otherwise the client keeps treating it
  // as a reply still being written and drops it on the next replay.
  await stampTurnInterrupted(sessionId, { reason: 'recovered_from_journal' }).catch((error) =>
    console.warn(`[ChatTurnJournal] Could not stamp recovered row for ${sessionId}:`, error?.message ?? error),
  )

  if (!opts.keepFrames) await deleteTurnFrames(turnId)

  console.log(
    `[ChatTurnJournal] Recovered turn ${turnId} for session ${sessionId}: ${frames.length} journal row(s) replayed`,
  )
  return { recovered: true, frames: frames.length, assistantMessageId }
}
