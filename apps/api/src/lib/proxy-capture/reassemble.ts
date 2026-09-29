import type { CaptureFormat, CaptureResponse } from './types'

const MAX_CAPTURE_TEXT_BYTES = 2 * 1024 * 1024

interface StreamAccumulator {
  text: string
  reasoning: string
  reasoningBlocks: Array<Record<string, unknown> | undefined>
  reasoningItems: unknown[]
  stopReason: string | null
  toolCalls: Array<{ id?: string; name?: string; arguments: string }>
  usage: Record<string, number>
  errorType: string | null
  truncated: boolean
}

function appendLimited(current: string, next: unknown, state: StreamAccumulator): string {
  if (typeof next !== 'string' || !next) return current
  const remaining = MAX_CAPTURE_TEXT_BYTES - Buffer.byteLength(current)
  if (remaining <= 0) {
    state.truncated = true
    return current
  }
  const bytes = Buffer.from(next)
  if (bytes.byteLength <= remaining) return current + next
  state.truncated = true
  return current + bytes.subarray(0, remaining).toString()
}

function addToolCall(state: StreamAccumulator, index: number, patch: { id?: string; name?: string; arguments?: string }): void {
  const call = state.toolCalls[index] || { arguments: '' }
  if (patch.id) call.id = patch.id
  if (patch.name) call.name = call.name ? call.name + patch.name : patch.name
  if (patch.arguments) call.arguments = appendLimited(call.arguments, patch.arguments, state)
  state.toolCalls[index] = call
}

function addReasoningItem(state: StreamAccumulator, item: unknown): void {
  if (!item || typeof item !== 'object') return
  const id = (item as Record<string, unknown>).id
  if (typeof id === 'string' && state.reasoningItems.some((existing: any) => existing?.id === id)) return
  state.reasoningItems.push(item)
}

function updateUsage(state: StreamAccumulator, usage: any): void {
  if (!usage || typeof usage !== 'object') return
  const input = usage.input_tokens ?? usage.prompt_tokens
  const output = usage.output_tokens ?? usage.completion_tokens
  if (typeof input === 'number') state.usage.inputTokens = input
  if (typeof output === 'number') state.usage.outputTokens = output
  const cached =
    usage.cache_read_input_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens
  if (typeof cached === 'number') state.usage.cachedInputTokens = cached
  const cacheWrite = usage.cache_creation_input_tokens ?? usage.prompt_cache_creation_tokens
  if (typeof cacheWrite === 'number') state.usage.cacheWriteTokens = cacheWrite
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens
  if (typeof reasoning === 'number') state.usage.reasoningTokens = reasoning
}

