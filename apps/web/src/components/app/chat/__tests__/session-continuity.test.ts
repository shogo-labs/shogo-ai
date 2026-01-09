/**
 * Client-Side Session Continuity Tests (TDD)
 * Task: chat-session-sync-fix, task-cc-api-endpoint
 *
 * These tests verify session ID handling in ChatPanel to ensure
 * Claude Code session continuity works correctly on the client side.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
const getComponentSource = () => fs.readFileSync(componentPath, "utf-8")

/**
 * Fixtures representing AI SDK v3 message shapes.
 * These must match what the SDK actually provides in onFinish.
 */
const fixtures = {
  // Case 1: Message with metadata containing ccSessionId
  withSessionId: {
    id: 'msg-1',
    role: 'assistant',
    content: 'Hello',
    parts: [{ type: 'text', text: 'Hello' }],
    metadata: {
      ccSessionId: 'cc-session-xyz789'
    }
  },
  // Case 2: Message with metadata but no ccSessionId
  withMetadataNoSession: {
    id: 'msg-2',
    role: 'assistant',
    content: 'Hello',
    parts: [{ type: 'text', text: 'Hello' }],
    metadata: {}
  },
  // Case 3: Message with undefined metadata
  noMetadata: {
    id: 'msg-3',
    role: 'assistant',
    content: 'Hello',
    parts: [{ type: 'text', text: 'Hello' }],
  },
  // Case 4: Message with null metadata
  nullMetadata: {
    id: 'msg-4',
    role: 'assistant',
    content: 'Hello',
    parts: [{ type: 'text', text: 'Hello' }],
    metadata: null
  },
}

/**
 * Extraction function that mirrors the client code exactly.
 * If this changes in ChatPanel.tsx, tests will catch the drift.
 */
function extractCcSessionId(message: any): string | undefined {
  return (message as any).metadata?.ccSessionId as string | undefined
}

/**
 * spec-csc-001: Client-Side Session ID Extraction
 * Verifies the extraction function handles all edge cases.
 */
describe("spec-csc-001: Client Session ID Extraction", () => {
  test("extracts ccSessionId when present in metadata", () => {
    const result = extractCcSessionId(fixtures.withSessionId)
    expect(result).toBe('cc-session-xyz789')
  })

  test("returns undefined when metadata exists but no ccSessionId", () => {
    const result = extractCcSessionId(fixtures.withMetadataNoSession)
    expect(result).toBeUndefined()
  })

  test("returns undefined when metadata is undefined", () => {
    const result = extractCcSessionId(fixtures.noMetadata)
    expect(result).toBeUndefined()
  })

  test("returns undefined when metadata is null", () => {
    const result = extractCcSessionId(fixtures.nullMetadata)
    expect(result).toBeUndefined()
  })
})

/**
 * spec-csc-002: Ref Update Timing
 * Verifies ccSessionIdRef is updated BEFORE async operations.
 */
describe("spec-csc-002: Ref Update Timing", () => {
  test("ref update occurs BEFORE await in onFinish", () => {
    const source = getComponentSource()
    // Find the ccSessionIdRef.current = newCcSessionId line
    const refUpdateIndex = source.indexOf('ccSessionIdRef.current = newCcSessionId')
    // Find the first await after the ref update
    const awaitIndex = source.indexOf('await studioChat.chatSessionCollection.updateOne')

    expect(refUpdateIndex).toBeGreaterThan(-1)
    expect(awaitIndex).toBeGreaterThan(-1)
    expect(refUpdateIndex).toBeLessThan(awaitIndex)
  })

  test("ref update happens BEFORE setCcSessionId state update", () => {
    const source = getComponentSource()
    // Find the sequence: refUpdate -> await -> setCcSessionId
    const refUpdateIndex = source.indexOf('ccSessionIdRef.current = newCcSessionId')
    const setStateIndex = source.indexOf('setCcSessionId(newCcSessionId)')

    expect(refUpdateIndex).toBeGreaterThan(-1)
    expect(setStateIndex).toBeGreaterThan(-1)
    expect(refUpdateIndex).toBeLessThan(setStateIndex)
  })

  test("CRITICAL comment documents race condition fix", () => {
    const source = getComponentSource()
    expect(source).toMatch(/CRITICAL:\s*Update ref BEFORE async operations/)
  })
})

/**
 * spec-csc-003: Error Recovery
 * Verifies ref is reverted on persistence failure.
 */
describe("spec-csc-003: Error Recovery", () => {
  test("ref is reverted in catch block on failure", () => {
    const source = getComponentSource()
    // Pattern: catch block that reverts the ref
    expect(source).toMatch(/catch\s*\([^)]*\)\s*\{[\s\S]*?ccSessionIdRef\.current\s*=\s*ccSessionId/)
  })

  test("catch block logs CRITICAL error", () => {
    const source = getComponentSource()
    expect(source).toMatch(/CRITICAL:\s*CC session ID persistence failed/)
  })
})

