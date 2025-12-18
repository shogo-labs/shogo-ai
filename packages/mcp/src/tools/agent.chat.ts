import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { query } from '@anthropic-ai/claude-agent-sdk'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// Compute monorepo root from this file's location
// This file is at: packages/mcp/src/tools/agent.chat.ts
// Monorepo root is 4 levels up
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MONOREPO_ROOT = resolve(__dirname, '../../../../')

const Params = t({
  message: "string",
  "sessionId?": "string",
})

export function registerAgentChat(server: FastMCP) {
  server.addTool({
    name: "agent.chat",
    description: "Multi-turn conversational agent for app building. Supports discovery, schema generation, and iterative refinement. Pass sessionId from previous response to continue conversation.",
    parameters: Params,
    annotations: { streamingHint: true },  // Advisory hint that this tool streams
    execute: async (args: any, context) => {
      const { message, sessionId: providedSessionId } = args as {
        message: string
        sessionId?: string
      }

      try {
        // Validate message
        if (!message || message.trim().length === 0) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "INVALID_MESSAGE",
              message: "Message must be a non-empty string"
            }
          })
        }

        // Generate response via Claude agent with streaming
        const result = await generateChatResponseStreaming(message, providedSessionId, context)

        // Return full result including accumulated response text
        return JSON.stringify({
          ok: true,
          sessionId: result.sessionId,
          response: result.response,
          toolCalls: result.toolCalls,
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: error.code || "CHAT_ERROR",
            message: error.message || "Failed to process chat message"
          }
        })
      }
    }
  })
}

interface StreamingChatResult {
  sessionId: string
  response: string  // Accumulated text from streaming
  toolCalls: Array<{ tool: string, args: any, result?: string }>
}

/**
 * Generate a conversational response using Claude agent with streaming.
 * Text deltas are emitted via context.streamContent() for real-time display.
 * Skills are loaded from .claude/skills/ via settingSources.
 */
