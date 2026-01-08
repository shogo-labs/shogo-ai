import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamText, type ModelMessage } from 'ai'
import { createClaudeCode } from 'ai-sdk-provider-claude-code'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { auth } from './auth'
import { PHASE_PROMPTS, isPhase, type Phase } from './prompts/phase-prompts'

/**
 * Convert UIMessage format (from @ai-sdk/react v3) to CoreMessage format (for streamText).
 *
 * UIMessage uses `parts` array: { parts: [{ type: "text", text: "..." }], role, id }
 * CoreMessage uses `content` string: { role, content: "..." }
 *
 * chat-session-sync-fix: Required because v3 sendMessage() sends UIMessage format,
 * but streamText() expects CoreMessage format.
 */
function convertUIMessagesToCoreMessages(messages: any[]): ModelMessage[] {
  return messages.map((msg) => {
    // If message already has content string (CoreMessage format), pass through
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content }
    }

    // If message has parts array (UIMessage format), extract text content
    if (Array.isArray(msg.parts)) {
      const textContent = msg.parts
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join('')
      return { role: msg.role, content: textContent }
    }

    // Fallback: return as-is (may fail validation, but better than silent data loss)
    return { role: msg.role, content: msg.content ?? '' }
  })
}

// Port configuration from environment (supports multi-worktree isolation)
const API_PORT = parseInt(process.env.API_PORT || '8002', 10)
const VITE_PORT = parseInt(process.env.VITE_PORT || '3000', 10)

// Compute project root from this file's location
// This file is at: apps/api/src/server.ts
// Project root is 3 levels up
const __filename = fileURLToPath(import.meta.url)
const PROJECT_ROOT = resolve(__filename, '../../../../')

// Create Claude Code provider scoped to this project
// This enables:
// - .claude/skills/ from the project  
// - .mcp.json MCP servers (wavesmith)
// - Project-specific settings
const claudeCode = createClaudeCode({
  defaultSettings: {
    // Set working directory to project root
    cwd: PROJECT_ROOT,
    // Load project settings (picks up .claude/skills, .mcp.json, etc.)
    settingSources: ['project', 'local'],
    // Wavesmith MCP server - matches .mcp.json config
    mcpServers: {
      wavesmith: {
        command: 'bun',
        args: ['run', 'packages/mcp/src/server.ts'],
      },
    },
    // Allow MCP tools, file operations, and skill invocation
    allowedTools: [
      // File operations
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS',
      // Skill and agent tools (required for /platform-feature-* skills)
      'Skill', 'Task', 'Bash', 'TodoWrite',
      // Wavesmith MCP tools - Schema
      'mcp__wavesmith__schema_set',
      'mcp__wavesmith__schema_get',
      'mcp__wavesmith__schema_list',
      'mcp__wavesmith__schema_load',
      // Wavesmith MCP tools - Store
      'mcp__wavesmith__store_create',
      'mcp__wavesmith__store_list',
      'mcp__wavesmith__store_get',
      'mcp__wavesmith__store_update',
      'mcp__wavesmith__store_query',
      'mcp__wavesmith__store_models',
      'mcp__wavesmith__store_delete',
      // Wavesmith MCP tools - Views
      'mcp__wavesmith__view_execute',
      'mcp__wavesmith__view_define',
      'mcp__wavesmith__view_project',
      // Wavesmith MCP tools - Data & DDL
      'mcp__wavesmith__data_load',
      'mcp__wavesmith__data_loadAll',
      'mcp__wavesmith__ddl_execute',
      'mcp__wavesmith__ddl_migrate',
      // Chrome DevTools MCP - Navigation & Pages
      'mcp__chrome-devtools__navigate_page',
      'mcp__chrome-devtools__new_page',
      'mcp__chrome-devtools__close_page',
      'mcp__chrome-devtools__select_page',
      'mcp__chrome-devtools__list_pages',
      'mcp__chrome-devtools__wait_for',
      'mcp__chrome-devtools__resize_page',
      // Chrome DevTools MCP - Input & Interaction
      'mcp__chrome-devtools__click',
      'mcp__chrome-devtools__fill',
      'mcp__chrome-devtools__fill_form',
      'mcp__chrome-devtools__hover',
      'mcp__chrome-devtools__press_key',
      'mcp__chrome-devtools__drag',
      'mcp__chrome-devtools__upload_file',
      'mcp__chrome-devtools__handle_dialog',
      // Chrome DevTools MCP - Inspection & Debugging
      'mcp__chrome-devtools__take_screenshot',
      'mcp__chrome-devtools__take_snapshot',
      'mcp__chrome-devtools__evaluate_script',
      'mcp__chrome-devtools__list_console_messages',
      'mcp__chrome-devtools__get_console_message',
      // Chrome DevTools MCP - Network
      'mcp__chrome-devtools__list_network_requests',
      'mcp__chrome-devtools__get_network_request',
      'mcp__chrome-devtools__emulate',
      // Chrome DevTools MCP - Performance
      'mcp__chrome-devtools__performance_start_trace',
      'mcp__chrome-devtools__performance_stop_trace',
      'mcp__chrome-devtools__performance_analyze_insight',
    ],
    // Bypass permission prompts for non-interactive API use
    permissionMode: 'bypassPermissions',
  },
})

