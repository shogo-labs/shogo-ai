import { Hono } from 'hono'
import { cors } from 'hono/cors'
import Stripe from 'stripe'
import { streamText, generateText, createUIMessageStream, createUIMessageStreamResponse, type ModelMessage } from 'ai'
import { z } from 'zod'
import { EventEmitter } from 'events'
import type { SubagentProgressEvent, VirtualToolEvent } from './types/progress'
// isVirtualTool kept in types/progress.ts for client-side use (ChatPanel handler)
import type { SubagentStartHookInput, SubagentStopHookInput, PostToolUseHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeCode, createSdkMcpServer, tool as sdkTool } from 'ai-sdk-provider-claude-code'
import { createAnthropic } from '@ai-sdk/anthropic'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { auth } from './auth'
import { PHASE_PROMPTS, isPhase, type Phase } from './prompts/phase-prompts'
import { getPriceId } from './config/stripe-prices'
import { processInterleavedStream, finalizeCurrentText } from './lib/interleaved-stream'
import { billingDomain } from '@shogo/state-api/billing/domain'
import { studioCoreDomain } from '@shogo/state-api/studio-core/domain'
import { BunPostgresExecutor } from '@shogo/state-api/query/execution/bun-postgres'
import { createBackendRegistry } from '@shogo/state-api/query/registry'
import { SqlBackend } from '@shogo/state-api/query/backends/sql'
import { NullPersistence } from '@shogo/state-api/persistence/null'
import { publishRoutes } from './routes/publish'

// Billing domain store singleton for webhook handling
let billingStore: ReturnType<typeof billingDomain.createStore> | null = null

// Studio core domain store singleton for project operations
let studioCoreStore: ReturnType<typeof studioCoreDomain.createStore> | null = null

async function getBillingStore(): Promise<ReturnType<typeof billingDomain.createStore>> {
  if (billingStore) {
    return billingStore
  }

  const DATABASE_URL = process.env.DATABASE_URL
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required")
  }

  const isSupabase = DATABASE_URL.includes("supabase")
  const executor = new BunPostgresExecutor(DATABASE_URL, {
    tls: isSupabase,
    max: 5,
  })

  const registry = createBackendRegistry()
  const sqlBackend = new SqlBackend({ dialect: "pg", executor })
  registry.register("postgres", sqlBackend)
  registry.setDefault("postgres")

  billingStore = billingDomain.createStore({
    services: {
      persistence: new NullPersistence(),
      backendRegistry: registry,
    },
    context: {
      schemaName: "billing",
    },
  })

  return billingStore
}

async function getStudioCoreStore(): Promise<ReturnType<typeof studioCoreDomain.createStore>> {
  if (studioCoreStore) {
    return studioCoreStore
  }

  const DATABASE_URL = process.env.DATABASE_URL
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required")
  }

  const isSupabase = DATABASE_URL.includes("supabase")
  const executor = new BunPostgresExecutor(DATABASE_URL, {
    tls: isSupabase,
    max: 5,
  })

  const registry = createBackendRegistry()
  const sqlBackend = new SqlBackend({ dialect: "pg", executor })
  registry.register("postgres", sqlBackend)
  registry.setDefault("postgres")

  studioCoreStore = studioCoreDomain.createStore({
    services: {
      persistence: new NullPersistence(),
      backendRegistry: registry,
    },
    context: {
      schemaName: "studio-core",
    },
  })

  return studioCoreStore
}

/**
 * Parse a data URL to extract mediaType and base64 data.
 * Example: "data:image/png;base64,iVBORw0..." -> { mediaType: "image/png", base64Data: "iVBORw0..." }
 *
 * task-api-convert-images: Helper for image part conversion
 */
function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], base64Data: match[2] }
}

/**
 * Convert UIMessage format (from @ai-sdk/react v3) to CoreMessage format (for streamText).
 *
 * UIMessage uses `parts` array: { parts: [{ type: "text", text: "..." }], role, id }
 * CoreMessage uses `content` string or array: { role, content: "..." | Array<TextPart | ImagePart> }
 *
 * chat-session-sync-fix: Required because v3 sendMessage() sends UIMessage format,
 * but streamText() expects CoreMessage format.
 *
 * task-api-convert-images: Extended to handle file parts with image mediaTypes.
 * File parts with image/* mediaType are converted to ImagePart format for Claude API.
 */
function convertUIMessagesToCoreMessages(messages: any[]): ModelMessage[] {
  return messages.map((msg) => {
    // If message already has content string (CoreMessage format), pass through
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content }
    }

    // If message has parts array (UIMessage format), process all part types
    if (Array.isArray(msg.parts)) {
      const contentParts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mimeType: string }> = []

      for (const part of msg.parts) {
        if (part.type === 'text' && part.text) {
          // Text parts: extract text content
          contentParts.push({ type: 'text', text: part.text })
        } else if (part.type === 'file' && part.mediaType?.startsWith('image/')) {
          // File parts with image mediaType: convert to ImagePart
          // The url field contains the data URL (data:image/png;base64,...)
          const parsed = parseDataUrl(part.url || '')
          if (parsed) {
            contentParts.push({
              type: 'image',
              image: parsed.base64Data,
              mimeType: parsed.mimeType,
            })
          }
        }
        // Non-image file parts are gracefully ignored
      }

      // If we only have text parts, return as simple string (backward compatible)
      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        return { role: msg.role, content: contentParts[0].text }
      }

      // If we have mixed content or only images, return as array
      if (contentParts.length > 0) {
        return { role: msg.role, content: contentParts }
      }

      // Fallback: empty content
      return { role: msg.role, content: '' }
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

// Progress event emitter for streaming subagent updates (task-subagent-progress-streaming)
const progressEvents = new EventEmitter()

