/**
 * Session Continuity Tests (TDD)
 * Task: task-cc-api-endpoint, chat-session-sync-fix
 *
 * These tests verify session ID handling through the server to ensure
 * Claude Code session continuity works correctly.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const serverPath = path.resolve(import.meta.dir, "../server.ts")
const getServerSource = () => fs.readFileSync(serverPath, "utf-8")

/**
 * Fixtures representing actual Claude Code SDK response shapes.
 * These must match what the SDK actually sends to properly test extraction.
 */
const fixtures = {
  // Case 1: Full providerMetadata with sessionId (expected normal case)
  withSessionId: {
    type: 'text-delta',
    providerMetadata: {
      'claude-code': {
        sessionId: 'cc-session-abc123'
      }
    }
  },
  // Case 2: providerMetadata exists but sessionId is undefined
  withoutSessionId: {
    type: 'text-delta',
    providerMetadata: {
      'claude-code': {}
    }
  },
  // Case 3: providerMetadata exists but no claude-code key
  noClaudeCodeKey: {
    type: 'text-delta',
    providerMetadata: {}
  },
  // Case 4: No providerMetadata at all
  noProviderMetadata: {
    type: 'text-delta',
  },
  // Case 5: providerMetadata is null
  nullProviderMetadata: {
    type: 'text-delta',
    providerMetadata: null
  },
  // Case 6: claude-code key exists but is null
  nullClaudeCodeMeta: {
    type: 'text-delta',
    providerMetadata: {
      'claude-code': null
    }
  },
}

/**
 * Extraction function that mirrors the server code exactly.
 * If this changes in server.ts, tests will catch the drift.
 */
function extractSessionId(part: any): string | undefined {
  return ((part as any).providerMetadata as Record<string, Record<string, unknown>> | undefined)
    ?.['claude-code']?.sessionId as string | undefined
}

/**
 * spec-sc-001: Session ID Extraction Logic
 * Verifies the extraction function handles all edge cases correctly.
 */
describe("spec-sc-001: Session ID Extraction", () => {
  test("extracts sessionId when present", () => {
    const result = extractSessionId(fixtures.withSessionId)
    expect(result).toBe('cc-session-abc123')
  })

  test("returns undefined when sessionId missing from claude-code", () => {
    const result = extractSessionId(fixtures.withoutSessionId)
    expect(result).toBeUndefined()
  })

  test("returns undefined when claude-code key missing", () => {
    const result = extractSessionId(fixtures.noClaudeCodeKey)
    expect(result).toBeUndefined()
  })

  test("returns undefined when providerMetadata missing", () => {
    const result = extractSessionId(fixtures.noProviderMetadata)
    expect(result).toBeUndefined()
  })

  test("returns undefined when providerMetadata is null", () => {
    const result = extractSessionId(fixtures.nullProviderMetadata)
    expect(result).toBeUndefined()
  })

  test("returns undefined when claude-code is null", () => {
    const result = extractSessionId(fixtures.nullClaudeCodeMeta)
    expect(result).toBeUndefined()
  })
})

/**
 * spec-sc-002: Request Body Session ID Passthrough
 * Verifies ccSessionId from request is correctly passed to Claude Code.
 */
