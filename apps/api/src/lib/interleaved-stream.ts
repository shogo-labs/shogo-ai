/**
 * Interleaved Stream Processor
 *
 * Transforms AI SDK fullStream TextStreamPart events into UIMessageChunk format
 * while preserving text/tool interleaving boundaries.
 *
 * The AI SDK's toUIMessageStream() consolidates all text into ONE part, losing
 * the boundaries between text segments and tool calls. By processing fullStream
 * directly, we maintain proper interleaving for the frontend to render tool calls
 * at their actual position in the conversation.
 *
 * Feature: chat-tool-interleaving-stream-processor
 * Task: task-stream-processor-module
 */

import { nanoid } from 'nanoid'
import type {
  TextStreamPart,
  UIMessageChunk,
  ProviderMetadata,
  ToolSet
} from 'ai'

// =============================================================================
// Types
// =============================================================================

/**
 * Options for the interleaved stream processor
 */
export interface InterleavedStreamOptions {
  /**
   * Optional callback to extract message metadata from providerMetadata.
   * Used to extract ccSessionId from Claude Code's providerMetadata.
   */
  getMessageMetadata?: (providerMetadata: ProviderMetadata | undefined) => Record<string, unknown> | undefined
}

/**
 * Internal state maintained during stream processing
 */