// Virtual tool event emitter for streaming client-side execution instructions
// (virtual-tools-domain Phase 0 PoC)
const virtualToolEvents = new EventEmitter()

// Stream completion event emitter - signals when parent agent finishes (fixes subagent hang)
// This is separate from progressEvents to avoid confusion between progress updates and completion signals
const streamCompletionEvents = new EventEmitter()

// Debug logging prefix for subagent progress
const LOG_PREFIX = '[SubagentProgress]'
const VT_LOG_PREFIX = '[VirtualTool]'

// Create SDK MCP server for virtual tools (in-process, call-site defined)
// These tools execute in our API server process and emit events for client-side effects
const virtualToolsServer = createSdkMcpServer({
  name: 'virtual-tools',
  version: '1.0.0',
  tools: [
    sdkTool(
      'navigate_to_phase',
      'Navigate the user to a different pipeline phase in the Shogo Studio UI. Use when user asks to go to a different phase like "take me to design" or "let\'s move to implementation".',
      {
        phase: z.enum(['discovery', 'analysis', 'classification', 'design', 'spec', 'testing', 'implementation', 'complete'])
          .describe('The target phase to navigate to'),
      },
      async (args) => {
        console.log(`${VT_LOG_PREFIX} 🎯 SDK tool handler executing:`, args)

        // Emit event for client-side execution
        const event: VirtualToolEvent = {
          type: 'virtual-tool-execute',
          toolUseId: `vt-${Date.now()}`,
          toolName: 'navigate_to_phase',
          args: args as Record<string, unknown>,
          timestamp: Date.now(),
        }
        virtualToolEvents.emit('virtual-tool', event)
        console.log(`${VT_LOG_PREFIX} ✅ Emitted virtual tool event`)

        return {
          content: [{
            type: 'text',
            text: `Navigation initiated to ${args.phase} phase`
          }]
        }
      }
    ),
    // set_workspace: Declaratively set workspace state (v2 architecture)
    // Client handler updates workspace Composition entity based on desired state
    // NOTE: Using z.any() for complex nested types to avoid SDK schema validation issues
    sdkTool(
      'set_workspace',
      'Set the workspace to a desired state. Describe what panels should be visible and how configured. Use for showing schemas, splitting layouts, or any workspace changes. Each panel has: slot (string: "main", "left", "right", "sidebar"), section (string: "DesignContainerSection", "WorkspaceBlankStateSection"), and optional config object (e.g., { schemaName: "platform-features" }).',
      {
        layout: z.enum(['single', 'split-h', 'split-v']).optional()
          .describe('Layout mode for the workspace'),
        panels: z.array(z.any())
          .describe('Array of panel objects with slot, section, and optional config'),
      },
      async (args) => {
        console.log(`${VT_LOG_PREFIX} 🎯 SDK tool handler executing set_workspace:`, args)

        const event: VirtualToolEvent = {
          type: 'virtual-tool-execute',
          toolUseId: `vt-${Date.now()}`,
          toolName: 'set_workspace',
          args: args as Record<string, unknown>,
          timestamp: Date.now(),
        }
        virtualToolEvents.emit('virtual-tool', event)
        console.log(`${VT_LOG_PREFIX} ✅ Emitted set_workspace virtual tool event`)

        return {
          content: [{
            type: 'text',
            text: `Workspace updated with ${args.panels?.length ?? 0} panel(s)`
          }]
        }
      }
    ),
    // execute: Generic domain operations (v2 architecture)
    // Client handler executes state operations across domain stores
    // NOTE: Using z.any() for complex nested types to avoid SDK schema validation issues
    sdkTool(
      'execute',
      'Execute state operations on the client. Use for creating/updating/deleting entities across domains. Each operation has: domain ("component-builder"|"studio-chat"|"platform-features"), action ("create"|"update"|"delete"), model (string like "Composition", "FeatureSession"), optional id (required for update/delete), and data object.',
      {
        operations: z.array(z.any())
          .describe('Array of operation objects with domain, action, model, optional id, and data'),
      },
      async (args) => {
        console.log(`${VT_LOG_PREFIX} 🎯 SDK tool handler executing execute:`, args)

        const event: VirtualToolEvent = {
          type: 'virtual-tool-execute',
          toolUseId: `vt-${Date.now()}`,
          toolName: 'execute',
          args: args as Record<string, unknown>,
          timestamp: Date.now(),
        }
        virtualToolEvents.emit('virtual-tool', event)
        console.log(`${VT_LOG_PREFIX} ✅ Emitted execute virtual tool event`)

        return {
          content: [{
            type: 'text',
            text: `Executed ${args.operations?.length ?? 0} operation(s)`
          }]
        }
      }
    ),
  ]
})

