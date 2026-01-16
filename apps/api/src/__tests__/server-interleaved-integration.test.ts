/**
 * Server Integration Tests for Interleaved Stream Processing
 *
 * Tests for task-server-integration: Validates that processInterleavedStream
 * is properly integrated into server.ts execute callback.
 *
 * Feature: chat-tool-interleaving-stream-processor
 * Task: task-server-integration
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { resolve } from 'path'
import { readFileSync } from 'fs'

// =============================================================================
// Test Context: Static Analysis of server.ts
// =============================================================================
// These tests verify the code structure and integration patterns in server.ts
// without needing to spin up the full server. They validate:
// 1. Import statement exists
// 2. Feature flag constant defined
// 3. Conditional code path for interleaved vs original
// 4. Rollback comments preserved

const SERVER_PATH = resolve(__dirname, '../server.ts')

function getServerSource(): string {
  return readFileSync(SERVER_PATH, 'utf-8')
}

// =============================================================================
// Test Suite: Server Import and Feature Flag
// =============================================================================

describe('Server imports processInterleavedStream from lib module', () => {
  // Test: test-server-import-processor
  test('Import statement for processInterleavedStream exists at top of file', () => {
    const source = getServerSource()

    // Check for import of processInterleavedStream from ./lib/interleaved-stream
    const importPattern = /import\s*\{[^}]*processInterleavedStream[^}]*\}\s*from\s*['"]\.\/lib\/interleaved-stream['"]/
    expect(source).toMatch(importPattern)
  })

  test('No import errors occur (TypeScript compiles successfully)', async () => {
    // This test validates that the module can be imported without errors
    // We do a dynamic import to test the actual resolution
    const serverModule = await import('../server')
    expect(serverModule).toBeDefined()
    expect(serverModule.default).toBeDefined()
  })
})

describe('Feature flag USE_INTERLEAVED_STREAM controls stream processing mode', () => {
  // Test: test-server-feature-flag
  test('USE_INTERLEAVED_STREAM constant is defined in execute callback', () => {
    const source = getServerSource()

    // Check for the feature flag constant definition
    // It should be defined inside the execute callback
    const flagPattern = /const\s+USE_INTERLEAVED_STREAM\s*=\s*(true|false)/
    expect(source).toMatch(flagPattern)
  })

  test('Conditional branch exists for flag value', () => {
    const source = getServerSource()

    // Check for if statement using the flag
    const conditionalPattern = /if\s*\(\s*USE_INTERLEAVED_STREAM\s*\)/
    expect(source).toMatch(conditionalPattern)
  })
})

// =============================================================================
// Test Suite: for-await-of Loop with processInterleavedStream
// =============================================================================

describe('When flag enabled, for-await-of loop consumes processInterleavedStream', () => {
  // Test: test-server-for-await-loop
  test('for-await-of loop iterates over processInterleavedStream(result.fullStream, options)', () => {
    const source = getServerSource()

    // Check for for-await-of pattern with processInterleavedStream
    const forAwaitPattern = /for\s+await\s*\(\s*const\s+\w+\s+of\s+processInterleavedStream\s*\(\s*result\.fullStream/
    expect(source).toMatch(forAwaitPattern)
  })

  test('Options include getMessageMetadata callback', () => {
    const source = getServerSource()

    // Check that getMessageMetadata is defined in the interleavedOptions object
    // which is then passed to processInterleavedStream
    const metadataPattern = /interleavedOptions\s*=\s*\{[^}]*getMessageMetadata/s
    expect(source).toMatch(metadataPattern)

    // Also verify processInterleavedStream is called with options
    const callPattern = /processInterleavedStream\s*\(\s*result\.fullStream\s*,\s*interleavedOptions\s*\)/
    expect(source).toMatch(callPattern)
  })
})

// =============================================================================
// Test Suite: Promise.race for Completion Signal
// =============================================================================

describe('for-await-of loop is wrapped in Promise.race against streamCompletePromise', () => {
  // Test: test-server-completion-signal-race
  test('Promise.race is used with streamCompletePromise', () => {
    const source = getServerSource()

    // The pattern uses an async wrapper function that races against completion
    // Look for the race pattern in the interleaved stream section
    const racePattern = /Promise\.race/
    expect(source).toMatch(racePattern)

    // Also check that streamCompletePromise is involved
    expect(source).toContain('streamCompletePromise')
  })

  test('Loop breaks cleanly when completion signal fires', () => {
    const source = getServerSource()

    // Check for handling of completion signal win in the race
    // The interleaved stream uses a discriminated union pattern (type: 'completion-signal')
    // instead of a break statement since it uses Promise.race with an async IIFE
    const completionHandlingPattern = /raceResult\.type\s*===\s*['"]completion-signal['"]/
    expect(source).toMatch(completionHandlingPattern)

    // Also verify the log message indicates breaking due to completion
    const breakLogPattern = /Loop breaking due to completion signal/
    expect(source).toMatch(breakLogPattern)
  })
})

// =============================================================================
// Test Suite: Cleanup and try-finally
// =============================================================================

describe('try-finally ensures cleanup runs regardless of exit path', () => {
  // Test: test-server-completion-signal-race (cleanup part)
  test('finally block exists in execute callback', () => {
    const source = getServerSource()

    // Check for finally block in the execute callback context
    // The finally block contains cleanup code including progressEvents.off
    // Use a more flexible pattern that allows nested braces
    const finallyPattern = /finally\s*\{[\s\S]*?progressEvents\.off/
    expect(source).toMatch(finallyPattern)
  })
})

// =============================================================================
// Test Suite: Progress and Virtual Tool Events Unchanged
// =============================================================================

describe('Progress events (data-progress) continue to work unchanged', () => {
  // Test: test-server-progress-events
  test('Progress events still use direct writer.write()', () => {
    const source = getServerSource()

    // Check that data-progress events are still written directly
    const progressPattern = /writer\.write\s*\(\s*\{[^}]*type:\s*['"]data-progress['"]/s
    expect(source).toMatch(progressPattern)
  })
})

describe('Virtual tool events (data-virtual-tool) continue to work unchanged', () => {
  // Test: test-server-virtual-tool-events
  test('Virtual tool events still use direct writer.write()', () => {
    const source = getServerSource()

    // Check that data-virtual-tool events are still written directly
    const virtualToolPattern = /writer\.write\s*\(\s*\{[^}]*type:\s*['"]data-virtual-tool['"]/s
    expect(source).toMatch(virtualToolPattern)
  })
})

// =============================================================================
// Test Suite: Rollback Capability
// =============================================================================

describe('Original toUIMessageStream code preserved in comments for rollback', () => {
  // Test: test-server-rollback-code-preserved
  test('Rollback comments exist with original toUIMessageStream() code', () => {
    const source = getServerSource()

    // Check for rollback marker comments
    const rollbackPattern = /\/\/\s*ROLLBACK:\s*Original\s+toUIMessageStream\s+implementation/i
    expect(source).toMatch(rollbackPattern)
  })

  test('Original toUIMessageStream() call is preserved in else branch for rollback', () => {
    const source = getServerSource()

    // Check that the original toUIMessageStream() code exists in the else branch
    // (not commented out, but gated by USE_INTERLEAVED_STREAM = false)
    // The rollback comment is a marker above the else block
    const rollbackSectionPattern = /ROLLBACK:\s*Original\s+toUIMessageStream[\s\S]*toUIMessageStream\s*\(/i
    expect(source).toMatch(rollbackSectionPattern)
  })
})

describe('Setting USE_INTERLEAVED_STREAM = false restores original behavior', () => {
  // Test: test-server-flag-false-restores
  test('else branch contains original toUIMessageStream() path', () => {
    const source = getServerSource()

    // Check for else branch with toUIMessageStream
    // The pattern should show the conditional structure
    const elseBranchPattern = /else\s*\{[^}]*toUIMessageStream/s
    expect(source).toMatch(elseBranchPattern)
  })
})