interface ProcessorState {
  /** Current text part ID, null if no active text part */
  currentTextId: string | null
  /** Map of active tool calls by toolCallId */
  activeToolCalls: Map<string, { toolName: string; toolCallId: string }>
  /** Latest providerMetadata (from finish-step event) */
  lastProviderMetadata: ProviderMetadata | undefined
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a unique ID for a text part
 * Format: text-{nanoid()}
 */
function generateTextId(): string {
  return `text-${nanoid()}`
}

/**
 * Finalize the current text part by yielding text-end and clearing state.
 * This is a helper that creates the text-end chunk.
 */
export function* finalizeCurrentText(
  state: ProcessorState
): Generator<UIMessageChunk> {
  if (state.currentTextId !== null) {
    yield { type: 'text-end', id: state.currentTextId }
    state.currentTextId = null
  }
}

// =============================================================================
// Main Stream Processor
// =============================================================================

/**
 * Process an interleaved stream of TextStreamPart events and yield UIMessageChunk.
 *
 * This async generator transforms AI SDK fullStream events into UI message chunks
 * while preserving the boundaries between text segments and tool calls.
 *
 * Key behaviors:
 * - First text-delta generates a new ID and yields text-start + text-delta
 * - Subsequent text-deltas yield text-delta with the same ID
 * - Tool events (tool-input-start) finalize any open text part first
 * - finish event finalizes any open text part and yields finish chunk
 * - error event yields error chunk
 * - Unknown events are logged and ignored
 *
 * @param stream - AsyncIterable of TextStreamPart events from fullStream
 * @param options - Optional configuration including getMessageMetadata callback
 */
export async function* processInterleavedStream<TOOLS extends ToolSet = ToolSet>(
  stream: AsyncIterable<TextStreamPart<TOOLS>>,
  options: InterleavedStreamOptions = {}
): AsyncGenerator<UIMessageChunk> {
  const state: ProcessorState = {
    currentTextId: null,
    activeToolCalls: new Map(),
    lastProviderMetadata: undefined
  }

  for await (const event of stream) {
    const chunks = processEvent(event, state, options)
    for (const chunk of chunks) {
      yield chunk
    }
  }
}

/**
 * Process a single TextStreamPart event and return UIMessageChunk(s).
 * Uses a generator to allow yielding multiple chunks per event.
 */
function* processEvent<TOOLS extends ToolSet>(
  event: TextStreamPart<TOOLS>,
  state: ProcessorState,
  options: InterleavedStreamOptions
): Generator<UIMessageChunk> {
  switch (event.type) {
    // =========================================================================
    // Text Events
    // =========================================================================
    case 'text-delta': {
      // First text-delta generates ID and yields text-start + text-delta
      if (state.currentTextId === null) {
        state.currentTextId = generateTextId()
        yield { type: 'text-start', id: state.currentTextId }
      }
      // Yield text-delta with current ID
      // Note: TextStreamPart uses 'text', UIMessageChunk uses 'delta'
      yield {
        type: 'text-delta',
        id: state.currentTextId,
        delta: event.text
      }
      break
    }

    case 'text-start': {
      // SDK may emit explicit text-start - we generate our own ID instead
      // This handles the case where SDK provides its own text-start
      if (state.currentTextId === null) {
        state.currentTextId = generateTextId()
        yield { type: 'text-start', id: state.currentTextId }
      }
      break
    }

    case 'text-end': {
      // SDK may emit explicit text-end - finalize our current text part
      yield* finalizeCurrentText(state)
      break
    }

    // =========================================================================
    // Tool Events
    // =========================================================================
    case 'tool-input-start': {
      // Finalize any open text part before starting tool
      yield* finalizeCurrentText(state)

      // Extract toolCallId from 'id' field in TextStreamPart
      const toolCallId = event.id
      const toolName = event.toolName

      // Track active tool call
      state.activeToolCalls.set(toolCallId, { toolName, toolCallId })

      // Yield tool-input-start (UIMessageChunk uses 'toolCallId', not 'id')
      yield {
        type: 'tool-input-start',
        toolCallId,
        toolName,
        providerExecuted: event.providerExecuted,
        dynamic: event.dynamic,
        title: event.title
      }
      break
    }

    case 'tool-input-delta': {
      // Yield tool-input-delta (UIMessageChunk uses 'inputTextDelta', not 'delta')
      yield {
        type: 'tool-input-delta',
        toolCallId: event.id,
        inputTextDelta: event.delta
      }
      break
    }

    case 'tool-input-end': {
      // Tool input complete - no specific UIMessageChunk for this
      // The tool is still tracked until tool-call or tool-result
      break
    }

    case 'tool-call': {
      // Tool call complete with input - yield tool-input-available
      // Note: AI SDK uses 'input' not 'args'
      yield {
        type: 'tool-input-available',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input
      }
      break
    }

    case 'tool-result': {
      const ev = event as any
      // When provider sends tool-result with isError: true (e.g. Bash non-zero exit),
      // yield tool-output-error so UI shows error; extract content from output when present
      if (ev.isError === true) {
        let errorText = 'Tool execution failed'
        if (ev.output != null) {
          if (typeof ev.output === 'string') {
            errorText = ev.output
          } else if (typeof ev.output === 'object' && ev.output?.stderr) {
            errorText = String(ev.output.stderr)
          } else {
            errorText = JSON.stringify(ev.output)
          }
        }
        yield {
          type: 'tool-output-error',
          toolCallId: event.toolCallId,
          errorText
        }
      } else {
        yield {
          type: 'tool-output-available',
          toolCallId: event.toolCallId,
          output: event.output
        }
      }
      state.activeToolCalls.delete(event.toolCallId)
      break
    }

    case 'tool-error': {
      const ev = event as any
      // Extract error from all known provider fields (Claude Code uses rawError in providerMetadata)
      const rawError = ev.providerMetadata?.['claude-code']?.rawError
      let errorContent = ev.error ?? rawError
      if (errorContent != null && typeof errorContent === 'object') {
        errorContent = errorContent?.message ?? JSON.stringify(errorContent)
      }
      const errorText =
        errorContent != null && String(errorContent).trim()
          ? String(errorContent)
          : 'Tool execution failed'
      yield {
        type: 'tool-output-error',
        toolCallId: event.toolCallId,
        errorText
      }
      state.activeToolCalls.delete(event.toolCallId)
      break
    }

    case 'tool-output-denied': {
      // Tool output denied (user rejected)
      yield {
        type: 'tool-output-denied',
        toolCallId: event.toolCallId
      }
      state.activeToolCalls.delete(event.toolCallId)
      break
    }

    // =========================================================================
    // Reasoning Events (pass through)
    // =========================================================================
    case 'reasoning-start': {
      yield {
        type: 'reasoning-start',
        id: event.id,
        providerMetadata: event.providerMetadata
      }
      break
    }

    case 'reasoning-delta': {
      yield {
        type: 'reasoning-delta',
        id: event.id,
        delta: event.text, // Note: TextStreamPart uses 'text', UIMessageChunk uses 'delta'
        providerMetadata: event.providerMetadata
      }
      break
    }

    case 'reasoning-end': {
      yield {
        type: 'reasoning-end',
        id: event.id,
        providerMetadata: event.providerMetadata
      }
      break
    }

    // =========================================================================
    // Step Events
    // =========================================================================
    case 'start-step': {
      yield { type: 'start-step' }
      break
    }

    case 'finish-step': {
      // Store providerMetadata for later use in finish event
      state.lastProviderMetadata = event.providerMetadata
      yield { type: 'finish-step' }
      break
    }

    // =========================================================================
    // Stream Lifecycle Events
    // =========================================================================
    case 'start': {
      yield { type: 'start' }
      break
    }

    case 'finish': {
      // Finalize any open text part
      yield* finalizeCurrentText(state)

      // Extract metadata using callback if provided
      let messageMetadata: Record<string, unknown> | undefined
      if (options.getMessageMetadata) {
        messageMetadata = options.getMessageMetadata(state.lastProviderMetadata)
      }

      yield {
        type: 'finish',
        finishReason: event.finishReason,
        messageMetadata
      }
      break
    }

    case 'abort': {
      // Finalize any open text part
      yield* finalizeCurrentText(state)

      yield {
        type: 'abort',
        reason: event.reason
      }
      break
    }

    case 'error': {
      // Yield error chunk with error message
      const errorMessage = event.error instanceof Error
        ? event.error.message
        : String(event.error)

      yield {
        type: 'error',
        errorText: errorMessage
      }
      break
    }

    // =========================================================================
    // Source Events (pass through)
    // =========================================================================
    case 'source': {
      // Source events have url or document info
      const sourceEvent = event as any
      if (sourceEvent.url) {
        yield {
          type: 'source-url',
          sourceId: sourceEvent.id || nanoid(),
          url: sourceEvent.url,
          title: sourceEvent.title,
          providerMetadata: sourceEvent.providerMetadata
        }
      }
      break
    }

    // =========================================================================
    // File Events
    // =========================================================================
    case 'file': {
      // GeneratedFile has base64 and mediaType, not url
      // Convert to data URL for UIMessageChunk
      const dataUrl = `data:${event.file.mediaType};base64,${event.file.base64}`
      yield {
        type: 'file',
        url: dataUrl,
        mediaType: event.file.mediaType
      }
      break
    }

    // =========================================================================
    // Events to ignore
    // =========================================================================
    case 'raw': {
      // Raw events are internal SDK debugging - ignore
      break
    }

    default: {
      // Unknown event types - log and ignore
      console.warn('[interleaved-stream] Unknown event type:', (event as any).type)
      break
    }
  }
}