/**
 * spec-csc-004: sendMessage Uses Ref
 * Verifies sendMessage passes ccSessionIdRef.current in body.
 */
describe("spec-csc-004: sendMessage Session ID Source", () => {
  test("sendMessage body includes ccSessionId from ref", () => {
    const source = getComponentSource()
    // Pattern: body object with ccSessionId: ccSessionIdRef.current
    expect(source).toMatch(/body\s*:\s*\{[\s\S]*?ccSessionId\s*:\s*ccSessionIdRef\.current/)
  })

  test("sendMessage uses v3 API signature", () => {
    const source = getComponentSource()
    // Pattern: sendMessage({ text: ... }, { body: ... })
    expect(source).toMatch(/sendMessage\s*\(\s*\{[^}]*text\s*:[^}]*\}\s*,\s*\{[^}]*body\s*:/)
  })

  test("ccSessionIdRef.current logged before send", () => {
    const source = getComponentSource()
    // Verify logging includes ccSessionId for debugging
    // Pattern spans multiple lines: console.log(..., { ..., ccSessionId: ccSessionIdRef.current })
    expect(source).toMatch(/console\.log\s*\(\s*"\[ChatPanel\]\s+Calling\s+sendMessage/)
    expect(source).toMatch(/ccSessionId\s*:\s*ccSessionIdRef\.current/)
  })
})

/**
 * spec-csc-005: Session Initialization
 * Verifies session ID is properly initialized on load.
 */
describe("spec-csc-005: Session Initialization", () => {
  test("ccSessionIdRef declared as useRef", () => {
    const source = getComponentSource()
    expect(source).toMatch(/const\s+ccSessionIdRef\s*=\s*useRef/)
  })

  test("ccSessionIdRef typed as string | undefined", () => {
    const source = getComponentSource()
    // Pattern: useRef<string | undefined>(undefined)
    // Initially undefined, updated via onFinish callback
    expect(source).toMatch(/useRef\s*<\s*string\s*\|\s*undefined\s*>\s*\(\s*undefined\s*\)/)
  })
})

/**
 * spec-csc-006: onFinish Callback Configuration
 * Verifies onFinish extracts session ID from message.metadata.
 */
describe("spec-csc-006: onFinish Session Extraction", () => {
  test("onFinish destructures message from options", () => {
    const source = getComponentSource()
    // v3 API: onFinish receives options object with message property
    expect(source).toMatch(/onFinish\s*:\s*async\s*\(\s*\{\s*message\s*\}\s*\)/)
  })

  test("extracts ccSessionId from message.metadata", () => {
    const source = getComponentSource()
    expect(source).toMatch(/\(message\s*as\s*any\)\.metadata\?\.ccSessionId/)
  })

  test("logs metadata presence for debugging", () => {
    const source = getComponentSource()
    expect(source).toMatch(/hasMetadata\s*:\s*!!\s*\(message\s*as\s*any\)\.metadata/)
  })

  test("logs ccSessionId value for debugging", () => {
    const source = getComponentSource()
    expect(source).toMatch(/ccSessionId\s*:\s*\(message\s*as\s*any\)\.metadata\?\.ccSessionId/)
  })
})

/**
 * spec-csc-007: Guard Conditions
 * Verifies both newCcSessionId AND currentSessionId must be truthy.
 */
describe("spec-csc-007: Guard Conditions", () => {
  test("requires both newCcSessionId and currentSessionId", () => {
    const source = getComponentSource()
    // Pattern: if (newCcSessionId && currentSessionId)
    expect(source).toMatch(/if\s*\(\s*newCcSessionId\s*&&\s*currentSessionId\s*\)/)
  })
})

/**
 * spec-csc-008: Data-Session Event Handling
 * Verifies client handles data-session events from server (SDK workaround).
 */
describe("spec-csc-008: Data-Session Event Handling", () => {
  test("handles data-session part type", () => {
    const source = getComponentSource()
    expect(source).toMatch(/part\.type\s*===\s*['"]data-session['"]/)
  })

  test("extracts ccSessionId from data-session event", () => {
    const source = getComponentSource()
    expect(source).toMatch(/sessionData\.ccSessionId/)
  })

  test("updates ccSessionIdRef from data-session", () => {
    const source = getComponentSource()
    // Pattern: ccSessionIdRef.current = sessionData.ccSessionId
    expect(source).toMatch(/ccSessionIdRef\.current\s*=\s*sessionData\.ccSessionId/)
  })

  test("calls setCcSessionId from data-session", () => {
    const source = getComponentSource()
    expect(source).toMatch(/setCcSessionId\s*\(\s*sessionData\.ccSessionId\s*\)/)
  })

  test("persists session ID from data-session event", () => {
    const source = getComponentSource()
    expect(source).toMatch(/studioChat\.chatSessionCollection\.updateOne[\s\S]*?claudeCodeSessionId:\s*sessionData\.ccSessionId/)
  })
})
