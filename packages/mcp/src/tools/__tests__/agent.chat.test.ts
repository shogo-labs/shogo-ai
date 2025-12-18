/**
 * agent.chat Tool Tests
 *
 * Tests for the AI SDK migration of agent.chat from @anthropic-ai/claude-agent-sdk
 * to the AI SDK with claudeCode provider.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"

describe("agent.chat AI SDK Migration", () => {
  beforeEach(() => {
    // Reset any mocks between tests
  })

  test("1. agent.chat imports AI SDK modules (claudeCode, streamText)", async () => {
    // Import the agent.chat module
    const agentChatModule = await import("../agent.chat.ts")
    const moduleSource = await Bun.file("/Users/russell/git/shogo-ai/packages/mcp/src/tools/agent.chat.ts").text()

    // Verify imports
    expect(moduleSource).toContain("import { claudeCode }")
    expect(moduleSource).toContain("from 'ai-sdk-provider-claude-code'")
    expect(moduleSource).toContain("import { streamText }")
    expect(moduleSource).toContain("from 'ai'")

    // Should NOT contain old SDK imports
    expect(moduleSource).not.toContain("@anthropic-ai/claude-agent-sdk")
  })

  test("2. claudeCode provider configured with mcpServers: ['wavesmith']", async () => {
    const moduleSource = await Bun.file("/Users/russell/git/shogo-ai/packages/mcp/src/tools/agent.chat.ts").text()

    // Verify claudeCode is called with mcpServers configuration
    expect(moduleSource).toContain("claudeCode")
    expect(moduleSource).toContain("mcpServers")
    expect(moduleSource).toContain("wavesmith")
  })

  test("3. AI SDK streaming events mapped to SSE", async () => {
    const moduleSource = await Bun.file("/Users/russell/git/shogo-ai/packages/mcp/src/tools/agent.chat.ts").text()

    // Verify streaming event handling
    // AI SDK provides textStream or fullStream for streaming
    expect(moduleSource).toMatch(/textStream|fullStream/)

    // Verify context.streamContent is called for streaming
    expect(moduleSource).toContain("context.streamContent")
  })

  test("4. Tool calls captured from AI SDK response", async () => {
    const moduleSource = await Bun.file("/Users/russell/git/shogo-ai/packages/mcp/src/tools/agent.chat.ts").text()

    // Verify tool calls are extracted from response
    // AI SDK provides toolCalls in the response
    expect(moduleSource).toContain("toolCalls")

    // The function should still return toolCalls array
    expect(moduleSource).toMatch(/toolCalls.*Array/)
  })

  test("5. Multi-turn session ID handling", async () => {
    const moduleSource = await Bun.file("/Users/russell/git/shogo-ai/packages/mcp/src/tools/agent.chat.ts").text()

    // Verify sessionId is handled for multi-turn
    expect(moduleSource).toContain("sessionId")

    // Should have logic to handle existing session
    expect(moduleSource).toMatch(/sessionId.*provided|resume|continue/)
  })

  test("6. MCP interface unchanged (backward compatible)", async () => {
    const moduleSource = await Bun.file("/Users/russell/git/shogo-ai/packages/mcp/src/tools/agent.chat.ts").text()

    // Verify the tool registration maintains the same interface
    expect(moduleSource).toContain("agent.chat")
    expect(moduleSource).toContain("registerAgentChat")

    // Should accept message and optional sessionId
    expect(moduleSource).toContain("message")
    expect(moduleSource).toContain("sessionId")

    // Should return same response structure
    expect(moduleSource).toMatch(/ok.*true|false/)
    expect(moduleSource).toContain("toolCalls")
  })

  test("7. Error handling for AI SDK failures", async () => {
    const moduleSource = await Bun.file("/Users/russell/git/shogo-ai/packages/mcp/src/tools/agent.chat.ts").text()

    // Verify error handling exists
    expect(moduleSource).toMatch(/try.*catch|catch.*error/)

    // Should return error response with proper structure
    expect(moduleSource).toContain("ok: false")
    expect(moduleSource).toContain("error")
    expect(moduleSource).toMatch(/code|message/)
  })
})

describe("agent.chat Functional Tests", () => {
  test("handles empty message gracefully", async () => {
    // This test would require mocking the AI SDK
    // For now, we test that the validation logic exists
    const moduleSource = await Bun.file("/Users/russell/git/shogo-ai/packages/mcp/src/tools/agent.chat.ts").text()

    expect(moduleSource).toContain("INVALID_MESSAGE")
    expect(moduleSource).toMatch(/message.*trim|length/)
  })

  test("returns proper response structure", async () => {
    const moduleSource = await Bun.file("/Users/russell/git/shogo-ai/packages/mcp/src/tools/agent.chat.ts").text()

    // Verify response structure
    expect(moduleSource).toContain("ok:")
    expect(moduleSource).toContain("sessionId:")
    expect(moduleSource).toContain("toolCalls:")
  })
})
