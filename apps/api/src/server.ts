import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamText, createUIMessageStream, createUIMessageStreamResponse, type ModelMessage } from 'ai'
import { z } from 'zod'
import { EventEmitter } from 'events'
import type { SubagentProgressEvent, VirtualToolEvent } from './types/progress'
// isVirtualTool kept in types/progress.ts for client-side use (ChatPanel handler)
import type { SubagentStartHookInput, SubagentStopHookInput, PostToolUseHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeCode, createSdkMcpServer, tool as sdkTool } from 'ai-sdk-provider-claude-code'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { auth } from './auth'
import { PHASE_PROMPTS, isPhase, type Phase } from './prompts/phase-prompts'

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
    // show_schema: Display a schema in the workspace (task-wpp)
    // Client handler updates workspace Composition entity with DesignContainerSection
    sdkTool(
      'show_schema',
      'Display a schema visualization in the advanced chat workspace. Use when user asks to see a schema like "show me the component-builder schema" or "display the platform-features schema".',
      {
        schemaName: z.string()
          .describe('The name of the schema to display (e.g., "component-builder", "platform-features", "studio-core")'),
        defaultTab: z.enum(['schema', 'decisions', 'hooks']).optional()
          .describe('Initial tab to display (defaults to "schema")'),
      },
      async (args) => {
        console.log(`${VT_LOG_PREFIX} 🎯 SDK tool handler executing show_schema:`, args)

        // Emit event for client-side execution
        // Client will update workspace Composition entity
        const event: VirtualToolEvent = {
          type: 'virtual-tool-execute',
          toolUseId: `vt-${Date.now()}`,
          toolName: 'show_schema',
          args: args as Record<string, unknown>,
          timestamp: Date.now(),
        }
        virtualToolEvents.emit('virtual-tool', event)
        console.log(`${VT_LOG_PREFIX} ✅ Emitted show_schema virtual tool event`)

        return {
          content: [{
            type: 'text',
            text: `Displaying ${args.schemaName} schema in workspace`
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
      'mcp__virtual-tools__show_schema',
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
      // See: sdkTool('show_schema', ...) and sdkTool('navigate_to_phase', ...)
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
- show_schema: Display a schema visualization in the workspace (v1 - prefer set_workspace)
  Arguments: { schemaName: string, defaultTab?: "schema" | "decisions" | "hooks" }
  Example: When user says "show me the component-builder schema" or "display platform-features", call this tool.
  This will render the schema graph and entity details in the workspace panel.

- set_workspace: Declaratively set workspace state (v2 - preferred)
  Arguments: { layout?: "single"|"split-h"|"split-v", panels: [{ slot, section, config? }] }
  Example: set_workspace({ panels: [{ slot: "main", section: "DesignContainerSection", config: { schemaName: "platform-features" } }] })
  Use this to show schemas, change layouts, or display any combination of panels.
  Available sections: DesignContainerSection, WorkspaceBlankStateSection

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
  // Default: localhost only (dev mode)
  return [`http://localhost:${VITE_PORT}`]
}

// Enable CORS for development and production
const allowedOrigins = getAllowedOrigins()
app.use('/*', cors({
  origin: (origin) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return `http://localhost:${VITE_PORT}`
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
      model: claudeCode('sonnet', {
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

        try {
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
        } finally {
          // Cleanup: remove progress listener to prevent memory leak
          console.log(`${LOG_PREFIX} 🧹 Removing progress listener (stream ending)`)
          progressEvents.off('progress', onProgress)
          virtualToolEvents.off('virtual-tool', onVirtualTool)
          streamCompletionEvents.off('complete', onStreamComplete)
          streamWriter = null
          console.log(`${LOG_PREFIX} 📊 Remaining listener count:`, progressEvents.listenerCount('progress'))
          console.log(`${VT_LOG_PREFIX} 📊 Remaining listener count:`, virtualToolEvents.listenerCount('virtual-tool'))
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

