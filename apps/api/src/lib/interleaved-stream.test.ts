/**
 * Tests for interleaved-stream.ts - Stream processor module
 *
 * Generated from TestSpecifications for task-stream-processor-module
 * Feature: chat-tool-interleaving-stream-processor
 *
 * These tests verify the stream processor correctly transforms fullStream
 * TextStreamPart events into UIMessageChunk format while preserving
 * text/tool interleaving boundaries.
 */

import { describe, test, expect, mock } from 'bun:test'
import type { TextStreamPart, UIMessageChunk, ProviderMetadata, ToolSet } from 'ai'
import {
  processInterleavedStream,
  type InterleavedStreamOptions
} from './interleaved-stream'

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Helper to create a mock async iterable from an array of TextStreamPart events
 */
async function* createMockStream<T>(events: T[]): AsyncIterable<T> {
  for (const event of events) {
    yield event
  }
}

/**
 * Collect all chunks from an async generator into an array
 */
async function collectChunks<T>(generator: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = []
  for await (const chunk of generator) {
    chunks.push(chunk)
  }
  return chunks
}

// Type for our TextStreamPart that handles the ToolSet generic
type TestTextStreamPart = TextStreamPart<ToolSet>

// Helper to create LanguageModelUsage for AI SDK v6 (uses inputTokens/outputTokens)
// Use type assertion to simplify test mock data
const createUsage = (input = 0, output = 0) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined
  },
  outputTokenDetails: {
    textTokens: undefined,
    reasoningTokens: undefined
  }
} as any)

// =============================================================================
// Test: Module exports InterleavedStreamOptions type
// TestSpecification: test-processor-exports-type
// =============================================================================

describe('Module exports', () => {
  test('InterleavedStreamOptions type is exported', () => {
    // Given: interleaved-stream.ts module exists at apps/api/src/lib/
    // When: Module is imported
    // Then: InterleavedStreamOptions type is exported

    // TypeScript compilation ensures the type exists if this test compiles
    const options: InterleavedStreamOptions = {}
    expect(options).toBeDefined()
  })

  test('InterleavedStreamOptions includes optional getMessageMetadata callback', () => {
    // Then: Type includes optional getMessageMetadata callback property
    const options: InterleavedStreamOptions = {
      getMessageMetadata: (providerMetadata) => ({ ccSessionId: 'test' })
    }
    expect(options.getMessageMetadata).toBeInstanceOf(Function)
  })
})

// =============================================================================
// Test: Module exports processInterleavedStream async generator
// TestSpecification: test-processor-exports-function
// =============================================================================

describe('processInterleavedStream function', () => {
  test('function is exported and returns an AsyncGenerator', async () => {
    // Given: interleaved-stream.ts module exists at apps/api/src/lib/
    // When: Module is imported
    // Then: processInterleavedStream function is exported
    expect(processInterleavedStream).toBeInstanceOf(Function)

    // Then: Function is an async generator (returns AsyncGenerator)
    const emptyStream = createMockStream<TestTextStreamPart>([])
    const result = processInterleavedStream(emptyStream)

    // Check it's an async iterator
    expect(typeof result[Symbol.asyncIterator]).toBe('function')
  })
})

// =============================================================================
// Test: First text-delta generates ID and yields text-start + text-delta
// TestSpecification: test-processor-text-delta-first
// =============================================================================

