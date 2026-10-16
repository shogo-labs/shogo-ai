// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent turns that run into a chat's stream buffer, so any window can attach
 * to them through `/agent/chat/:id/stream` while they run. Used by
 * `POST /agent/chat` and by pipeline calls (`project_call`) recorded as a chat.
 */
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import type { StreamBufferStore } from '@shogo-ai/sdk/stream-buffer'
import { encodeTurnCompleteFrame } from '@shogo/shared-runtime'
import { createStreamTrace } from '@shogo/shared-runtime/stream-trace'
import { getStreamFinishReason } from './stream-finish'
import type { LiveTurnGate } from './live-turn-wait'

export type UiStreamWriter = Parameters<Parameters<typeof createUIMessageStream>[0]['execute']>[0]['writer']

export interface BufferedTurn {
  turnId: string
  headers: Headers
  status: number
  streamTrace: ReturnType<typeof createStreamTrace>
  /** Settles once the turn's buffer is complete. */
  done: Promise<void>
}

export interface PipelineCallOptions {
  message: string
  runId?: string
  sessionId?: string
  callerProjectId?: string
  requesterTicket?: string
}

export interface PipelineCallResult {
  reply: string
  sessionId: string
  runId?: string
}

export interface BufferedTurnDeps {
  store: Pick<StreamBufferStore, 'create'>
  gate: Pick<LiveTurnGate, 'isBusy' | 'waitUntilFree'>
  onStreamStart?: () => void
  onStreamEnd?: () => void
}

/** Pipeline sessions that are runtime-internal keys rather than chats someone can open. */
export function isOpenableChatSession(sessionId: string | undefined): sessionId is string {
  return !!sessionId && !sessionId.startsWith('run:') && sessionId !== 'pipeline'
}

