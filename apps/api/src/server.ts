import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamText } from 'ai'
import { createClaudeCode } from 'ai-sdk-provider-claude-code'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

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
    // Allow MCP tools and file operations
    allowedTools: [
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS',
      // Wavesmith MCP tools
      'mcp__wavesmith__schema_set',
      'mcp__wavesmith__schema_get',
      'mcp__wavesmith__schema_list',
      'mcp__wavesmith__schema_load',
      'mcp__wavesmith__store_create',
      'mcp__wavesmith__store_list',
      'mcp__wavesmith__store_get',
      'mcp__wavesmith__store_update',
      'mcp__wavesmith__store_query',
      'mcp__wavesmith__store_models',
      'mcp__wavesmith__data_load',
      'mcp__wavesmith__data_loadAll',
    ],
    // Bypass permission prompts for non-interactive API use
    permissionMode: 'bypassPermissions',
  },
})

const app = new Hono()

// Enable CORS for development (dynamic based on VITE_PORT)
app.use('/*', cors({
  origin: `http://localhost:${VITE_PORT}`,
  credentials: true,
}))

// Health check
app.get('/api/health', (c) => c.json({ ok: true }))

/**
 * AI Chat endpoint using Vercel AI SDK with Claude Code provider
 * Streams Claude responses back to the client
 * Uses existing Claude Pro/Max subscription via Claude Code CLI
 * Scoped to project with access to local MCP server (wavesmith)
 */
app.post('/api/chat', async (c) => {
  try {
    const { messages } = await c.req.json()

    // System prompt for the assistant - includes awareness of MCP tools
    const systemPrompt = `You are a Wavesmith app builder assistant running in the shogo-ai project at ${PROJECT_ROOT}.

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

    const result = streamText({
      model: claudeCode('sonnet'),
      system: systemPrompt,
      messages,
    })

    // Return the stream in text format for useChat hook with streamProtocol: 'text'
    return result.toTextStreamResponse()
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