describe('text-delta event handling', () => {
  test('first text-delta generates ID and yields text-start + text-delta', async () => {
    // Given: processInterleavedStream function is called
    // Given: Input stream yields first text-delta event with textDelta: 'Hello'
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-id-1', text: 'Hello' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Yields text-start chunk with new ID (format: text-{nanoid})
    const textStart = chunks.find(c => c.type === 'text-start')
    expect(textStart).toBeDefined()
    expect(textStart!.type).toBe('text-start')
    expect((textStart as any).id).toMatch(/^text-/)

    // Then: Yields text-delta chunk with same ID and textDelta: 'Hello'
    const textDelta = chunks.find(c => c.type === 'text-delta')
    expect(textDelta).toBeDefined()
    expect((textDelta as any).delta).toBe('Hello')
    expect((textDelta as any).id).toBe((textStart as any).id)

    // Then: Text ID is stored in processor state (verified by consistent ID)
  })

  // =============================================================================
  // Test: Subsequent text-deltas yield text-delta with same ID
  // TestSpecification: test-processor-text-delta-subsequent
  // =============================================================================

  test('subsequent text-deltas yield text-delta with same ID', async () => {
    // Given: processInterleavedStream function is called
    // Given: First text-delta has been processed (ID established)
    // Given: Input stream yields second text-delta event with textDelta: ' world'
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-id-1', text: 'Hello' },
      { type: 'text-delta', id: 'sdk-id-1', text: ' world' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Yields text-delta chunk with same ID as first
    const textDeltas = chunks.filter(c => c.type === 'text-delta')
    expect(textDeltas.length).toBe(2)
    expect((textDeltas[0] as any).id).toBe((textDeltas[1] as any).id)

    // Then: No new text-start is yielded (only one text-start)
    const textStarts = chunks.filter(c => c.type === 'text-start')
    expect(textStarts.length).toBe(1)
  })
})

// =============================================================================
// Test: Tool event finalizes current text part before tool processing
// TestSpecification: test-processor-tool-finalizes-text
// =============================================================================

describe('tool event text finalization', () => {
  test('tool-input-start finalizes current text part before tool processing', async () => {
    // Given: processInterleavedStream function is called
    // Given: Text part is active (text-delta received)
    // Given: Input stream yields tool-input-start event
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: 'Before tool' },
      { type: 'tool-input-start', id: 'tool-call-1', toolName: 'myTool' },
      { type: 'tool-call', toolCallId: 'tool-call-1', toolName: 'myTool', input: { arg1: 'value' } } as any,
      { type: 'finish', finishReason: 'tool-calls', rawFinishReason: 'tool_use', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Yields text-end chunk with current text ID
    const textEnd = chunks.find(c => c.type === 'text-end')
    expect(textEnd).toBeDefined()

    // Verify text-end comes before tool-input-start
    const textEndIndex = chunks.findIndex(c => c.type === 'text-end')
    const toolStartIndex = chunks.findIndex(c => c.type === 'tool-input-start')
    expect(textEndIndex).toBeLessThan(toolStartIndex)

    // Then: Text state is cleared (currentTextId becomes null)
    // Then: Then yields tool-input-start chunk
    const toolStart = chunks.find(c => c.type === 'tool-input-start')
    expect(toolStart).toBeDefined()
  })
})

// =============================================================================
// Test: tool-call-streaming-start yields tool-input-start
// TestSpecification: test-processor-tool-call-streaming-start
// =============================================================================

describe('tool event handling', () => {
  test('tool-input-start event yields tool-input-start chunk', async () => {
    // Given: processInterleavedStream function is called
    // Given: No active text part
    // Given: Input stream yields tool-input-start with toolCallId and toolName
    const events: TestTextStreamPart[] = [
      { type: 'tool-input-start', id: 'tool-call-1', toolName: 'myTool' },
      { type: 'tool-call', toolCallId: 'tool-call-1', toolName: 'myTool', input: {} } as any,
      { type: 'finish', finishReason: 'tool-calls', rawFinishReason: 'tool_use', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Yields tool-input-start chunk with toolCallId and toolName
    const toolStart = chunks.find(c => c.type === 'tool-input-start') as any
    expect(toolStart).toBeDefined()
    expect(toolStart.toolCallId).toBe('tool-call-1')
    expect(toolStart.toolName).toBe('myTool')

    // Then: Tool is added to activeToolCalls map (internal state)
  })

  // =============================================================================
  // Test: tool-call-delta yields tool-input-delta
  // TestSpecification: test-processor-tool-call-delta
  // =============================================================================

  test('tool-input-delta event yields tool-input-delta chunk', async () => {
    // Given: processInterleavedStream function is called
    // Given: tool-input-start has been processed
    // Given: Input stream yields tool-input-delta with argsTextDelta
    const events: TestTextStreamPart[] = [
      { type: 'tool-input-start', id: 'tool-call-1', toolName: 'myTool' },
      { type: 'tool-input-delta', id: 'tool-call-1', delta: '{"arg1":' },
      { type: 'tool-input-delta', id: 'tool-call-1', delta: '"value"}' },
      { type: 'tool-call', toolCallId: 'tool-call-1', toolName: 'myTool', input: { arg1: 'value' } } as any,
      { type: 'finish', finishReason: 'tool-calls', rawFinishReason: 'tool_use', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Yields tool-input-delta chunk with toolCallId and argsTextDelta
    const toolDeltas = chunks.filter(c => c.type === 'tool-input-delta') as any[]
    expect(toolDeltas.length).toBe(2)
    expect(toolDeltas[0].toolCallId).toBe('tool-call-1')
    expect(toolDeltas[0].inputTextDelta).toBe('{"arg1":')
    expect(toolDeltas[1].inputTextDelta).toBe('"value"}')
  })

  // =============================================================================
  // Test: tool-call yields tool-input-available
  // TestSpecification: test-processor-tool-call
  // =============================================================================

  test('tool-call event yields tool-input-available chunk', async () => {
    // Given: processInterleavedStream function is called
    // Given: Input stream yields tool-call with toolCallId, toolName, and input
    const events: TestTextStreamPart[] = [
      { type: 'tool-input-start', id: 'tool-call-1', toolName: 'myTool' },
      { type: 'tool-call', toolCallId: 'tool-call-1', toolName: 'myTool', input: { arg1: 'value', arg2: 42 } } as any,
      { type: 'finish', finishReason: 'tool-calls', rawFinishReason: 'tool_use', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Yields tool-input-available chunk with toolCallId, toolName, and input
    const toolCall = chunks.find(c => c.type === 'tool-input-available') as any
    expect(toolCall).toBeDefined()
    expect(toolCall.toolCallId).toBe('tool-call-1')
    expect(toolCall.toolName).toBe('myTool')
    expect(toolCall.input).toEqual({ arg1: 'value', arg2: 42 })
  })

  // =============================================================================
  // Test: tool-result yields tool-output-available
  // TestSpecification: test-processor-tool-result
  // =============================================================================

  test('tool-result event yields tool-output-available chunk', async () => {
    // Given: processInterleavedStream function is called
    // Given: Input stream yields tool-result with toolCallId and output
    const events: TestTextStreamPart[] = [
      { type: 'tool-input-start', id: 'tool-call-1', toolName: 'myTool' },
      { type: 'tool-call', toolCallId: 'tool-call-1', toolName: 'myTool', input: {} } as any,
      { type: 'tool-result', toolCallId: 'tool-call-1', toolName: 'myTool', input: {}, output: { success: true, data: 'result' } } as any,
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Yields tool-output-available chunk with toolCallId and output
    const toolResult = chunks.find(c => c.type === 'tool-output-available') as any
    expect(toolResult).toBeDefined()
    expect(toolResult.toolCallId).toBe('tool-call-1')
    expect(toolResult.output).toEqual({ success: true, data: 'result' })
  })
})

// =============================================================================
// Test: finish event finalizes any open text part
// TestSpecification: test-processor-finish-finalizes-text
// =============================================================================

describe('finish event handling', () => {
  test('finish event finalizes any open text part', async () => {
    // Given: processInterleavedStream function is called
    // Given: Text part is active (text-delta received)
    // Given: Input stream yields finish event
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: 'Some text' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Yields text-end chunk with current text ID
    const textEnd = chunks.find(c => c.type === 'text-end')
    expect(textEnd).toBeDefined()

    // Then: Yields finish chunk
    const finish = chunks.find(c => c.type === 'finish')
    expect(finish).toBeDefined()

    // Verify order: text-end comes before finish
    const textEndIndex = chunks.findIndex(c => c.type === 'text-end')
    const finishIndex = chunks.findIndex(c => c.type === 'finish')
    expect(textEndIndex).toBeLessThan(finishIndex)
  })

  // =============================================================================
  // Test: finish event extracts ccSessionId via getMessageMetadata
  // TestSpecification: test-processor-finish-extracts-ccsessionid
  // =============================================================================

  test('finish event extracts ccSessionId from providerMetadata', async () => {
    // Given: processInterleavedStream function is called with getMessageMetadata option
    // Given: Input stream yields finish event with providerMetadata.claude-code.sessionId
    const mockProviderMetadata: ProviderMetadata = {
      'claude-code': {
        sessionId: 'cc-session-abc123'
      }
    }

    // Note: The actual providerMetadata comes from finish-step event, not finish
    const eventsWithMeta: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: 'Hello' },
      {
        type: 'finish-step',
        response: {} as any,
        usage: createUsage(10, 20),
        finishReason: 'stop',
        rawFinishReason: 'stop',
        providerMetadata: mockProviderMetadata
      },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: createUsage(10, 20)
      }
    ]

    const getMessageMetadata = mock((metadata: ProviderMetadata | undefined) => {
      const claudeCode = metadata?.['claude-code'] as { sessionId?: string } | undefined
      return claudeCode?.sessionId ? { ccSessionId: claudeCode.sessionId } : undefined
    })

    const stream = createMockStream(eventsWithMeta)
    const chunks = await collectChunks(processInterleavedStream(stream, { getMessageMetadata }))

    // Then: getMessageMetadata callback is invoked
    expect(getMessageMetadata).toHaveBeenCalled()

    // Then: ccSessionId is extracted from providerMetadata
    // Then: finish chunk includes metadata with ccSessionId
    const finish = chunks.find(c => c.type === 'finish') as any
    expect(finish).toBeDefined()
    expect(finish.messageMetadata?.ccSessionId).toBe('cc-session-abc123')
  })
})

// =============================================================================
// Test: error event yields error chunk
// TestSpecification: test-processor-error-event
// =============================================================================

describe('error event handling', () => {
  test('error event yields error chunk', async () => {
    // Given: processInterleavedStream function is called
    // Given: Input stream yields error event with Error object
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: 'Starting...' },
      { type: 'error', error: new Error('Something went wrong') }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Yields error chunk with error message
    const errorChunk = chunks.find(c => c.type === 'error') as any
    expect(errorChunk).toBeDefined()
    expect(errorChunk.errorText).toBe('Something went wrong')
  })
})

// =============================================================================
// Test: Unknown events are logged and ignored
// TestSpecification: test-processor-unknown-event
// =============================================================================

describe('unknown event handling', () => {
  test('unknown events are logged and ignored without crashing', async () => {
    // Given: processInterleavedStream function is called
    // Given: Input stream yields event with unknown type 'foo-bar'
    const events: any[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: 'Hello' },
      { type: 'foo-bar', data: 'unknown event' },
      { type: 'text-delta', id: 'sdk-text-1', text: ' world' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)

    // Then: Stream continues without crashing
    const chunks = await collectChunks(processInterleavedStream(stream as AsyncIterable<TestTextStreamPart>))

    // Then: No chunk is yielded for the unknown event
    const unknownChunks = chunks.filter((c: any) => c.type === 'foo-bar')
    expect(unknownChunks.length).toBe(0)

    // Then: Other events are still processed normally
    const textDeltas = chunks.filter(c => c.type === 'text-delta')
    expect(textDeltas.length).toBe(2)
  })
})

// =============================================================================
// Additional integration-style tests
// =============================================================================

// =============================================================================
// Comprehensive Tests from Test Specifications
// TestSpecification: task-stream-processor-tests
// =============================================================================

describe('test-unit-text-only-stream: Text-only stream yields exact sequence', () => {
  /**
   * TestSpecification: test-unit-text-only-stream
   * Given: Mock AsyncIterable yields: text-delta('Hello'), text-delta(' world'), finish
   * When: processInterleavedStream consumes entire stream
   * Then:
   *   - Output sequence is: text-start, text-delta('Hello'), text-delta(' world'), text-end, finish
   *   - All text chunks share same ID
   *   - No tool-related chunks are yielded
   */
  test('text-only stream yields text-start, text-delta(s), text-end on finish', async () => {
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-id-1', text: 'Hello' },
      { type: 'text-delta', id: 'sdk-id-1', text: ' world' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Output sequence is: text-start, text-delta('Hello'), text-delta(' world'), text-end, finish
    expect(chunks.length).toBe(5)
    expect(chunks[0].type).toBe('text-start')
    expect(chunks[1].type).toBe('text-delta')
    expect((chunks[1] as any).delta).toBe('Hello')
    expect(chunks[2].type).toBe('text-delta')
    expect((chunks[2] as any).delta).toBe(' world')
    expect(chunks[3].type).toBe('text-end')
    expect(chunks[4].type).toBe('finish')

    // Then: All text chunks share same ID
    const textStart = chunks[0] as any
    const textDelta1 = chunks[1] as any
    const textDelta2 = chunks[2] as any
    const textEnd = chunks[3] as any
    expect(textDelta1.id).toBe(textStart.id)
    expect(textDelta2.id).toBe(textStart.id)
    expect(textEnd.id).toBe(textStart.id)

    // Then: No tool-related chunks are yielded
    const toolChunks = chunks.filter(c =>
      c.type === 'tool-input-start' ||
      c.type === 'tool-input-delta' ||
      c.type === 'tool-input-available' ||
      c.type === 'tool-output-available'
    )
    expect(toolChunks.length).toBe(0)
  })
})

describe('test-unit-tool-only-stream: Tool-only stream yields exact sequence', () => {
  /**
   * TestSpecification: test-unit-tool-only-stream
   * Given: Mock AsyncIterable yields: tool-call-streaming-start, tool-call-delta, tool-call, tool-result, finish
   * When: processInterleavedStream consumes entire stream
   * Then:
   *   - Output sequence is: tool-input-start, tool-input-delta, tool-input-available, tool-output-available, finish
   *   - No text-start or text-end chunks are yielded
   */
  test('tool-only stream (no text) yields tool chunks without text parts', async () => {
    const events: TestTextStreamPart[] = [
      { type: 'tool-input-start', id: 'tool-call-1', toolName: 'myTool' },
      { type: 'tool-input-delta', id: 'tool-call-1', delta: '{"arg":"value"}' },
      { type: 'tool-call', toolCallId: 'tool-call-1', toolName: 'myTool', input: { arg: 'value' } } as any,
      { type: 'tool-result', toolCallId: 'tool-call-1', toolName: 'myTool', input: { arg: 'value' }, output: { result: 'success' } } as any,
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Output sequence is: tool-input-start, tool-input-delta, tool-input-available, tool-output-available, finish
    expect(chunks.length).toBe(5)
    expect(chunks[0].type).toBe('tool-input-start')
    expect(chunks[1].type).toBe('tool-input-delta')
    expect(chunks[2].type).toBe('tool-input-available')
    expect(chunks[3].type).toBe('tool-output-available')
    expect(chunks[4].type).toBe('finish')

    // Then: No text-start or text-end chunks are yielded
    const textStarts = chunks.filter(c => c.type === 'text-start')
    const textEnds = chunks.filter(c => c.type === 'text-end')
    expect(textStarts.length).toBe(0)
    expect(textEnds.length).toBe(0)
  })
})

describe('test-unit-interleaved-stream: Interleaved stream yields distinct text parts', () => {
  /**
   * TestSpecification: test-unit-interleaved-stream
   * Given: Mock AsyncIterable yields: text-delta('Before'), tool-call-streaming-start, tool-call, tool-result, text-delta('After'), finish
   * When: processInterleavedStream consumes entire stream
   * Then:
   *   - First text part has ID text-1: text-start, text-delta('Before'), text-end
   *   - Tool chunks appear: tool-input-start, tool-input-available, tool-output-available
   *   - Second text part has different ID text-2: text-start, text-delta('After'), text-end
   *   - finish chunk at end
   */
  test('interleaved stream (text -> tool -> text) yields two distinct text parts with different IDs', async () => {
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: 'Before' },
      { type: 'tool-input-start', id: 'tool-call-1', toolName: 'myTool' },
      { type: 'tool-call', toolCallId: 'tool-call-1', toolName: 'myTool', input: {} } as any,
      { type: 'tool-result', toolCallId: 'tool-call-1', toolName: 'myTool', input: {}, output: 'result' } as any,
      { type: 'text-delta', id: 'sdk-text-2', text: 'After' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Verify two distinct text parts
    const textStarts = chunks.filter(c => c.type === 'text-start') as any[]
    expect(textStarts.length).toBe(2)

    // Then: First and second text parts have different IDs
    expect(textStarts[0].id).not.toBe(textStarts[1].id)

    // Verify first text part sequence
    const firstTextStartIdx = chunks.findIndex(c => c.type === 'text-start')
    const firstTextDeltaIdx = chunks.findIndex(c => c.type === 'text-delta' && (c as any).delta === 'Before')
    const firstTextEndIdx = chunks.findIndex(c => c.type === 'text-end')
    expect(firstTextStartIdx).toBeLessThan(firstTextDeltaIdx)
    expect(firstTextDeltaIdx).toBeLessThan(firstTextEndIdx)

    // Verify tool chunks appear between text parts
    const toolStartIdx = chunks.findIndex(c => c.type === 'tool-input-start')
    const toolAvailableIdx = chunks.findIndex(c => c.type === 'tool-input-available')
    const toolOutputIdx = chunks.findIndex(c => c.type === 'tool-output-available')
    expect(firstTextEndIdx).toBeLessThan(toolStartIdx)
    expect(toolStartIdx).toBeLessThan(toolAvailableIdx)
    expect(toolAvailableIdx).toBeLessThan(toolOutputIdx)

    // Verify second text part comes after tool
    const secondTextStartIdx = chunks.findIndex((c, i) => c.type === 'text-start' && i > toolOutputIdx)
    const secondTextDeltaIdx = chunks.findIndex(c => c.type === 'text-delta' && (c as any).delta === 'After')
    expect(secondTextStartIdx).toBeGreaterThan(toolOutputIdx)
    expect(secondTextDeltaIdx).toBeGreaterThan(secondTextStartIdx)

    // Verify finish chunk at end
    const finishIdx = chunks.findIndex(c => c.type === 'finish')
    expect(finishIdx).toBe(chunks.length - 1)
  })
})

describe('test-unit-multiple-tools-between-text: Multiple sequential tools between text', () => {
  /**
   * TestSpecification: test-unit-multiple-tools-between-text
   * Given: Mock AsyncIterable yields: text-delta('Start'), tool-call-streaming-start(tool1), tool-result(tool1),
   *        tool-call-streaming-start(tool2), tool-result(tool2), text-delta('End'), finish
   * When: processInterleavedStream consumes entire stream
   * Then:
   *   - First text finalized before first tool
   *   - Both tools emit full sequences (input-start through output-available)
   *   - Second text starts after all tools complete
   *   - Only 2 text IDs are created (before tools, after tools)
   */
  test('multiple sequential tools between text segments each get proper boundaries', async () => {
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: 'Start' },
      // Tool 1
      { type: 'tool-input-start', id: 'tool-1', toolName: 'tool1' },
      { type: 'tool-call', toolCallId: 'tool-1', toolName: 'tool1', input: { a: 1 } } as any,
      { type: 'tool-result', toolCallId: 'tool-1', toolName: 'tool1', input: { a: 1 }, output: 'result1' } as any,
      // Tool 2
      { type: 'tool-input-start', id: 'tool-2', toolName: 'tool2' },
      { type: 'tool-call', toolCallId: 'tool-2', toolName: 'tool2', input: { b: 2 } } as any,
      { type: 'tool-result', toolCallId: 'tool-2', toolName: 'tool2', input: { b: 2 }, output: 'result2' } as any,
      // After tools text
      { type: 'text-delta', id: 'sdk-text-2', text: 'End' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Only 2 text IDs are created (before tools, after tools)
    const textStarts = chunks.filter(c => c.type === 'text-start') as any[]
    expect(textStarts.length).toBe(2)
    expect(textStarts[0].id).not.toBe(textStarts[1].id)

    // Then: First text finalized before first tool
    const firstTextEndIdx = chunks.findIndex(c => c.type === 'text-end')
    const firstToolStartIdx = chunks.findIndex(c => c.type === 'tool-input-start')
    expect(firstTextEndIdx).toBeLessThan(firstToolStartIdx)

    // Then: Both tools emit full sequences (input-start through output-available)
    const toolInputStarts = chunks.filter(c => c.type === 'tool-input-start') as any[]
    const toolInputAvailables = chunks.filter(c => c.type === 'tool-input-available') as any[]
    const toolOutputAvailables = chunks.filter(c => c.type === 'tool-output-available') as any[]

    expect(toolInputStarts.length).toBe(2)
    expect(toolInputAvailables.length).toBe(2)
    expect(toolOutputAvailables.length).toBe(2)

    // Verify tool 1 sequence
    expect(toolInputStarts[0].toolCallId).toBe('tool-1')
    expect(toolInputAvailables[0].toolCallId).toBe('tool-1')
    expect(toolOutputAvailables[0].toolCallId).toBe('tool-1')

    // Verify tool 2 sequence
    expect(toolInputStarts[1].toolCallId).toBe('tool-2')
    expect(toolInputAvailables[1].toolCallId).toBe('tool-2')
    expect(toolOutputAvailables[1].toolCallId).toBe('tool-2')

    // Then: Second text starts after all tools complete
    const lastToolOutputIdx = chunks.findIndex(c =>
      c.type === 'tool-output-available' && (c as any).toolCallId === 'tool-2'
    )
    const secondTextStartIdx = chunks.findIndex((c, i) => c.type === 'text-start' && i > lastToolOutputIdx)
    expect(secondTextStartIdx).toBeGreaterThan(lastToolOutputIdx)
  })
})

describe('test-unit-back-to-back-tools: Back-to-back tool calls without text', () => {
  /**
   * TestSpecification: test-unit-back-to-back-tools
   * Given: Mock AsyncIterable yields: tool-call-streaming-start(tool1), tool-result(tool1),
   *        tool-call-streaming-start(tool2), tool-result(tool2), finish
   * When: processInterleavedStream consumes entire stream
   * Then:
   *   - Both tools get complete input/output sequences
   *   - No text-end is yielded between tools (no active text)
   *   - No crashes or undefined behavior
   */
  test('back-to-back tool calls without intervening text are handled correctly', async () => {
    const events: TestTextStreamPart[] = [
      { type: 'tool-input-start', id: 'tool-1', toolName: 'tool1' },
      { type: 'tool-call', toolCallId: 'tool-1', toolName: 'tool1', input: {} } as any,
      { type: 'tool-result', toolCallId: 'tool-1', toolName: 'tool1', input: {}, output: 'r1' } as any,
      { type: 'tool-input-start', id: 'tool-2', toolName: 'tool2' },
      { type: 'tool-call', toolCallId: 'tool-2', toolName: 'tool2', input: {} } as any,
      { type: 'tool-result', toolCallId: 'tool-2', toolName: 'tool2', input: {}, output: 'r2' } as any,
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Both tools get complete input/output sequences
    const toolInputStarts = chunks.filter(c => c.type === 'tool-input-start') as any[]
    const toolInputAvailables = chunks.filter(c => c.type === 'tool-input-available') as any[]
    const toolOutputAvailables = chunks.filter(c => c.type === 'tool-output-available') as any[]

    expect(toolInputStarts.length).toBe(2)
    expect(toolInputAvailables.length).toBe(2)
    expect(toolOutputAvailables.length).toBe(2)

    // Then: No text-end is yielded between tools (no active text)
    const textEnds = chunks.filter(c => c.type === 'text-end')
    expect(textEnds.length).toBe(0)

    // Then: No crashes - stream completed successfully with finish
    const finish = chunks.find(c => c.type === 'finish')
    expect(finish).toBeDefined()
  })
})

describe('test-unit-empty-text-delta: Empty text delta handling', () => {
  /**
   * TestSpecification: test-unit-empty-text-delta
   * Given: Mock AsyncIterable yields: text-delta(''), text-delta('Hello'), finish
   * When: processInterleavedStream consumes entire stream
   * Then:
   *   - Empty text-delta is handled gracefully
   *   - Only one text part is created
   *   - Output includes text-delta('Hello') but handles empty appropriately
   */
  test("empty text delta ('') does not create spurious text parts", async () => {
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: '' },
      { type: 'text-delta', id: 'sdk-text-1', text: 'Hello' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Only one text part is created
    const textStarts = chunks.filter(c => c.type === 'text-start')
    expect(textStarts.length).toBe(1)

    // Then: Empty text-delta is handled gracefully (yielded but doesn't break anything)
    // Then: Output includes text-delta('Hello')
    const textDeltas = chunks.filter(c => c.type === 'text-delta') as any[]
    const helloDeltas = textDeltas.filter(d => d.delta === 'Hello')
    expect(helloDeltas.length).toBe(1)

    // Verify stream completes normally
    const finish = chunks.find(c => c.type === 'finish')
    expect(finish).toBeDefined()
  })
})

describe('test-unit-error-graceful: Error event handling', () => {
  /**
   * TestSpecification: test-unit-error-graceful
   * Given: Mock AsyncIterable yields: text-delta('Hello'), error(new Error('Stream failed'))
   * When: processInterleavedStream consumes stream until error
   * Then:
   *   - Text chunks are yielded before error
   *   - Error chunk is yielded with error message
   *   - Generator completes without throwing
   */
  test('error event yields error chunk and stream ends gracefully', async () => {
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: 'Hello' },
      { type: 'error', error: new Error('Stream failed') }
    ]

    const stream = createMockStream(events)

    // Then: Generator completes without throwing
    let caughtError: Error | null = null
    let chunks: any[] = []
    try {
      chunks = await collectChunks(processInterleavedStream(stream))
    } catch (e) {
      caughtError = e as Error
    }

    expect(caughtError).toBeNull()

    // Then: Text chunks are yielded before error
    const textStartIdx = chunks.findIndex(c => c.type === 'text-start')
    const textDeltaIdx = chunks.findIndex(c => c.type === 'text-delta')
    const errorIdx = chunks.findIndex(c => c.type === 'error')

    expect(textStartIdx).toBeLessThan(errorIdx)
    expect(textDeltaIdx).toBeLessThan(errorIdx)

    // Then: Error chunk is yielded with error message
    const errorChunk = chunks.find(c => c.type === 'error') as any
    expect(errorChunk).toBeDefined()
    expect(errorChunk.errorText).toBe('Stream failed')
  })
})

describe('test-unit-ccsessionid-extraction: ccSessionId extraction from providerMetadata', () => {
  /**
   * TestSpecification: test-unit-ccsessionid-extraction
   * Given: Mock AsyncIterable yields: finish event with providerMetadata: { 'claude-code': { sessionId: 'session-123' } }
   * Given: getMessageMetadata callback is provided in options
   * When: processInterleavedStream processes finish event
   * Then:
   *   - Finish chunk metadata includes ccSessionId: 'session-123'
   *   - getMessageMetadata callback receives correct session ID
   */
  test('finish event extracts ccSessionId from providerMetadata.claude-code.sessionId', async () => {
    const events: TestTextStreamPart[] = [
      {
        type: 'finish-step',
        response: {} as any,
        usage: createUsage(10, 20),
        finishReason: 'stop',
        rawFinishReason: 'stop',
        providerMetadata: {
          'claude-code': {
            sessionId: 'session-123'
          }
        }
      },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: createUsage(10, 20)
      }
    ]

    let receivedMetadata: any = null
    const getMessageMetadata = (metadata: any) => {
      receivedMetadata = metadata
      const claudeCode = metadata?.['claude-code'] as { sessionId?: string } | undefined
      return claudeCode?.sessionId ? { ccSessionId: claudeCode.sessionId } : undefined
    }

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream, { getMessageMetadata }))

    // Then: getMessageMetadata callback receives correct session ID
    expect(receivedMetadata).toBeDefined()
    expect(receivedMetadata?.['claude-code']?.sessionId).toBe('session-123')

    // Then: Finish chunk metadata includes ccSessionId: 'session-123'
    const finishChunk = chunks.find(c => c.type === 'finish') as any
    expect(finishChunk).toBeDefined()
    expect(finishChunk.messageMetadata?.ccSessionId).toBe('session-123')
  })
})

describe('test-unit-unknown-events-ignored: Unknown event types handling', () => {
  /**
   * TestSpecification: test-unit-unknown-events-ignored
   * Given: Mock AsyncIterable yields: text-delta('Hello'), {type: 'unknown-event-type'}, text-delta(' world'), finish
   * When: processInterleavedStream consumes entire stream
   * Then:
   *   - Unknown event does not cause crash
   *   - Text parts before and after unknown event are processed normally
   *   - Stream completes successfully
   */
  test('unknown event types are ignored without throwing', async () => {
    const events: any[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: 'Hello' },
      { type: 'unknown-event-type', data: 'should be ignored' },
      { type: 'text-delta', id: 'sdk-text-1', text: ' world' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)

    // Then: Unknown event does not cause crash
    let caughtError: Error | null = null
    let chunks: any[] = []
    try {
      chunks = await collectChunks(processInterleavedStream(stream as AsyncIterable<TestTextStreamPart>))
    } catch (e) {
      caughtError = e as Error
    }

    expect(caughtError).toBeNull()

    // Then: Text parts before and after unknown event are processed normally
    const textDeltas = chunks.filter(c => c.type === 'text-delta') as any[]
    expect(textDeltas.length).toBe(2)
    expect(textDeltas[0].delta).toBe('Hello')
    expect(textDeltas[1].delta).toBe(' world')

    // Then: Stream completes successfully
    const finish = chunks.find(c => c.type === 'finish')
    expect(finish).toBeDefined()
  })
})

describe('test-unit-verify-output-sequence: Output sequence verification helpers', () => {
  /**
   * TestSpecification: test-unit-verify-output-sequence
   * Given: Helper function collectChunks(generator) that collects all yielded chunks into array
   * When: Tests run processInterleavedStream with mock input
   * Then:
   *   - Can assert exact sequence of chunk types
   *   - Can verify IDs match within related chunks
   *   - Can check chunk payloads match expected values
   */
  test('tests can verify exact chunk types and IDs in output sequence', async () => {
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: 'Test' },
      { type: 'tool-input-start', id: 'tool-1', toolName: 'testTool' },
      { type: 'tool-call', toolCallId: 'tool-1', toolName: 'testTool', input: { key: 'value' } } as any,
      { type: 'tool-result', toolCallId: 'tool-1', toolName: 'testTool', input: { key: 'value' }, output: 'output' } as any,
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Then: Can assert exact sequence of chunk types
    const typeSequence = chunks.map(c => c.type)
    expect(typeSequence).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'finish'
    ])

    // Then: Can verify IDs match within related chunks
    const textStart = chunks.find(c => c.type === 'text-start') as any
    const textDelta = chunks.find(c => c.type === 'text-delta') as any
    const textEnd = chunks.find(c => c.type === 'text-end') as any
    expect(textStart.id).toBe(textDelta.id)
    expect(textDelta.id).toBe(textEnd.id)

    const toolStart = chunks.find(c => c.type === 'tool-input-start') as any
    const toolInput = chunks.find(c => c.type === 'tool-input-available') as any
    const toolOutput = chunks.find(c => c.type === 'tool-output-available') as any
    expect(toolStart.toolCallId).toBe(toolInput.toolCallId)
    expect(toolInput.toolCallId).toBe(toolOutput.toolCallId)

    // Then: Can check chunk payloads match expected values
    expect(textDelta.delta).toBe('Test')
    expect(toolStart.toolName).toBe('testTool')
    expect(toolInput.input).toEqual({ key: 'value' })
    expect(toolOutput.output).toBe('output')
  })
})

