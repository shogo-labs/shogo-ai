/**
 * Integration test for agent.chat MCP tool
 *
 * This test validates that the agent.chat tool can:
 * 1. Accept a simple message
 * 2. Return a valid response with sessionId
 * 3. Include response text
 */

import { describe, test, expect } from "bun:test"
import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolve } from 'path'

const MONOREPO_ROOT = resolve(__dirname, '../../../../../')

describe("agent.chat integration", () => {
  test("responds to 'hey' message", async () => {
    const message = "hey"

    const options: any = {
      cwd: MONOREPO_ROOT,
      systemPrompt: `You are a helpful assistant. Respond briefly and friendly.`,
      maxTurns: 1,  // Single turn for simple test
      permissionMode: 'bypassPermissions',
    }

    const stream = query({
      prompt: message,
      options
    })

    let sessionId: string | undefined
    let responseText = ''
    const toolCalls: any[] = []

    for await (const msg of stream) {
      // Capture session ID
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id
      }

      // Capture streamed text deltas
      if (msg.type === 'stream_event') {
        const event = (msg as any).event
        if (event?.type === 'content_block_delta') {
          const delta = event.delta
          if (delta?.type === 'text_delta' && delta?.text) {
            responseText += delta.text
          }
        }
      }

      // Capture text from assistant messages (fallback)
      if (msg.type === 'assistant') {
        const content = (msg as any).content || (msg as any).message?.content || []
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            responseText += block.text
          }
          if (block.type === 'tool_use') {
            toolCalls.push({
              tool: block.name,
              args: block.input,
            })
          }
        }
      }

      // Check for success
      if (msg.type === 'result') {
        expect((msg as any).subtype).toBe('success')
      }
    }

    // Validate response
    expect(sessionId).toBeDefined()
    expect(sessionId).toBeString()
    expect(responseText.length).toBeGreaterThan(0)

    console.log('Session ID:', sessionId)
    console.log('Response:', responseText)
    console.log('Tool calls:', toolCalls.length)
  }, 60000)  // 60 second timeout for API call
})