// Create Claude Code provider scoped to this project
// This enables:
// - .claude/skills/ from the project
// - .mcp.json MCP servers (wavesmith)
// - Project-specific settings
const claudeCode = createClaudeCode({
  defaultSettings: {
    // Enable streaming input - REQUIRED for hooks to fire
    // See: https://ai-sdk.dev/providers/claude-code (hooks require streaming input)
    streamingInput: 'always',
    // Set working directory to project root
    cwd: PROJECT_ROOT,
    // Load project settings (picks up .claude/skills, .mcp.json, etc.)
    settingSources: ['project', 'local'],
    // MCP servers - Wavesmith for data + Virtual tools for client-side effects
    mcpServers: {
      wavesmith: {
        command: 'bun',
        args: ['run', 'packages/mcp/src/server.ts'],
      },
      // SDK MCP server for virtual tools (in-process, defined above)
      'virtual-tools': virtualToolsServer,
    },
    // Allow MCP tools, file operations, and skill invocation
    allowedTools: [
      // Virtual tools (SDK MCP server - uses mcp__servername__toolname format)
      'mcp__virtual-tools__navigate_to_phase',
      'mcp__virtual-tools__set_workspace',
      'mcp__virtual-tools__execute',
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
    // Hooks for subagent progress streaming (task-subagent-progress-streaming)
    // and virtual tool interception (virtual-tools-domain Phase 0 PoC)
    hooks: {
      // PreToolUse: Currently unused - virtual tools handled via sdkTool()
      // SDK tools (virtualToolsServer) are the single execution path for virtual tools.
      // See: sdkTool('set_workspace', ...), sdkTool('execute', ...), sdkTool('navigate_to_phase', ...)
      // Keeping hook structure for future non-virtual-tool interceptors if needed.
      SubagentStart: [{
        hooks: [async (rawInput: unknown) => {
          const input = rawInput as SubagentStartHookInput
          console.log(`${LOG_PREFIX} 🚀 HOOK SubagentStart fired:`, {
            agentId: input.agent_id,
            agentType: input.agent_type,
            rawInput: JSON.stringify(rawInput).slice(0, 200),
          })
          const event = {
            type: 'subagent-start',
            agentId: input.agent_id,
            agentType: input.agent_type,
            timestamp: Date.now(),
          } satisfies SubagentProgressEvent
          progressEvents.emit('progress', event)
          console.log(`${LOG_PREFIX} 📤 Emitted subagent-start event`)
          return { continue: true }
        }]
      }],
      SubagentStop: [{
        hooks: [async (rawInput: unknown) => {
          const input = rawInput as SubagentStopHookInput
          console.log(`${LOG_PREFIX} 🛑 HOOK SubagentStop fired:`, {
            agentId: input.agent_id,
            rawInput: JSON.stringify(rawInput).slice(0, 200),
          })
          const event = {
            type: 'subagent-stop',
            agentId: input.agent_id,
            timestamp: Date.now(),
          } satisfies SubagentProgressEvent
          progressEvents.emit('progress', event)
          console.log(`${LOG_PREFIX} 📤 Emitted subagent-stop event`)
          return { continue: true }
        }]
      }],
      PostToolUse: [{
        hooks: [async (rawInput: unknown) => {
          const input = rawInput as PostToolUseHookInput
          // Only log MCP and Skill tools to reduce noise
          if (input.tool_name.includes('mcp__') || input.tool_name === 'Skill' || input.tool_name === 'Task') {
            console.log(`${LOG_PREFIX} 🔧 HOOK PostToolUse fired:`, {
              toolName: input.tool_name,
              toolUseId: input.tool_use_id,
            })
          }
          const event = {
            type: 'tool-complete',
            toolName: input.tool_name,
            toolUseId: input.tool_use_id,
            timestamp: Date.now(),
          } satisfies SubagentProgressEvent
          progressEvents.emit('progress', event)
          return { continue: true }
        }]
      }],
      // Stop hook fires when PARENT agent finishes (not just subagents)
      // This is the authoritative signal that the stream should complete
      Stop: [{
        hooks: [async (rawInput: unknown) => {
          // Extract session_id from rawInput - SDK doesn't provide it in stream metadata
          const sessionId = (rawInput as { session_id?: string }).session_id
          console.log(`${LOG_PREFIX} 🏁 HOOK Stop (PARENT) fired:`, {
            sessionId,
            rawInput: JSON.stringify(rawInput).slice(0, 200),
          })
          // Signal stream completion with session ID - this will unblock the reader.read() loop
          streamCompletionEvents.emit('complete', {
            source: 'Stop',
            timestamp: Date.now(),
            sessionId,  // Pass session ID for client persistence
          })
          console.log(`${LOG_PREFIX} 📤 Emitted stream-complete signal from Stop hook (sessionId: ${sessionId})`)
          return { continue: true }
        }]
      }],
      // SessionEnd hook fires when the Claude Code session ends
      // This is a fallback signal in case Stop doesn't fire
      SessionEnd: [{
        hooks: [async (rawInput: unknown) => {
          // Extract session_id from rawInput - SDK doesn't provide it in stream metadata
          const sessionId = (rawInput as { session_id?: string }).session_id
          console.log(`${LOG_PREFIX} 🔚 HOOK SessionEnd fired:`, {
            sessionId,
            rawInput: JSON.stringify(rawInput).slice(0, 200),
          })
          // Signal stream completion with session ID
          streamCompletionEvents.emit('complete', {
            source: 'SessionEnd',
            timestamp: Date.now(),
            sessionId,  // Pass session ID for client persistence
          })
          console.log(`${LOG_PREFIX} 📤 Emitted stream-complete signal from SessionEnd hook (sessionId: ${sessionId})`)
          return { continue: true }
        }]
      }],
    },
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

You also have access to virtual tools for UI control:
- navigate_to_phase: Navigate the user to a different pipeline phase
  Arguments: { phase: "discovery" | "analysis" | "classification" | "design" | "spec" | "testing" | "implementation" | "complete" }
  Example: When user says "take me to the design phase" or "let's move to implementation", call this tool.
- set_workspace: Declaratively set workspace state
  Arguments: { layout?: "single"|"split-h"|"split-v", panels: [{ slot, section, config? }] }
  Example: set_workspace({ panels: [{ slot: "main", section: "DesignContainerSection", config: { schemaName: "platform-features" } }] })
  Use this to show schemas, change layouts, or display any combination of panels.
  Available sections: DesignContainerSection, WorkspaceBlankStateSection, DynamicCompositionSection, DataGridSection

- execute: Run domain operations on client state
  Arguments: { operations: [{ domain, action, model, id?, data }] }
  Example: execute({ operations: [{ domain: "platform-features", action: "update", model: "FeatureSession", id: "...", data: { status: "design" } }] })
  Use for creating/updating/deleting entities. Domains: component-builder, studio-chat, platform-features

Available schemas:
- platform-features: Feature sessions, requirements, analysis findings, integration points, tasks, test specs
- component-builder: UI composition system - ComponentDefinition, Composition, LayoutTemplate, Registry, RendererBinding
- studio-core: Organizations, projects, project membership
- studio-chat: Chat sessions and messages

You can help users:
- Design and create data schemas for their applications
- Create and manage entity instances
- Query and update data
- Inspect and modify UI compositions (use component-builder schema)
- Explain data modeling concepts and best practices
- Navigate between pipeline phases when requested

**Skill Assessment:** When the user's request involves displaying data, changing layouts, building views, or configuring workspace panels, consider invoking the /view-builder skill. This skill provides structured guidance for workspace composition including how to query component aiGuidance for configuration patterns.

When users ask to create schemas or data, use the appropriate MCP tools.
When users ask to navigate to a phase, use the navigate_to_phase tool.
When users ask about phase views, compositions, or UI sections, query the component-builder schema.
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

// CORS origins from environment - supports comma-separated list
// Defaults to localhost for development
const getAllowedOrigins = (): string[] => {
  const envOrigins = process.env.ALLOWED_ORIGINS
  if (envOrigins) {
    return envOrigins.split(',').map(o => o.trim())
  }
  // Default: localhost on any port (dev mode) - allows playwright and vite
  return [`http://localhost:${VITE_PORT}`, 'http://localhost:*']
}

// Enable CORS for development and production
const allowedOrigins = getAllowedOrigins()
app.use('/*', cors({
  origin: (origin) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return `http://localhost:${VITE_PORT}`
    // In dev mode, allow any localhost origin (for playwright, vite, etc.)
    if (process.env.NODE_ENV !== 'production' && origin?.startsWith('http://localhost:')) {
      return origin
    }
    // Check if origin is in allowed list
    return allowedOrigins.includes(origin) ? origin : allowedOrigins[0]
  },
  credentials: true,
}))

// Better Auth handler - mounted BEFORE other /api/* routes
// Handles all authentication endpoints: sign-up, sign-in, sign-out, session, OAuth callbacks, etc.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

// Health check
app.get('/api/health', (c) => c.json({ ok: true }))

// =============================================================================
// Publish routes - Project publishing to subdomain.shogo.ai
// =============================================================================

// Check subdomain availability
app.get('/api/subdomains/:subdomain/check', async (c) => {
  const studioCore = await getStudioCoreStore()
  const router = publishRoutes({ studioCore })
  // Forward with properly constructed URL
  const url = new URL(c.req.url)
  url.pathname = `/subdomains/${c.req.param('subdomain')}/check`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Publish a project
app.post('/api/projects/:projectId/publish', async (c) => {
  const studioCore = await getStudioCoreStore()
  const router = publishRoutes({ studioCore })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/publish`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// Update publish settings
app.patch('/api/projects/:projectId/publish', async (c) => {
  const studioCore = await getStudioCoreStore()
  const router = publishRoutes({ studioCore })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/publish`
  const newReq = new Request(url.toString(), {
    method: 'PATCH',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// Unpublish a project
app.post('/api/projects/:projectId/unpublish', async (c) => {
  const studioCore = await getStudioCoreStore()
  const router = publishRoutes({ studioCore })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/unpublish`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

/**
 * Generate a project name from a user prompt using a small language model.
 * This endpoint provides a fast, lightweight way to generate meaningful project names
 * without the overhead of the full chat interface.
 * 
 * Request body:
 * - prompt: string - The user's description of what they want to build
 * 
 * Response:
 * - name: string - A short, descriptive project name (2-4 words)
 */
/**
 * Fallback function for generating project names when AI is unavailable.
 * Extracts meaningful words from the prompt.
 */
function fallbackGenerateProjectName(prompt: string): string {
  const fillerWords = new Set([
    "a", "an", "the", "to", "for", "with", "that", "this", "is", "are",
    "create", "build", "make", "design", "develop", "implement",
    "please", "can", "you", "i", "want", "need", "would", "like",
    "simple", "basic", "web", "app", "application", "website", "page"
  ])

  const words = prompt.toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(word => word.length > 2 && !fillerWords.has(word))

  const nameWords = words.slice(0, 3)

  if (nameWords.length === 0) {
    return "New Project"
  }

  return nameWords
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

app.post('/api/generate-project-name', async (c) => {
  try {
    const { prompt } = await c.req.json()

    if (!prompt || typeof prompt !== 'string') {
      return c.json({ error: 'Prompt is required' }, 400)
    }

    // Check if ANTHROPIC_API_KEY is available
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('[/api/generate-project-name] ANTHROPIC_API_KEY not set, using fallback')
      return c.json({ name: fallbackGenerateProjectName(prompt) })
    }

    // Use Claude Haiku - fastest and most cost-effective model for simple tasks
    const anthropic = createAnthropic()

    const result = await generateText({
      model: anthropic('claude-3-5-haiku-latest'),
      system: `You are a project naming assistant. Given a user's description of what they want to build, generate a short, memorable project name.

Rules:
- Return ONLY the project name, nothing else
- Use 2-4 words maximum
- Make it descriptive but concise
- Use Title Case (capitalize each word)
- Do NOT include words like "App", "Application", "Project", "System" unless essential
- Focus on the core functionality or domain

Examples:
- "create a todo app" → "Task Tracker"
- "build a recipe manager" → "Recipe Book"
- "make a chat application with video calls" → "Video Chat"
- "create an e-commerce site for selling plants" → "Plant Shop"
- "build a dashboard for monitoring servers" → "Server Monitor"`,
      prompt: prompt.trim(),
    })

    // Extract and clean the name
    const name = result.text.trim().replace(/['"]/g, '') || 'New Project'

    return c.json({ name })
  } catch (error: any) {
    console.error('[/api/generate-project-name] Error:', error)
    // Fall back to simple extraction on any error - return 200 with fallback name
    const { prompt } = await c.req.json().catch(() => ({ prompt: '' }))
    return c.json({ name: fallbackGenerateProjectName(prompt || '') })
  }
})

/**
 * Calculate credit cost based on total tokens consumed.
 * 
 * Pricing: 0.1 credits per 5,000 tokens
 * - Round up to nearest 0.1 credits
 * - Minimum charge: 0.5 credits
 * 
 * @param totalTokens - Combined input + output tokens
 * @returns Credits to charge (minimum 0.5)
 */
function calculateCreditCost(totalTokens: number): number {
  // Rate: 0.1 credits per 5000 tokens
  const rawCredits = (totalTokens / 5000) * 0.1
  // Round up to nearest 0.1
  const rounded = Math.ceil(rawCredits * 10) / 10
  // Enforce minimum of 0.5 credits
  return Math.max(rounded, 0.5)
}

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
 * 
 * Credit Charging (after completion):
 * - Credits are charged AFTER the response completes
 * - Cost is based on total tokens (input + output)
 * - Rate: 0.1 credits per 5,000 tokens, minimum 0.5 credits
 */
app.post('/api/chat', async (c) => {
  try {
    const { messages, phase, ccSessionId, workspaceId, userId } = await c.req.json()

    // credit-limit-enforcement: Pre-check credits BEFORE calling AI
    // This prevents users from sending messages when they have no credits remaining
    if (workspaceId) {
      const store = await getBillingStore()

      // Query the SQL backend directly for the credit ledger
      // Use .where() for filtering, then .toArray() to execute the query
      const ledgers = await store.creditLedgerCollection.query().where({ workspace: workspaceId }).toArray()
      let ledger = ledgers[0]

      // If no ledger exists, allocate free tier credits
      if (!ledger) {
        await store.allocateFreeCredits(workspaceId)
        const newLedgers = await store.creditLedgerCollection.query().where({ workspace: workspaceId }).toArray()
        ledger = newLedgers[0]
      }

      if (ledger) {
        // Calculate effective balance with lazy daily reset
        const now = Date.now()
        const lastResetDay = new Date(ledger.lastDailyReset).setUTCHours(0, 0, 0, 0)
        const todayStart = new Date(now).setUTCHours(0, 0, 0, 0)
        const needsReset = lastResetDay !== todayStart

        const dailyCredits = needsReset ? 5 : ledger.dailyCredits
        const total = dailyCredits + ledger.monthlyCredits + ledger.rolloverCredits

        // Minimum credit cost is 0.5, so check if total >= 0.5
        if (total < 0.5) {
          return c.json(
            {
              error: 'Insufficient credits',
              message: 'You have run out of daily credits. Credits reset at midnight UTC.',
              creditsRemaining: total,
            },
            402 // Payment Required
          )
        }
      }
    }

    // Build dynamic system prompt based on current pipeline phase
    const systemPrompt = buildSystemPrompt(phase)

    // Pass resume parameter if ccSessionId provided (task-cc-api-endpoint)
    // This enables session continuity in Claude Code
    const modelSettings = ccSessionId ? { resume: ccSessionId } : {}

    // chat-session-sync-fix: Convert UIMessage format to CoreMessage format
    // v3 @ai-sdk/react sends UIMessage with parts array, but streamText expects CoreMessage with content string
    const coreMessages = convertUIMessagesToCoreMessages(messages)

    // task-subagent-progress-streaming: Buffer events BEFORE starting streamText
    // This fixes the race condition where SubagentStart fires before the stream listener is attached
    const eventBuffer: SubagentProgressEvent[] = []
    // virtual-tools-domain: Buffer for virtual tool events
    const virtualToolBuffer: VirtualToolEvent[] = []
    let streamWriter: { write: (data: any) => void } | null = null

    // Stream completion signal - resolves when Stop or SessionEnd hook fires
    // This fixes the hang when subagents complete but the stream doesn't close
    let streamCompleteResolver: (() => void) | null = null
    const streamCompletePromise = new Promise<void>((resolve) => {
      streamCompleteResolver = resolve
    })

    // Session ID captured from Stop/SessionEnd hooks (SDK workaround)
    // The Claude Code SDK doesn't include sessionId in stream metadata,
    // so we extract it from hook rawInput and emit it as a final stream event
    let capturedSessionId: string | undefined

    // Listen for completion signal from Stop/SessionEnd hooks
    const onStreamComplete = (info: { source: string; timestamp: number; sessionId?: string }) => {
      console.log(`${LOG_PREFIX} 🎯 Received stream-complete signal:`, info)
      capturedSessionId = info.sessionId
      // Write final session event to stream before closing (if we have streamWriter)
      if (streamWriter && info.sessionId) {
        console.log(`${LOG_PREFIX} 📨 Writing final session event to stream:`, info.sessionId)
        // Use message-metadata chunk type for session ID (AI SDK 6.x format)
        streamWriter.write({
          type: 'message-metadata',
          messageMetadata: { ccSessionId: info.sessionId },
        })
      }
      streamCompleteResolver?.()
    }
    streamCompletionEvents.on('complete', onStreamComplete)

    const onProgress = (event: SubagentProgressEvent) => {
      console.log(`${LOG_PREFIX} 📥 Received progress event:`, event)
      if (streamWriter) {
        // Stream is ready, write directly using AI SDK 6.x data-{name} format
        // The `data-progress` type allows custom data to flow through the stream
        streamWriter.write({
          type: 'data-progress',
          id: `progress-${Date.now()}`,
          data: event,
        })
        console.log(`${LOG_PREFIX} ✅ Wrote data-progress part to stream (live)`)
      } else {
        // Stream not ready yet, buffer the event
        eventBuffer.push(event)
        console.log(`${LOG_PREFIX} 📦 Buffered event (stream not ready), buffer size:`, eventBuffer.length)
      }
    }

    // virtual-tools-domain: Handle virtual tool events for client-side execution
    const onVirtualTool = (event: VirtualToolEvent) => {
      console.log(`${VT_LOG_PREFIX} 📥 Received virtual tool event:`, event)
      if (streamWriter) {
        // Stream is ready, write directly using AI SDK 6.x data-{name} format
        streamWriter.write({
          type: 'data-virtual-tool',
          id: `vt-${Date.now()}`,
          data: event,
        })
        console.log(`${VT_LOG_PREFIX} ✅ Wrote data-virtual-tool part to stream (live)`)
      } else {
        // Stream not ready yet, buffer the event
        virtualToolBuffer.push(event)
        console.log(`${VT_LOG_PREFIX} 📦 Buffered event (stream not ready), buffer size:`, virtualToolBuffer.length)
      }
    }

    // Attach listeners BEFORE calling streamText
    console.log(`${LOG_PREFIX} 👂 Attaching progress listener BEFORE streamText`)
    progressEvents.on('progress', onProgress)
    console.log(`${VT_LOG_PREFIX} 👂 Attaching virtual tool listener BEFORE streamText`)
    virtualToolEvents.on('virtual-tool', onVirtualTool)

    // chat-session-sync-fix: Send FULL message history every time
    // Claude Code handles deduplication internally via its session files
    // Old message-filtering logic was removed in favor of passing full array
    const result = streamText({
      // Type assertion for ai-sdk-provider-claude-code compatibility with ai@6
      // task-api-convert-images: streamingInput required for image support
      model: claudeCode('opus', {
        ...modelSettings,
        streamingInput: 'always',  // Required for image parts to be sent to Claude
      }) as Parameters<typeof streamText>[0]['model'],
      system: systemPrompt,
      messages: coreMessages,
    })

    // task-subagent-progress-streaming: Create merged stream with progress events
    // Uses createUIMessageStream to interleave hook events with LLM stream
    console.log(`${LOG_PREFIX} 📡 Creating UIMessageStream for request`)
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Connect the writer so new events go directly to stream
        streamWriter = writer
        console.log(`${LOG_PREFIX} 🔗 Stream writer connected`)

        // Flush any buffered events that arrived before stream was ready
        if (eventBuffer.length > 0) {
          console.log(`${LOG_PREFIX} 📤 Flushing ${eventBuffer.length} buffered events`)
          for (const bufferedEvent of eventBuffer) {
            writer.write({
              type: 'data-progress',
              id: `progress-${Date.now()}`,
              data: bufferedEvent,
            })
          }
          eventBuffer.length = 0 // Clear buffer
        }

        // virtual-tools-domain: Flush buffered virtual tool events
        if (virtualToolBuffer.length > 0) {
          console.log(`${VT_LOG_PREFIX} 📤 Flushing ${virtualToolBuffer.length} buffered virtual tool events`)
          for (const bufferedEvent of virtualToolBuffer) {
            writer.write({
              type: 'data-virtual-tool',
              id: `vt-${Date.now()}`,
              data: bufferedEvent,
            })
          }
          virtualToolBuffer.length = 0 // Clear buffer
        }

        // Feature flag for interleaved stream processing
        // Set to true to use new processInterleavedStream that preserves text/tool boundaries
        // Set to false to restore original toUIMessageStream behavior
        const USE_INTERLEAVED_STREAM = true

        try {
          if (USE_INTERLEAVED_STREAM) {
            // =====================================================================
            // NEW: Interleaved stream processing (chat-tool-interleaving-stream-processor)
            // task-server-integration: Use processInterleavedStream to preserve text/tool boundaries
            // =====================================================================
            console.log(`${LOG_PREFIX} 📖 Starting interleaved stream processing`)

            // Create the complete signal ONCE outside the loop to avoid repeated logging
            let streamCompleteWon = false
            const completeSignal = streamCompletePromise.then(() => {
              if (!streamCompleteWon) {
                streamCompleteWon = true
                console.log(`${LOG_PREFIX} 🏁 Stream complete signal won the race - closing stream`)
              }
              return { type: 'completion-signal' as const }
            })

            // Options for processInterleavedStream including metadata extraction
            const interleavedOptions = {
              getMessageMetadata: (providerMetadata: Record<string, Record<string, unknown>> | undefined) => {
                // Extract ccSessionId from providerMetadata (same logic as original)
                const claudeCodeMeta = providerMetadata?.['claude-code']
                const sessionId = claudeCodeMeta?.sessionId as string | undefined
                if (sessionId) {
                  console.log('[messageMetadata]', {
                    hasProviderMetadata: !!providerMetadata,
                    hasClaudeCodeMeta: !!claudeCodeMeta,
                    sessionId,
                    source: 'interleaved-stream',
                  })
                }
                return sessionId ? { ccSessionId: sessionId } : undefined
              }
            }

            // Use for-await-of loop over processInterleavedStream
            // Wrap in async IIFE to allow Promise.race against completion signal
            const processStream = async () => {
              for await (const chunk of processInterleavedStream(result.fullStream, interleavedOptions)) {
                writer.write(chunk)
              }
              return { type: 'stream-exhausted' as const }
            }

            // Race the stream processing against completion signal
            const raceResult = await Promise.race([
              processStream(),
              completeSignal
            ])

            if (raceResult.type === 'completion-signal') {
              console.log(`${LOG_PREFIX} ✅ Loop breaking due to completion signal`)
              // Completion signal won - stream is being closed by Stop/SessionEnd hook
            } else {
              console.log(`${LOG_PREFIX} ✅ Stream processing complete (stream exhausted)`)
            }
          } else {
            // =====================================================================
            // ROLLBACK: Original toUIMessageStream implementation
            // Set USE_INTERLEAVED_STREAM = false to restore this behavior
            // =====================================================================
            // Merge the LLM stream with messageMetadata for session ID
            const llmStream = result.toUIMessageStream({
              messageMetadata: ({ part }) => {
                // Debug logging for session ID extraction (task-cc-api-endpoint)
                const hasProviderMetadata = !!(part as any).providerMetadata
                const claudeCodeMeta = ((part as any).providerMetadata as Record<string, Record<string, unknown>> | undefined)?.['claude-code']
                const sessionId = claudeCodeMeta?.sessionId as string | undefined
                console.log('[messageMetadata]', {
                  hasProviderMetadata,
                  hasClaudeCodeMeta: !!claudeCodeMeta,
                  sessionId: sessionId ?? 'undefined',
                  partType: (part as any).type,
                })
                return sessionId ? { ccSessionId: sessionId } : undefined
              },
            })

            // Read and forward all chunks from LLM stream
            // CRITICAL: Race each read against the stream completion signal
            // This fixes the hang when subagents complete but the reader is still waiting
            const reader = llmStream.getReader()
            console.log(`${LOG_PREFIX} 📖 Starting reader loop with completion race`)

            // Create the complete signal ONCE outside the loop to avoid repeated logging
            let streamCompleteWon = false
            const completeSignal = streamCompletePromise.then(() => {
              if (!streamCompleteWon) {
                streamCompleteWon = true
                console.log(`${LOG_PREFIX} 🏁 Stream complete signal won the race - closing stream`)
              }
              return { done: true as const, value: undefined }
            })

            while (true) {
              // Race the read against the completion signal from Stop/SessionEnd hooks
              const readResult = await Promise.race([
                reader.read(),
                completeSignal
              ])

              if (readResult.done) {
                console.log(`${LOG_PREFIX} ✅ Reader loop complete (done=${readResult.done})`)
                break
              }
              if (readResult.value) {
                writer.write(readResult.value)
              }
            }
          }
        } finally {
          // Cleanup: remove progress listener to prevent memory leak
          console.log(`${LOG_PREFIX} 🧹 Removing progress listener (stream ending)`)
          progressEvents.off('progress', onProgress)
          virtualToolEvents.off('virtual-tool', onVirtualTool)
          streamCompletionEvents.off('complete', onStreamComplete)
          streamWriter = null
          console.log(`${LOG_PREFIX} 📊 Remaining listener count:`, progressEvents.listenerCount('progress'))
          console.log(`${VT_LOG_PREFIX} 📊 Remaining listener count:`, virtualToolEvents.listenerCount('virtual-tool'))

          // credit-tracking: Charge credits AFTER stream completes based on token usage
          // Fire-and-forget pattern - don't block the stream response
          if (workspaceId && userId) {
            (async () => {
              try {
                const usage = await result.usage as any
                // AI SDK usage may have totalTokens, promptTokens/completionTokens, or inputTokens/outputTokens
                const inputTokens = usage?.promptTokens ?? usage?.inputTokens ?? 0
                const outputTokens = usage?.completionTokens ?? usage?.outputTokens ?? 0
                const totalTokens = usage?.totalTokens ?? (inputTokens + outputTokens)
                const creditCost = calculateCreditCost(totalTokens)

                const store = await getBillingStore()
                await store.consumeCredits(
                  workspaceId,
                  creditCost,
                  userId,
                  'chat_message',
                  undefined, // projectId
                  {
                    phase,
                    ccSessionId,
                    inputTokens,
                    outputTokens,
                    totalTokens,
                  }
                )
                console.log(`[/api/chat] 💰 Charged ${creditCost} credits (${totalTokens} tokens) for workspace ${workspaceId}`)
              } catch (creditError: any) {
                console.error(`[/api/chat] ⚠️ Failed to charge credits:`, creditError.message)
              }
            })()
          }
        }
      },
      onError: (error) => {
        console.error('[/api/chat] Stream error:', error)
        // Cleanup on error too
        progressEvents.off('progress', onProgress)
        virtualToolEvents.off('virtual-tool', onVirtualTool)
        streamCompletionEvents.off('complete', onStreamComplete)
        streamWriter = null
        return 'An error occurred during streaming'
      },
    })

    return createUIMessageStreamResponse({ stream })
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

// =============================================================================
// Billing routes (simplified - accepts workspaceId in body)
// =============================================================================
// Only initialize Stripe if the API key is set
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

app.post('/api/billing/checkout', async (c) => {
  try {
    if (!stripe) {
      return c.json({ error: { code: 'stripe_not_configured', message: 'Stripe is not configured' } }, 503)
    }

    const body = await c.req.json()
    const { workspaceId, planId, billingInterval, userEmail } = body

    if (!workspaceId || !planId || !billingInterval) {
      return c.json({ error: { code: 'invalid_request', message: 'Missing required fields' } }, 400)
    }

    // Get price ID from config (supports tiered pricing: pro, pro_200, business_1200, etc.)
    const priceId = getPriceId(planId, billingInterval as 'monthly' | 'annual')

    if (!priceId) {
      return c.json({ error: { code: 'invalid_plan', message: `No price found for ${planId} ${billingInterval}` } }, 400)
    }

    // Build metadata
    const metadata: Record<string, string> = {
      workspaceId,
      planId,
      billingInterval,
    }

    // Include workspace ID in URLs for proper navigation after checkout
    const successUrl = `http://localhost:${VITE_PORT}/app?workspace=${workspaceId}&checkout=success&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `http://localhost:${VITE_PORT}/app?workspace=${workspaceId}&checkout=canceled`

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      // Pre-fill customer email to skip the email field in checkout
      ...(userEmail && { customer_email: userEmail }),
    })

    return c.json({ sessionId: session.id, url: session.url }, 200)
  } catch (error: any) {
    console.error('[Billing] Checkout error:', error)
    return c.json({ error: { code: 'stripe_error', message: error.message } }, 500)
  }
})

app.post('/api/billing/portal', async (c) => {
  try {
    if (!stripe) {
      return c.json({ error: { code: 'stripe_not_configured', message: 'Stripe is not configured' } }, 503)
    }

    const url = new URL(c.req.url)
    const workspaceId = url.searchParams.get('workspaceId')

    if (!workspaceId) {
      return c.json({ error: { code: 'invalid_request', message: 'Missing workspaceId' } }, 400)
    }

    // Get return URL from request body if provided
    let returnUrl = `http://localhost:${VITE_PORT}/app/billing`
    try {
      const body = await c.req.json<{ returnUrl?: string }>()
      if (body?.returnUrl) {
        returnUrl = body.returnUrl
      }
    } catch {
      // Body parsing failed, use default return URL
    }

    // Look up customer ID from workspace metadata
    const customers = await stripe.customers.search({
      query: `metadata['workspaceId']:'${workspaceId}'`,
    })

    if (customers.data.length === 0) {
      return c.json({ 
        error: { 
          code: 'customer_not_found', 
          message: `No Stripe customer found for workspace ${workspaceId}` 
        } 
      }, 404)
    }

    // Create Stripe billing portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: returnUrl,
    })

    return c.json({ url: session.url }, 200)
  } catch (error: any) {
    console.error('[Billing] Portal error:', error)
    return c.json({ error: { code: 'stripe_error', message: error.message } }, 500)
  }
})

// Stripe webhook endpoint
app.post('/webhooks/stripe', async (c) => {
  try {
    if (!stripe) {
      return c.json({ error: 'Stripe is not configured' }, 503)
    }

    const payload = await c.req.text()
    const signature = c.req.header('stripe-signature') || ''
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || ''

    let event: Stripe.Event
    try {
      // Use async version for Bun/SubtleCrypto compatibility
      event = await stripe.webhooks.constructEventAsync(payload, signature, webhookSecret)
    } catch (err: any) {
      console.error('[Webhook] Signature verification failed:', err.message)
      return c.json({ error: 'Invalid signature' }, 400)
    }

    console.log('[Webhook] Received event:', event.type)

    // Handle subscription events
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        console.log('[Webhook] Subscription event:', {
          type: event.type,
          subscriptionId: subscription.id,
          status: subscription.status,
          customerId: subscription.customer,
          metadata: subscription.metadata,
        })
        break
      }
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        console.log('[Webhook] Checkout completed:', {
          sessionId: session.id,
          subscriptionId: session.subscription,
          customerId: session.customer,
          metadata: session.metadata,
        })

        // Create subscription in billing domain
        const { workspaceId, planId, billingInterval } = session.metadata || {}
        if (workspaceId && planId && billingInterval && session.subscription && session.customer) {
          try {
            // Fetch the full subscription details from Stripe
            const stripeSubscription = await stripe!.subscriptions.retrieve(session.subscription as string)

            // Convert Stripe timestamps (seconds) to milliseconds, with fallbacks
            const now = Date.now()
            const currentPeriodStart = stripeSubscription.current_period_start
              ? stripeSubscription.current_period_start * 1000
              : now
            const currentPeriodEnd = stripeSubscription.current_period_end
              ? stripeSubscription.current_period_end * 1000
              : now + (30 * 24 * 60 * 60 * 1000) // Default to 30 days from now

            const store = await getBillingStore()
            await store.subscriptionCollection.insertOne({
              id: crypto.randomUUID(),
              workspace: workspaceId,
              stripeSubscriptionId: stripeSubscription.id,
              stripeCustomerId: session.customer as string,
              planId: planId as 'pro' | 'business' | 'enterprise',
              status: stripeSubscription.status as 'active' | 'past_due' | 'canceled' | 'trialing' | 'paused',
              billingInterval: billingInterval as 'monthly' | 'annual',
              currentPeriodStart,
              currentPeriodEnd,
              cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end ?? false,
              createdAt: now,
            })
            console.log('[Webhook] Subscription created for workspace:', workspaceId)
          } catch (err: any) {
            console.error('[Webhook] Failed to create subscription:', err.message)
          }
        }
        break
      }
      default:
        console.log('[Webhook] Unhandled event type:', event.type)
    }

    return c.json({ received: true }, 200)
  } catch (error: any) {
    console.error('[Webhook] Error:', error)
    return c.json({ error: 'Webhook error' }, 500)
  }
})

// Start server
console.log(`🚀 API server running on http://localhost:${API_PORT}`)
console.log(`   Chat endpoint: POST http://localhost:${API_PORT}/api/chat`)
console.log(`   CORS origin: http://localhost:${VITE_PORT}`)

export default {
  port: API_PORT,
  hostname: "0.0.0.0", // Bind to all interfaces for Docker/Kubernetes
  fetch: app.fetch,
  // Increase idle timeout for long-running subagent operations
  // Default is 10 seconds which is too short for Claude Code tool execution
  idleTimeout: 120, // 2 minutes
}