// =============================================================================
// Original Integration-style Tests (preserved from initial implementation)
// =============================================================================

describe('interleaved stream scenarios', () => {
  test('text -> tool -> text yields two distinct text parts with different segment IDs', async () => {
    // This tests the core interleaving preservation
    const events: TestTextStreamPart[] = [
      // First text segment
      { type: 'text-delta', id: 'sdk-text-1', text: 'Before tool: ' },
      // Tool call
      { type: 'tool-input-start', id: 'tool-call-1', toolName: 'calculator' },
      { type: 'tool-call', toolCallId: 'tool-call-1', toolName: 'calculator', input: { x: 5 } } as any,
      { type: 'tool-result', toolCallId: 'tool-call-1', toolName: 'calculator', input: { x: 5 }, output: 10 } as any,
      // Second text segment
      { type: 'text-delta', id: 'sdk-text-2', text: 'After tool: result is 10' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Verify we have two distinct text segments
    const textStarts = chunks.filter(c => c.type === 'text-start') as any[]
    expect(textStarts.length).toBe(2)

    // Verify the IDs are different
    expect(textStarts[0].id).not.toBe(textStarts[1].id)

    // Verify the sequence: text-start, text-delta, text-end, tool events, text-start, text-delta, text-end, finish
    const typeSequence = chunks.map(c => c.type)

    // First text segment
    expect(typeSequence.indexOf('text-start')).toBe(0)
    expect(typeSequence.indexOf('text-end')).toBeLessThan(typeSequence.indexOf('tool-input-start'))

    // Second text segment starts after tool events
    const secondTextStartIndex = typeSequence.lastIndexOf('text-start')
    expect(secondTextStartIndex).toBeGreaterThan(typeSequence.indexOf('tool-output-available'))
  })

  test('multiple sequential tools without text are handled correctly', async () => {
    const events: TestTextStreamPart[] = [
      // Tool 1
      { type: 'tool-input-start', id: 'tool-1', toolName: 'tool1' },
      { type: 'tool-call', toolCallId: 'tool-1', toolName: 'tool1', input: {} } as any,
      { type: 'tool-result', toolCallId: 'tool-1', toolName: 'tool1', input: {}, output: 'r1' } as any,
      // Tool 2
      { type: 'tool-input-start', id: 'tool-2', toolName: 'tool2' },
      { type: 'tool-call', toolCallId: 'tool-2', toolName: 'tool2', input: {} } as any,
      { type: 'tool-result', toolCallId: 'tool-2', toolName: 'tool2', input: {}, output: 'r2' } as any,
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Verify no text parts (no text-delta events)
    const textStarts = chunks.filter(c => c.type === 'text-start')
    expect(textStarts.length).toBe(0)

    // Verify both tools are processed
    const toolStarts = chunks.filter(c => c.type === 'tool-input-start') as any[]
    expect(toolStarts.length).toBe(2)
    expect(toolStarts[0].toolCallId).toBe('tool-1')
    expect(toolStarts[1].toolCallId).toBe('tool-2')

    const toolResults = chunks.filter(c => c.type === 'tool-output-available') as any[]
    expect(toolResults.length).toBe(2)
  })

  test('empty text delta does not create spurious text parts', async () => {
    const events: TestTextStreamPart[] = [
      { type: 'text-delta', id: 'sdk-text-1', text: '' }, // Empty delta
      { type: 'text-delta', id: 'sdk-text-1', text: 'Hello' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: createUsage() }
    ]

    const stream = createMockStream(events)
    const chunks = await collectChunks(processInterleavedStream(stream))

    // Only one text-start should be created (empty delta shouldn't create one if first)
    const textStarts = chunks.filter(c => c.type === 'text-start')
    expect(textStarts.length).toBe(1)

    // Both deltas should be yielded (even empty ones, after text-start)
    const textDeltas = chunks.filter(c => c.type === 'text-delta')
    expect(textDeltas.length).toBeGreaterThanOrEqual(1)
  })
})