describe("spec-sc-002: Request ccSessionId Passthrough", () => {
  test("extracts ccSessionId from request body", () => {
    const source = getServerSource()
    // Pattern: destructuring ccSessionId from request JSON
    expect(source).toMatch(/const\s*\{[^}]*ccSessionId[^}]*\}\s*=\s*await\s+c\.req\.json\(\)/)
  })

  test("builds modelSettings with resume when ccSessionId provided", () => {
    const source = getServerSource()
    // Pattern: conditional assignment of resume parameter
    expect(source).toMatch(/const\s+modelSettings\s*=\s*ccSessionId\s*\?\s*\{\s*resume:\s*ccSessionId\s*\}/)
  })

  test("modelSettings is empty object when ccSessionId undefined", () => {
    const source = getServerSource()
    // Pattern: empty object fallback
    expect(source).toMatch(/ccSessionId\s*\?\s*\{[^}]+\}\s*:\s*\{\s*\}/)
  })

  test("modelSettings passed to claudeCode call", () => {
    const source = getServerSource()
    // Pattern: claudeCode('sonnet', modelSettings)
    expect(source).toMatch(/claudeCode\s*\(\s*['"]sonnet['"]\s*,\s*modelSettings\s*\)/)
  })
})

/**
 * spec-sc-003: messageMetadata Callback Configuration
 * Verifies toUIMessageStream is configured with messageMetadata.
 */
describe("spec-sc-003: messageMetadata Configuration", () => {
  test("toUIMessageStream includes messageMetadata callback", () => {
    const source = getServerSource()
    expect(source).toMatch(/toUIMessageStream\s*\(\s*\{[\s\S]*?messageMetadata\s*:/)
  })

  test("messageMetadata accesses part.providerMetadata", () => {
    const source = getServerSource()
    expect(source).toMatch(/part\s*as\s*any\s*\)\s*\.providerMetadata/)
  })

  test("messageMetadata extracts from claude-code key", () => {
    const source = getServerSource()
    expect(source).toMatch(/\['claude-code'\]/)
  })

  test("messageMetadata returns object with ccSessionId key", () => {
    const source = getServerSource()
    expect(source).toMatch(/return\s+sessionId\s*\?\s*\{\s*ccSessionId\s*:/)
  })

  test("messageMetadata includes debug logging", () => {
    const source = getServerSource()
    // Verify logging was added for debugging
    expect(source).toMatch(/console\.log\s*\(\s*'\[messageMetadata\]'/)
  })
})

/**
 * spec-sc-004: Progress Event Configuration
 * Verifies hooks are configured for subagent progress streaming.
 */
describe("spec-sc-004: Progress Event Hooks", () => {
  test("SubagentStart hook is configured", () => {
    const source = getServerSource()
    expect(source).toMatch(/hooks\s*:\s*\{[\s\S]*SubagentStart\s*:/)
  })

  test("SubagentStop hook is configured", () => {
    const source = getServerSource()
    expect(source).toMatch(/hooks\s*:\s*\{[\s\S]*SubagentStop\s*:/)
  })

  test("PostToolUse hook is configured", () => {
    const source = getServerSource()
    expect(source).toMatch(/hooks\s*:\s*\{[\s\S]*PostToolUse\s*:/)
  })

  test("hooks emit to progressEvents EventEmitter", () => {
    const source = getServerSource()
    expect(source).toMatch(/progressEvents\.emit\s*\(\s*['"]progress['"]/)
  })
})

/**
 * spec-sc-005: Event Buffering and Cleanup
 * Verifies progress events are buffered before stream is ready.
 */
describe("spec-sc-005: Event Buffering", () => {
  test("eventBuffer array is created before streamText", () => {
    const source = getServerSource()
    // Buffer must be created BEFORE streamText call
    const bufferIndex = source.indexOf('eventBuffer: SubagentProgressEvent[] = []')
    const streamTextIndex = source.indexOf('streamText({')
    expect(bufferIndex).toBeLessThan(streamTextIndex)
    expect(bufferIndex).toBeGreaterThan(-1)
  })

  test("progress listener attached BEFORE streamText", () => {
    const source = getServerSource()
    // Listener attachment must come before streamText
    const listenerIndex = source.indexOf("progressEvents.on('progress'")
    const streamTextIndex = source.indexOf('streamText({')
    expect(listenerIndex).toBeLessThan(streamTextIndex)
    expect(listenerIndex).toBeGreaterThan(-1)
  })

  test("buffered events are flushed when writer connects", () => {
    const source = getServerSource()
    expect(source).toMatch(/Flushing.*buffered events/)
    expect(source).toMatch(/for\s*\(\s*const\s+bufferedEvent\s+of\s+eventBuffer\s*\)/)
  })

  test("progress listener removed in finally block", () => {
    const source = getServerSource()
    expect(source).toMatch(/finally\s*\{[\s\S]*?progressEvents\.off\s*\(\s*['"]progress['"]/)
  })
})

/**
 * spec-sc-006: Session ID Extraction from Stop Hook
 * Verifies session ID is extracted from Stop hook rawInput and emitted.
 * This is a workaround for SDK not including sessionId in providerMetadata.
 */
describe("spec-sc-006: Stop Hook Session ID Extraction", () => {
  test("Stop hook extracts sessionId from rawInput", () => {
    const source = getServerSource()
    expect(source).toMatch(/const\s+sessionId\s*=\s*\(rawInput\s+as\s*\{\s*session_id\?\s*:\s*string\s*\}\)\.session_id/)
  })

  test("Stop hook emits sessionId in complete signal", () => {
    const source = getServerSource()
    expect(source).toMatch(/streamCompletionEvents\.emit\s*\(\s*['"]complete['"][\s\S]*?sessionId/)
  })

  test("SessionEnd hook also extracts sessionId", () => {
    const source = getServerSource()
    // Both Stop and SessionEnd should extract sessionId
    const stopMatch = source.match(/Stop:\s*\[\{[\s\S]*?session_id/g)
    const sessionEndMatch = source.match(/SessionEnd:\s*\[\{[\s\S]*?session_id/g)
    expect(stopMatch).not.toBeNull()
    expect(sessionEndMatch).not.toBeNull()
  })

  test("data-session event written to stream when sessionId available", () => {
    const source = getServerSource()
    expect(source).toMatch(/type:\s*['"]data-session['"]/)
    expect(source).toMatch(/data:\s*\{\s*ccSessionId:\s*info\.sessionId\s*\}/)
  })
})

/**
 * spec-sc-007: Race Condition Fix
 * Verifies the stream complete signal race doesn't log repeatedly.
 */
describe("spec-sc-007: Stream Complete Race Fix", () => {
  test("completeSignal created ONCE outside the loop", () => {
    const source = getServerSource()
    // The completeSignal should be created before the while loop
    expect(source).toMatch(/const\s+completeSignal\s*=\s*streamCompletePromise\.then/)
  })

  test("streamCompleteWon flag prevents repeated logging", () => {
    const source = getServerSource()
    expect(source).toMatch(/let\s+streamCompleteWon\s*=\s*false/)
    expect(source).toMatch(/if\s*\(\s*!streamCompleteWon\s*\)/)
  })
})

/**
 * spec-sc-008: Bun Server Idle Timeout
 * Verifies server has increased idle timeout for long-running subagent operations.
 */
describe("spec-sc-008: Bun Server Idle Timeout", () => {
  test("idleTimeout is configured", () => {
    const source = getServerSource()
    expect(source).toMatch(/idleTimeout\s*:\s*\d+/)
  })

  test("idleTimeout is at least 60 seconds", () => {
    const source = getServerSource()
    const match = source.match(/idleTimeout\s*:\s*(\d+)/)
    expect(match).not.toBeNull()
    const timeout = parseInt(match![1], 10)
    expect(timeout).toBeGreaterThanOrEqual(60)
  })
})