function consumeEvent(state: StreamAccumulator, format: Exclude<CaptureFormat, 'json'>, event: any): void {
  if (event?.error) {
    state.errorType = event.error.type || event.error.code || 'upstream_error'
  }

  if (format === 'anthropic') {
    if (event.type === 'message_start') updateUsage(state, event.message?.usage)
    if (event.type === 'message_delta') {
      state.stopReason = event.delta?.stop_reason || state.stopReason
      updateUsage(state, event.usage)
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta || {}
      if (delta.type === 'text_delta') state.text = appendLimited(state.text, delta.text, state)
      if (delta.type === 'thinking_delta') {
        state.reasoning = appendLimited(state.reasoning, delta.thinking, state)
        const block = state.reasoningBlocks[event.index || 0] || { type: 'thinking', thinking: '' }
        block.thinking = appendLimited(String(block.thinking || ''), delta.thinking, state)
        state.reasoningBlocks[event.index || 0] = block
      }
      if (delta.type === 'signature_delta') {
        const block = state.reasoningBlocks[event.index || 0] || { type: 'thinking', thinking: '' }
        block.signature = appendLimited(String(block.signature || ''), delta.signature, state)
        state.reasoningBlocks[event.index || 0] = block
      }
      if (delta.type === 'redacted_thinking_delta') {
        const block = state.reasoningBlocks[event.index || 0] || { type: 'redacted_thinking', data: '' }
        block.data = appendLimited(String(block.data || ''), delta.data, state)
        state.reasoningBlocks[event.index || 0] = block
      }
      if (delta.type === 'input_json_delta') {
        addToolCall(state, event.index || 0, { arguments: delta.partial_json })
      }
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block || {}
      if (block.type === 'tool_use') {
        addToolCall(state, event.index || 0, {
          id: block.id,
          name: block.name,
          arguments: block.input ? JSON.stringify(block.input) : '',
        })
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        state.reasoningBlocks[event.index || 0] = {
          ...block,
          ...(block.type === 'thinking' && block.thinking ? { thinking: block.thinking } : {}),
        }
        if (block.type === 'thinking') state.reasoning = appendLimited(state.reasoning, block.thinking, state)
      }
    }
    return
  }

  if (format === 'openai-chat') {
    updateUsage(state, event.usage)
    const choice = event.choices?.[0]
    if (choice?.finish_reason) state.stopReason = choice.finish_reason
    const delta = choice?.delta
    if (delta) {
      state.text = appendLimited(state.text, delta.content, state)
      state.reasoning = appendLimited(state.reasoning, delta.reasoning_content, state)
      for (const call of delta.tool_calls || []) {
        addToolCall(state, call.index || 0, {
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments,
        })
      }
    }
    return
  }

  updateUsage(state, event.response?.usage || event.usage)
  if (event.type === 'response.completed') {
    state.stopReason = event.response?.status || state.stopReason
    for (const item of event.response?.output || []) {
      if (item?.type === 'reasoning') addReasoningItem(state, item)
      if (item?.type === 'function_call') {
        addToolCall(state, item.output_index || 0, {
          id: item.call_id || item.id,
          name: item.name,
          arguments: item.arguments,
        })
      }
    }
  }
  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
    const item = event.item
    if (item?.type === 'reasoning') addReasoningItem(state, item)
    if (item?.type === 'function_call') {
      addToolCall(state, item.output_index || event.output_index || 0, {
        id: item.call_id || item.id,
        name: item.name,
        arguments: item.arguments,
      })
    }
  }
  if (event.type === 'response.output_text.delta') {
    state.text = appendLimited(state.text, event.delta, state)
  }
  if (event.type === 'response.reasoning_summary_text.delta') {
    state.reasoning = appendLimited(state.reasoning, event.delta, state)
  }
  if (event.type === 'response.function_call_arguments.delta') {
    const index = event.output_index || event.item_id || 0
    const numericIndex = typeof index === 'number' ? index : 0
    addToolCall(state, numericIndex, {
      id: event.item_id,
      name: event.name,
      arguments: event.delta,
    })
  }
}

function finalResponse(state: StreamAccumulator): Record<string, unknown> {
  return {
    content: state.text || undefined,
    reasoning_content: state.reasoning || undefined,
    reasoning_blocks: state.reasoningBlocks.filter(Boolean),
    reasoning_items: state.reasoningItems.length ? state.reasoningItems : undefined,
    tool_calls: state.toolCalls.filter(Boolean).length > 0 ? state.toolCalls.filter(Boolean) : undefined,
    stop_reason: state.stopReason,
    usage: state.usage,
  }
}

export function wrapCaptureStream(
  response: Response,
  format: Exclude<CaptureFormat, 'json'>,
  onComplete: (capture: CaptureResponse) => void,
): Response {
  if (!response.body) {
    onComplete({ status: response.status, body: null, format })
    return response
  }

  const decoder = new TextDecoder()
  let buffer = ''
  const state: StreamAccumulator = {
    text: '',
    reasoning: '',
    reasoningBlocks: [],
    reasoningItems: [],
    stopReason: null,
    toolCalls: [],
    usage: {},
    errorType: null,
    truncated: false,
  }
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          consumeEvent(state, format, JSON.parse(data))
        } catch {
          // A malformed upstream event is preserved for the caller, but is
          // not allowed to break the user's stream or the capture.
        }
      }
    },
    flush() {
      buffer += decoder.decode()
      if (buffer.startsWith('data:')) {
        try {
          const data = buffer.slice(5).trim()
          if (data && data !== '[DONE]') consumeEvent(state, format, JSON.parse(data))
        } catch {}
      }
      onComplete({
        status: response.status,
        body: finalResponse(state),
        format,
        headers: response.headers,
        usage: {
          inputTokens: state.usage.inputTokens,
          outputTokens: state.usage.outputTokens,
          cachedInputTokens: state.usage.cachedInputTokens,
          cacheWriteTokens: state.usage.cacheWriteTokens,
          reasoningTokens: state.usage.reasoningTokens,
        },
        errorType: state.errorType,
        truncated: state.truncated,
      })
    },
  })

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
