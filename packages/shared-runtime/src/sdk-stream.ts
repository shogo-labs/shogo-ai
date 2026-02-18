/**
 * Stream Claude Code V2 SDK events into AI SDK UIMessageChunks.
 *
 * This is the for-await loop that converts the SDK's stream_event, assistant,
 * and result messages into text-start/delta/end, tool-input-start/delta/available,
 * tool-output-available, and finish chunks. The project-runtime's implementation
 * is the canonical reference — it handles tool result tracking, duplicate
 * detection, usage stats, and step boundaries.
 *
 * Shared between project-runtime and agent-runtime.
 */

import type { SDKSession } from '@anthropic-ai/claude-agent-sdk'

/**
 * The writer interface expected by createUIMessageStream's execute callback.
 * We use a loose type here rather than importing the internal AI SDK type.
 */
export interface UIMessageStreamWriter {
  write(chunk: Record<string, any>): void
}

export interface StreamSdkToUIOptions {
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
  /**
   * Called with the stream query so the caller can store it for interruption.
   * Should be called immediately after session.stream() is created.
   */
  onQueryCreated?: (query: AsyncGenerator<any, void>) => void
  logPrefix?: string
}

/**
 * Stream SDK events from a V2 session into a UIMessageStreamWriter.
 *
 * Call session.send(text) BEFORE calling this function.
 * This function calls session.stream() and iterates through all events.
 */
