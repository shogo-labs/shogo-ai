// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat Usage Tracker
 *
 * Reads a teed copy of the AI SDK SSE stream produced by an agent-runtime
 * `/agent/chat` response, watches for the runtime's terminal markers
 * (`data-turn-complete`) and finish/usage events, and closes the active
 * billing session for the project exactly once when the stream ends.
 *
 * Used by chat entry points that want billing-session bracketing without
 * the message-persistence side effects of `project-chat.ts`'s in-route
 * tracker (e.g. the agent-proxy and instance-tunnel passthroughs).
 *
 * Behavior matches `trackUsageFromStream` in `project-chat.ts`:
 *   - SSE EOF without `data-turn-complete` is treated as an upstream cut
 *     (Knative activator / pod restart). The session is dropped via
 *     `closeSession({ discardPartial: true })` so the user is not billed
 *     for a half-finished turn the auto-resuming-fetch client will
 *     reconnect and finish.
 *   - Quality signals from the runtime's `data-usage`/`finish` events are
 *     forwarded to `setQualitySignals` BEFORE `closeSession` so the
 *     analytics emission inside `closeSession` sees them.
 */

import { closeSession, setQualitySignals, type BillingSessionQualitySignals } from './proxy-billing-session'

const PER_CHUNK_IDLE_TIMEOUT_MS = parseInt(
  process.env.CHAT_STREAM_IDLE_TIMEOUT_MS || '3600000',
  10,
)

/**
 * Drain a copy of the chat SSE stream and close the billing session for the
 * project on completion. Resolves when the stream ends and the close is
 * issued.
 */
export async function trackChatStreamForBilling(
  stream: ReadableStream<Uint8Array>,
  projectId: string,
): Promise<void> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''
  let observedTurnComplete = false
  let qualitySignals: BillingSessionQualitySignals = {}
  let streamInterrupted = false

  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const idleTimeout = new Promise<{ done: true; value: undefined }>((_, reject) => {
        idleTimer = setTimeout(() => reject(new Error('chunk idle timeout')), PER_CHUNK_IDLE_TIMEOUT_MS)
      })
      let result: { done: boolean; value: Uint8Array | undefined }
      try {
        result = (await Promise.race([reader.read(), idleTimeout])) as any
      } finally {
        clearTimeout(idleTimer)
      }
      const { done, value } = result!
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue

        let payload = line
        if (line.startsWith('data: ')) {
          payload = line.slice(6)
        } else if (line.startsWith('data:')) {
          payload = line.slice(5)
        }

        if (payload === '[DONE]' || line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) {
          continue
        }

        let data: any
        try {
          data = JSON.parse(payload)
        } catch {
          const prefix = line.slice(0, 2)
          if (prefix === 'e:' || prefix === 'd:') {
            try { data = JSON.parse(line.slice(2)) } catch { continue }
            if (!data.type) data.type = 'finish'
          } else {
            continue
          }
        }

        if (!data || typeof data !== 'object') continue
        const type = data.type

        if (type === 'data-turn-complete') {
          observedTurnComplete = true
        }

        if (type === 'finish' || type === 'finish-step' || type === 'usage' || type === 'data-usage') {
          const usageData = data.usage || data.data
          if (usageData && typeof usageData === 'object') {
            qualitySignals = {
              success: usageData.success === undefined ? undefined : usageData.success === true,
              hitMaxTurns: usageData.hitMaxTurns === true,
              loopDetected: usageData.loopDetected === true,
              escalated: usageData.escalated === true,
              responseEmpty: usageData.responseEmpty === true,
            }
          }
          if (data.success !== undefined || data.hitMaxTurns || data.loopDetected || data.escalated || data.responseEmpty) {
            qualitySignals = {
              success: data.success === undefined ? undefined : data.success === true,
              hitMaxTurns: data.hitMaxTurns === true,
              loopDetected: data.loopDetected === true,
              escalated: data.escalated === true,
              responseEmpty: data.responseEmpty === true,
            }
          }
        }
      }
    }
  } catch (err: any) {
    streamInterrupted = true
    console.warn(`[ChatUsageTracker] Stream interrupted for project ${projectId}: ${err?.code || err?.message}`)
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }

  const eofWithoutTurnComplete = !streamInterrupted && !observedTurnComplete
  setQualitySignals(projectId, qualitySignals)
  try {
    const { billedUsd } = await closeSession(projectId, {
      discardPartial: eofWithoutTurnComplete,
    })
    if (billedUsd > 0) {
      console.log(`[ChatUsageTracker] 💰 Billing session closed — charged $${billedUsd.toFixed(4)} for project ${projectId}`)
    }
  } catch (err) {
    console.error(`[ChatUsageTracker] Failed to close billing session for ${projectId}:`, err)
  }
}

/**
 * Wrap an upstream chat SSE response so that the body is forwarded to the
 * client AND a tee'd copy is consumed by `trackChatStreamForBilling`. Like
 * `project-chat.ts`, this uses a background reader instead of `body.tee()`
 * so a client disconnect does not stop billing/persistence from finishing.
 *
 * Returns a `ReadableStream` to hand back as the response body.
 */
export function teeChatStreamForBilling(
  upstreamBody: ReadableStream<Uint8Array>,
  projectId: string,
): ReadableStream<Uint8Array> {
  const bgReader = upstreamBody.getReader()
  const trackingChunks: Uint8Array[] = []
  let trackingDone = false
  let trackingNotify: (() => void) | null = null
  const trackingWait = () => new Promise<void>((resolve) => { trackingNotify = resolve })

  const trackingStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (trackingChunks.length === 0 && !trackingDone) {
        await trackingWait()
      }
      if (trackingChunks.length > 0) {
        controller.enqueue(trackingChunks.shift()!)
        return
      }
      controller.close()
    },
    cancel() {
      trackingDone = true
      trackingNotify?.()
      trackingNotify = null
    },
  })

  let clientEnqueueErrors = 0
  const clientStream = new ReadableStream<Uint8Array>({
    start(controller) {
      const keepaliveChunk = new TextEncoder().encode(': proxy-keep-alive\n\n')
      const proxyKeepalive = setInterval(() => {
        try { controller.enqueue(keepaliveChunk) } catch { clearInterval(proxyKeepalive) }
      }, 15_000)
      ;(async () => {
        try {
          let chunkCount = 0
          while (true) {
            const { done, value } = await bgReader.read()
            if (done) break
            chunkCount++
            trackingChunks.push(value)
            trackingNotify?.()
            trackingNotify = null
            try { controller.enqueue(value) } catch {
              if (clientEnqueueErrors === 0) {
                console.log(`[ChatUsageTracker:Stream] Client disconnected at chunk #${chunkCount} — stream continues for billing`)
              }
              clientEnqueueErrors++
            }
          }
        } catch (err: any) {
          console.log(`[ChatUsageTracker:Stream] Background reader error: ${err.message}`)
          try { controller.error(err) } catch { /* client gone */ }
        } finally {
          clearInterval(proxyKeepalive)
          trackingDone = true
          trackingNotify?.()
          trackingNotify = null
          try { controller.close() } catch { /* already closed */ }
        }
      })()
    },
  })

  trackChatStreamForBilling(trackingStream, projectId).catch((err) =>
    console.error(`[ChatUsageTracker] Tracking error for project ${projectId}:`, err),
  )

  return clientStream
}