export function createBufferedTurns(deps: BufferedTurnDeps) {
  /**
   * Run one agent turn into the session's stream buffer. The buffer lives
   * independently of any HTTP connection: a background consumer feeds it, so
   * a client disconnect (e.g. page refresh) does NOT cancel the agent, and any
   * client can attach through `/agent/chat/:id/stream`. `run` writes the turn's
   * content; this adds the turn start, seq heartbeat and terminal frames.
   * Callers wait on the live-turn gate first.
   */
  function start(
    chatSessionKey: string,
    run: (writer: UiStreamWriter) => Promise<{ aborted?: boolean } | void>,
    opts: { afterSuccess?: () => void } = {},
  ): BufferedTurn {
    console.log(`[AgentChat] Creating stream buffer for session: ${chatSessionKey}`)
    const bufWriter = deps.store.create(chatSessionKey)
    const turnId = bufWriter.turnId

    deps.onStreamStart?.()
    // Tracks whether an explicit `data-turn-complete` terminal frame has been
    // emitted for this turn. The client's auto-resuming fetch keeps reconnecting
    // to `/stream?fromSeq=N` until it parses this frame; if the turn ends
    // abnormally (bg-reader transport error, process abort race) before the
    // try/catch below writes one, the buffer would be marked `completed` with NO
    // terminal frame and the client would replay the tail forever — pinning
    // `useChat().status` at `streaming` and wedging the composer on Stop/Queue.
    // The bgReader `finally` synthesizes one when this stays false.
    let terminalFrameWritten = false
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Periodic seq heartbeat. The client uses this to know how many
        // buffered chunks it has already received so it can resume with
        // `?fromSeq=N` on a premature disconnect without re-rendering text
        // it has already seen. Transient: the AI SDK would otherwise append
        // a message part every 250ms for the whole turn.
        const seqHeartbeat = setInterval(() => {
          const seq = bufWriter.lastSeq
          if (seq <= 0) return
          try {
            writer.write({
              type: 'data-turn-seq',
              data: { turnId, seq },
              transient: true,
            } as any)
          } catch {
            clearInterval(seqHeartbeat)
          }
        }, 250)
        try {
          // Mark the start of this durable turn so a reconnecting client
          // can correlate replay frames against the right turn id.
          writer.write({
            type: 'data-turn-start',
            data: {
              turnId,
              chatSessionId: chatSessionKey,
              startedAt: Date.now(),
            },
          } as any)
          writer.write({ type: 'start-step' })
          const result = await run(writer)
          const aborted = !!result?.aborted

          writer.write({ type: 'finish-step' })
          // Explicit terminal marker the client uses to differentiate "really
          // done" from "stream EOF mid-turn". Anything past this point on the
          // wire is purely framing noise and should be ignored by clients.
          //
          // When the user clicked Stop, the agent loop unwinds with
          // `result.abortReason === 'external'` and the gateway sets
          // `usage.wasAborted`. We tag the terminal frame `status: 'aborted'`
          // so project-chat (and other consumers) can distinguish a
          // user-initiated stop from a clean turn end and bill the partial
          // usage that was just emitted.
          writer.write({
            type: 'data-turn-complete',
            data: {
              turnId,
              chatSessionId: chatSessionKey,
              status: aborted ? 'aborted' : 'completed',
              lastSeq: bufWriter.lastSeq,
              completedAt: Date.now(),
            },
          } as any)
          terminalFrameWritten = true
          writer.write({ type: 'finish', finishReason: getStreamFinishReason(aborted) })
          opts.afterSuccess?.()
        } catch (error: any) {
          writer.write({
            type: 'data-turn-complete',
            data: {
              turnId,
              chatSessionId: chatSessionKey,
              status: 'failed',
              error: error?.message || 'Agent chat error',
              lastSeq: bufWriter.lastSeq,
              completedAt: Date.now(),
            },
          } as any)
          terminalFrameWritten = true
          writer.write({ type: 'error', errorText: error?.message || 'Agent chat error' } as any)
        } finally {
          clearInterval(seqHeartbeat)
          deps.onStreamEnd?.()
        }
      },
    })

    const response = createUIMessageStreamResponse({ stream })
    const streamTrace = createStreamTrace(`runtime-chat:${chatSessionKey.slice(0, 8)}`, ['buffered', 'replay', 'keepalive'])
    let done: Promise<void> = Promise.resolve()
    if (response.body) {
      // Consume the agent's stream in the background, feeding chunks into
      // the buffer. This reader is NOT tied to the HTTP response — the agent
      // keeps running even if the client disconnects.
      const bgReader = response.body.getReader()
      done = (async () => {
        try {
          while (true) {
            const { done, value } = await bgReader.read()
            if (done) break
            bufWriter.append(value)
            streamTrace.mark('buffered', value.byteLength)
          }
          console.log(`[AgentChat] Background stream completed for session: ${chatSessionKey} (turn ${turnId}, seq=${bufWriter.lastSeq})`)
        } catch (err: any) {
          console.log(`[AgentChat] Background stream error for session: ${chatSessionKey}:`, err?.message || err)
        } finally {
          // Guarantee a terminal frame in the buffer. If the turn ended without
          // the try/catch above writing one (bg-reader transport error, abort
          // race, or any path that tore the agent stream before the terminal
          // marker), synthesize one now — WHILE the buffer is still `active`, so
          // `append` assigns it a seq and it reaches both live subscribers and
          // future `?fromSeq=N` replays. Without this, the client's
          // auto-resuming fetch never sees `data-turn-complete`, replays the
          // tail forever, and the composer stays wedged in `streaming`.
          if (!terminalFrameWritten) {
            try {
              bufWriter.append(
                encodeTurnCompleteFrame({
                  turnId,
                  chatSessionId: chatSessionKey,
                  status: 'failed',
                  error: 'stream ended without terminal frame',
                  lastSeq: bufWriter.lastSeq,
                  completedAt: Date.now(),
                }),
              )
              terminalFrameWritten = true
              console.log(`[AgentChat] Synthesized terminal frame for session: ${chatSessionKey} (turn ${turnId})`)
            } catch (sErr: any) {
              console.warn(`[AgentChat] Failed to synthesize terminal frame for ${chatSessionKey}:`, sErr?.message || sErr)
            }
          }
          bufWriter.complete()
        }
      })()
    }
    return { turnId, headers: response.headers, status: response.status, streamTrace, done }
  }

  /**
   * Run a pipeline call. When the session is a real chat (the API records each
   * call as one), the turn is buffered like a chat turn so that chat can be
   * opened and watched while the call runs.
   */
  async function runPipelineCall(
    runCall: (opts: PipelineCallOptions & { writer?: UiStreamWriter }) => Promise<PipelineCallResult>,
    opts: PipelineCallOptions,
  ): Promise<PipelineCallResult> {
    const chatSessionKey = opts.sessionId?.trim()
    if (!isOpenableChatSession(chatSessionKey)) return runCall(opts)
    if (deps.gate.isBusy(chatSessionKey)) {
      const { stopped } = await deps.gate.waitUntilFree(chatSessionKey)
      if (stopped) throw new Error('The chat was stopped before this call started')
    }
    let result: PipelineCallResult | undefined
    let failure: unknown
    const turn = start(chatSessionKey, async (writer) => {
      try {
        result = await runCall({ ...opts, writer })
      } catch (err) {
        failure = err
        throw err
      }
    })
    await turn.done
    if (failure) throw failure
    if (!result) throw new Error('The pipeline call ended without a reply')
    return result
  }

  return { start, runPipelineCall }
}