/**
 * Base system prompt for the Wavesmith app builder assistant.
 * This prompt is always included and provides context about available MCP tools.
 */
export const BASE_SYSTEM_PROMPT = `You are a Wavesmith app builder assistant running in the shogo-ai project at ${PROJECT_ROOT}.

You have access to the Wavesmith MCP server with these tools:
- schema_set, schema_get, schema_list, schema_load - Manage JSON schemas
- store_create, store_list, store_get, store_update, store_query - CRUD operations on entities
- store_models - List available models in a schema
- data_load, data_loadAll - Load data from persistence

You can help users:
- Design and create data schemas for their applications
- Create and manage entity instances
- Query and update data
- Explain data modeling concepts and best practices

When users ask to create schemas or data, use the appropriate MCP tools.
Be concise and practical. Show tool results when relevant.`

/**
 * Build a dynamic system prompt based on the current pipeline phase.
 *
 * @param phase - The current pipeline phase, or null/undefined for generic prompt
 * @returns The complete system prompt with base prompt and optional phase-specific guidance
 */
export function buildSystemPrompt(phase: Phase | null | undefined): string {
  // Always start with the base Wavesmith tool prompt
  let systemPrompt = BASE_SYSTEM_PROMPT

  // Add phase-specific guidance if a valid phase is provided
  if (phase && isPhase(phase)) {
    systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${PHASE_PROMPTS[phase]}`
  }

  return systemPrompt
}

const app = new Hono()

// Enable CORS for development (dynamic based on VITE_PORT)
app.use('/*', cors({
  origin: `http://localhost:${VITE_PORT}`,
  credentials: true,
}))

// Better Auth handler - mounted BEFORE other /api/* routes
// Handles all authentication endpoints: sign-up, sign-in, sign-out, session, OAuth callbacks, etc.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

// Health check
app.get('/api/health', (c) => c.json({ ok: true }))

/**
 * AI Chat endpoint using Vercel AI SDK with Claude Code provider
 * Streams Claude responses back to the client
 * Uses existing Claude Pro/Max subscription via Claude Code CLI
 * Scoped to project with access to local MCP server (wavesmith)
 *
 * Session Resume (task-cc-api-endpoint):
 * - Accepts optional `ccSessionId` in request body
 * - When provided, passes it as `resume` parameter to Claude Code
 * - This allows continuing previous Claude Code conversations
 */
app.post('/api/chat', async (c) => {
  try {
    const { messages, phase, ccSessionId } = await c.req.json()

    // Build dynamic system prompt based on current pipeline phase
    const systemPrompt = buildSystemPrompt(phase)

    // Pass resume parameter if ccSessionId provided (task-cc-api-endpoint)
    // This enables session continuity in Claude Code
    const modelSettings = ccSessionId ? { resume: ccSessionId } : {}

    // chat-session-sync-fix: Convert UIMessage format to CoreMessage format
    // v3 @ai-sdk/react sends UIMessage with parts array, but streamText expects CoreMessage with content string
    const coreMessages = convertUIMessagesToCoreMessages(messages)

    // chat-session-sync-fix: Send FULL message history every time
    // Claude Code handles deduplication internally via its session files
    // Old message-filtering logic was removed in favor of passing full array
    const result = streamText({
      // Type assertion for ai-sdk-provider-claude-code compatibility with ai@6
      model: claudeCode('sonnet', modelSettings) as Parameters<typeof streamText>[0]['model'],
      system: systemPrompt,
      messages: coreMessages,
    })

    // chat-session-sync-fix: Use toUIMessageStreamResponse() with messageMetadata callback
    // This enables real-time tool call visibility in the client via message.parts
    // Session ID flows through stream metadata (not blocking header extraction)
    return result.toUIMessageStreamResponse({
      messageMetadata: ({ part }) => {
        // Extract session ID from providerMetadata when available
        // Type assertion needed as TextStreamPart types don't include providerMetadata
        const sessionId = ((part as any).providerMetadata as Record<string, Record<string, unknown>> | undefined)?.['claude-code']?.sessionId
        return sessionId ? { ccSessionId: sessionId as string } : undefined
      },
    })
  } catch (error: any) {
    console.error('[/api/chat] Error:', error)
    return c.json({
      error: {
        message: error.message || 'Chat request failed',
        code: error.code || 'CHAT_ERROR',
      }
    }, 500)
  }
})

// Start server
console.log(`🚀 API server running on http://localhost:${API_PORT}`)
console.log(`   Chat endpoint: POST http://localhost:${API_PORT}/api/chat`)
console.log(`   CORS origin: http://localhost:${VITE_PORT}`)

export default {
  port: API_PORT,
  fetch: app.fetch,
}