export async function streamSdkToUI(
  session: SDKSession,
  writer: UIMessageStreamWriter,
  options?: StreamSdkToUIOptions,
): Promise<void> {
  const prefix = options?.logPrefix ?? 'runtime'

  let currentTextId: string | null = null
  let currentToolId: string | null = null
  let currentToolName: string | null = null
  let currentToolInput = ''
  const streamedToolIds = new Set<string>()
  let resultUsage: any = null
  let receivedStreamEvents = false
  const pendingToolResults = new Map<string, string>() // toolCallId → toolName

  writer.write({ type: 'start' })
  writer.write({ type: 'start-step' })

  // Send periodic keepalive comments to prevent idle connection timeouts
  // (Knative queue-proxy kills idle streams before Claude Code emits first event)
  const KEEPALIVE_INTERVAL_MS = 5_000
  const keepaliveTimer = setInterval(() => {
    try {
      writer.write({ type: 'text-delta', id: '__keepalive__', delta: '' })
    } catch {
      clearInterval(keepaliveTimer)
    }
  }, KEEPALIVE_INTERVAL_MS)

  const query = session.stream()
  options?.onQueryCreated?.(query as any)

  try {

  for await (const msg of query) {
    clearInterval(keepaliveTimer)
    const msgAny = msg as any

    // --- SDKPartialAssistantMessage — incremental streaming (preferred) ---
    if (msg.type === 'stream_event') {
      receivedStreamEvents = true
      const event = msgAny.event as any

      switch (event.type) {
        case 'message_start': {
          for (const [tcId] of pendingToolResults) {
            writer.write({
              type: 'tool-output-available',
              toolCallId: tcId,
              output: { success: true },
            })
          }
          pendingToolResults.clear()
          break
        }
        case 'content_block_start': {
          const block = event.content_block
          if (block?.type === 'text') {
            currentTextId = `text-${Date.now()}-${event.index}`
            writer.write({ type: 'text-start', id: currentTextId })
          } else if (block?.type === 'tool_use') {
            if (currentTextId) {
              writer.write({ type: 'text-end', id: currentTextId })
              currentTextId = null
            }
            currentToolId = block.id
            currentToolName = block.name
            currentToolInput = ''
            streamedToolIds.add(block.id)
            writer.write({
              type: 'tool-input-start',
              toolCallId: block.id,
              toolName: block.name,
              dynamic: true,
            })
          }
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta?.type === 'text_delta' && delta.text) {
            if (!currentTextId) {
              currentTextId = `text-${Date.now()}-${event.index}`
              writer.write({ type: 'text-start', id: currentTextId })
            }
            writer.write({ type: 'text-delta', id: currentTextId, delta: delta.text })
          } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
            currentToolInput += delta.partial_json
            writer.write({
              type: 'tool-input-delta',
              toolCallId: currentToolId || `tool-${event.index}`,
              inputTextDelta: delta.partial_json,
            })
          }
          break
        }
        case 'content_block_stop': {
          if (currentTextId) {
            writer.write({ type: 'text-end', id: currentTextId })
            currentTextId = null
          }
          if (currentToolId) {
            let parsedInput: any = {}
            try { parsedInput = JSON.parse(currentToolInput || '{}') } catch {}
            writer.write({
              type: 'tool-input-available',
              toolCallId: currentToolId,
              toolName: currentToolName || 'unknown',
              input: parsedInput,
              dynamic: true,
            })
            pendingToolResults.set(currentToolId, currentToolName || 'unknown')
            currentToolId = null
            currentToolName = null
            currentToolInput = ''
          }
          break
        }
        case 'message_stop': {
          if (currentTextId) {
            writer.write({ type: 'text-end', id: currentTextId })
            currentTextId = null
          }
          currentToolId = null
          currentToolName = null
          currentToolInput = ''
          writer.write({ type: 'finish-step' })
          writer.write({ type: 'start-step' })
          break
        }
      }
    }

    // --- SDKAssistantMessage — complete assistant response per turn ---
    else if (msg.type === 'assistant') {
      const content = msgAny.message?.content as Array<any> | undefined

      for (const [tcId] of pendingToolResults) {
        writer.write({
          type: 'tool-output-available',
          toolCallId: tcId,
          output: { success: true },
        })
      }
      pendingToolResults.clear()

      const toolBlocks = content?.filter((b: any) => b.type === 'tool_use') || []

      if (receivedStreamEvents) {
        // Text was already streamed — only emit tool calls not already streamed
        for (const block of toolBlocks) {
          if (streamedToolIds.has(block.id)) continue
          writer.write({
            type: 'tool-input-start',
            toolCallId: block.id,
            toolName: block.name,
            dynamic: true,
          })
          if (block.input) {
            writer.write({
              type: 'tool-input-delta',
              toolCallId: block.id,
              inputTextDelta: JSON.stringify(block.input),
            })
          }
          writer.write({
            type: 'tool-input-available',
            toolCallId: block.id,
            toolName: block.name,
            input: block.input || {},
            dynamic: true,
          })
          pendingToolResults.set(block.id, block.name)
        }
      } else {
        // No streaming — emit everything from the complete message
        if (content && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              const textId = `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              writer.write({ type: 'text-start', id: textId })
              writer.write({ type: 'text-delta', id: textId, delta: block.text })
              writer.write({ type: 'text-end', id: textId })
            } else if (block.type === 'tool_use') {
              writer.write({
                type: 'tool-input-start',
                toolCallId: block.id,
                toolName: block.name,
                dynamic: true,
              })
              if (block.input) {
                writer.write({
                  type: 'tool-input-delta',
                  toolCallId: block.id,
                  inputTextDelta: JSON.stringify(block.input),
                })
              }
              writer.write({
                type: 'tool-input-available',
                toolCallId: block.id,
                toolName: block.name,
                input: block.input || {},
                dynamic: true,
              })
              pendingToolResults.set(block.id, block.name)
            }
          }
        }
        writer.write({ type: 'finish-step' })
        writer.write({ type: 'start-step' })
      }

      receivedStreamEvents = false
    }

    // --- SDKResultMessage — turn complete with usage ---
    else if (msg.type === 'result') {
      const result = msg as any
      resultUsage = result.usage
      console.log(`[${prefix}] Result: ${result.subtype}, tokens: ${JSON.stringify(resultUsage)}`)

      if (currentTextId) {
        writer.write({ type: 'text-end', id: currentTextId })
        currentTextId = null
      }

      for (const [tcId] of pendingToolResults) {
        writer.write({
          type: 'tool-output-available',
          toolCallId: tcId,
          output: { success: true },
        })
      }
      pendingToolResults.clear()

      if (resultUsage && options?.onUsage) {
        options.onUsage({
          inputTokens: resultUsage.input_tokens ?? 0,
          outputTokens: resultUsage.output_tokens ?? 0,
        })
      }

      writer.write({
        type: 'finish',
        finishReason: result.subtype === 'success' ? 'stop' : 'error',
      })
      break
    }
  }

  } finally {
    clearInterval(keepaliveTimer)
  }
}