async function generateChatResponseStreaming(
  message: string,
  sessionId: string | undefined,
  context: any
): Promise<StreamingChatResult> {
  // Use computed monorepo root (reliable regardless of where server was started)
  const wavesmithPath = MONOREPO_ROOT

  console.log('[agent.chat] Starting with message:', message.slice(0, 100))

  // Build options - skills loaded via settingSources
  const options: any = {
    cwd: wavesmithPath,
    systemPrompt: `You are a Wavesmith app builder assistant. You help users create schemas and manage data using the available MCP tools.

IMPORTANT CONSTRAINTS:
- You must NEVER call the 'agent_chat' or 'mcp__wavesmith__agent_chat' tool. This would create infinite recursion.
- Use the schema and store tools directly to accomplish tasks:
  - mcp__wavesmith__schema_set: Create or update schemas
  - mcp__wavesmith__schema_load: Load existing schemas
  - mcp__wavesmith__store_create: Create entity instances
  - mcp__wavesmith__store_list: Query entities
  - mcp__wavesmith__store_update: Update entities
- Handle all requests directly with these tools. Do not delegate to another agent.`,
    settingSources: ["user", "project"],  // Load skills from .claude/skills/
    includePartialMessages: true,  // Enable token-level streaming via stream_event
    mcpServers: {
      wavesmith: {
        command: 'bun',
        args: ['packages/mcp/src/server.ts'],
        cwd: MONOREPO_ROOT,
        env: {}
      }
    },
    allowedTools: [
      'Skill',  // Enable skill invocation
      'mcp__wavesmith__schema_set',
      'mcp__wavesmith__schema_get',
      'mcp__wavesmith__schema_list',
      'mcp__wavesmith__schema_load',
      'mcp__wavesmith__store_create',
      'mcp__wavesmith__store_list',
      'mcp__wavesmith__store_get',
      'mcp__wavesmith__store_update',
      'mcp__wavesmith__data_load',
      'mcp__wavesmith__data_loadAll',
      'Read',
      'Glob',
      'Grep',
    ],
    permissionMode: 'bypassPermissions',
    maxTurns: 50
  }

  // Resume existing session if sessionId provided
  if (sessionId) {
    options.resume = sessionId
  }

  // DEBUG: Log full configuration to understand MCP server discovery
  console.log('[agent.chat] === DEBUG START ===')
  console.log('[agent.chat] MONOREPO_ROOT:', MONOREPO_ROOT)
  console.log('[agent.chat] wavesmithPath (cwd):', wavesmithPath)
  console.log('[agent.chat] settingSources:', options.settingSources)
  console.log('[agent.chat] mcpServers config:', JSON.stringify(options.mcpServers, null, 2))
  console.log('[agent.chat] Full options:', JSON.stringify({
    cwd: options.cwd,
    settingSources: options.settingSources,
    mcpServers: options.mcpServers,
    allowedTools: options.allowedTools,
    permissionMode: options.permissionMode
  }, null, 2))
  console.log('[agent.chat] === DEBUG END ===')

  console.log('[agent.chat] Creating query stream...')
  let stream
  try {
    stream = query({
      prompt: message,
      options
    })
    console.log('[agent.chat] Query stream created successfully')
  } catch (queryError: any) {
    console.error('[agent.chat] Failed to create query stream:', queryError)
    throw queryError
  }

  let capturedSessionId: string | undefined
  const toolCalls: Array<{ tool: string, args: any, result?: string }> = []
  let accumulatedResponse = ''  // Accumulate streamed text for final response

  // Process stream messages
  let msgCount = 0
  console.log('[agent.chat] Starting to iterate stream...')
  for await (const msg of stream) {
    msgCount++

    // Log every message type and structure
    console.log(`[agent.chat] msg #${msgCount} type=${msg.type}`, JSON.stringify({
      type: msg.type,
      subtype: (msg as any).subtype,
      hasContent: !!(msg as any).content,
      hasMessage: !!(msg as any).message,
      hasEvent: !!(msg as any).event,
      keys: Object.keys(msg)
    }))

    // Capture session ID from init message
    if (msg.type === 'system' && (msg as any).subtype === 'init') {
      capturedSessionId = (msg as any).session_id
      console.log('[agent.chat] Captured session ID:', capturedSessionId)
    }

    // Handle stream_event messages (token-level deltas from includePartialMessages)
    if (msg.type === 'stream_event') {
      const event = (msg as any).event
      console.log('[agent.chat] stream_event:', JSON.stringify(event))
      if (event?.type === 'content_block_delta') {
        const delta = event.delta
        if (delta?.type === 'text_delta' && delta?.text) {
          console.log('[agent.chat] Streaming text delta:', delta.text.slice(0, 50))
          accumulatedResponse += delta.text
          await context.streamContent({
            type: "text",
            text: delta.text
          })
        }
      }
    }

    // Handle complete assistant messages (for tool_use tracking)
    if (msg.type === 'assistant') {
      const content = (msg as any).content || (msg as any).message?.content || []
      console.log('[agent.chat] assistant content blocks:', content.length)
      for (const block of content) {
        console.log('[agent.chat] block type:', block.type)
        if (block.type === 'tool_use') {
          toolCalls.push({
            tool: block.name,
            args: block.input,
          })
        }
        // Also stream text from assistant messages if no stream_event (fallback)
        if (block.type === 'text' && block.text) {
          console.log('[agent.chat] Streaming from assistant block:', block.text.slice(0, 50))
          accumulatedResponse += block.text
          await context.streamContent({
            type: "text",
            text: block.text
          })
        }
      }
    }

    // Capture tool results
    if (msg.type === 'user') {
      const content = (msg as any).content || (msg as any).message?.content || []
      for (const block of content) {
        if (block.type === 'tool_result' && toolCalls.length > 0) {
          const lastCall = toolCalls[toolCalls.length - 1]
          if (!lastCall.result) {
            lastCall.result = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content)
          }
        }
      }
    }

    // Check for errors
    if (msg.type === 'result') {
      console.log('[agent.chat] result subtype:', (msg as any).subtype)
      if ((msg as any).subtype !== 'success') {
        throw new Error(`Agent failed: ${(msg as any).subtype}`)
      }
    }
  }

  console.log('[agent.chat] Stream complete. Total messages:', msgCount)

  // Use provided sessionId if we didn't capture a new one (resumption case)
  const finalSessionId = capturedSessionId || sessionId

  if (!finalSessionId) {
    throw new Error('Failed to capture session ID')
  }

  return {
    sessionId: finalSessionId,
    response: accumulatedResponse,
    toolCalls,
  }
}
