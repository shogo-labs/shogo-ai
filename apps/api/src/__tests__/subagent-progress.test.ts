/**
 * Subagent Progress Streaming Tests (TDD RED phase)
 * Task: task-subagent-progress-streaming
 *
 * These tests verify the server configuration for streaming subagent
 * progress events through the chat SSE stream.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const serverPath = path.resolve(import.meta.dir, "../server.ts")
const getServerSource = () => fs.readFileSync(serverPath, "utf-8")

/**
 * spec-sps-001: Hook configuration tests
 * Verifies Claude Code provider has hooks configured for subagent lifecycle events.
 */
describe("spec-sps-001: Claude Code provider hooks", () => {
  test("configures SubagentStart hook", () => {
    const source = getServerSource()
    expect(source).toMatch(/hooks\s*:\s*\{[\s\S]*SubagentStart\s*:/)
  })

  test("configures SubagentStop hook", () => {
    const source = getServerSource()
    expect(source).toMatch(/hooks\s*:\s*\{[\s\S]*SubagentStop\s*:/)
  })

  test("configures PostToolUse hook", () => {
    const source = getServerSource()
    expect(source).toMatch(/hooks\s*:\s*\{[\s\S]*PostToolUse\s*:/)
  })
})

/**
 * spec-sps-002: Stream API tests
 * Verifies server uses createUIMessageStream for merged streaming.
 */
describe("spec-sps-002: createUIMessageStream usage", () => {
  test("imports createUIMessageStream from 'ai'", () => {
    const source = getServerSource()
    expect(source).toMatch(/import\s*\{[\s\S]*createUIMessageStream[\s\S]*\}\s*from\s*['"]ai['"]/)
  })

  test("imports createUIMessageStreamResponse from 'ai'", () => {
    const source = getServerSource()
    expect(source).toMatch(/import\s*\{[\s\S]*createUIMessageStreamResponse[\s\S]*\}\s*from\s*['"]ai['"]/)
  })

  test("returns createUIMessageStreamResponse", () => {
    const source = getServerSource()
    expect(source).toMatch(/return\s+createUIMessageStreamResponse\s*\(/)
  })
})

/**
 * spec-sps-003: EventEmitter pattern
 * Verifies server uses EventEmitter for progress event forwarding.
 */
describe("spec-sps-003: Progress event emitter", () => {
  test("imports EventEmitter", () => {
    const source = getServerSource()
    expect(source).toMatch(/import\s*\{?\s*EventEmitter\s*\}?\s*from\s*['"]events['"]/)
  })

  test("writes data-progress parts to stream", () => {
    const source = getServerSource()
    expect(source).toMatch(/type:\s*['"]data-progress['"]/)
  })
})

/**
 * spec-sps-004: Progress event types
 * Verifies progress events have correct type discriminators.
 */
describe("spec-sps-004: Progress event shape", () => {
  test("emits subagent-start type", () => {
    const source = getServerSource()
    expect(source).toMatch(/type:\s*['"]subagent-start['"]/)
  })

  test("emits subagent-stop type", () => {
    const source = getServerSource()
    expect(source).toMatch(/type:\s*['"]subagent-stop['"]/)
  })

  test("emits tool-complete type", () => {
    const source = getServerSource()
    expect(source).toMatch(/type:\s*['"]tool-complete['"]/)
  })
})
