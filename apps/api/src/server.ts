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
import { resolve, join, extname, relative, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import { readdir, stat } from 'fs/promises'
import { auth } from './auth'
import { PERSONA_PROMPTS, isAgentPersona, type AgentPersona } from './prompts/persona-prompts'
import { getPriceId } from './config/stripe-prices'
import { processInterleavedStream, finalizeCurrentText } from './lib/interleaved-stream'
import * as billingService from './services/billing.service'
import { publishRoutes } from './routes/publish'
import { runtimeRoutes } from './routes/runtime'
import { filesRoutes } from './routes/files'
import { projectChatRoutes } from './routes/project-chat'
import { projectAdminRoutes } from './routes/project-admin'
import { terminalRoutes } from './routes/terminal'
import { testsRoutes } from './routes/tests'
import { databaseRoutes, stopAllPrismaStudios } from './routes/database'
// Note: Manual routes (workspaces, projects, folders, starred) removed in favor of generated v2 routes
import { createRuntimeManager, type IRuntimeManager } from './lib/runtime'
// Generated routes (v2 API)
import { createGeneratedRoutes } from './generated/routes'
import { routeHooks } from './generated/hooks'
import { prisma } from './lib/prisma'

// Runtime manager singleton for project Vite runtimes
let runtimeManager: IRuntimeManager | null = null

// MCP session management for API → MCP calls
let mcpSessionId: string | null = null
const MCP_URL = process.env.MCP_URL || 'http://mcp:3100'

// Environment detection - check if running in Kubernetes
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

// Namespace for project runtime pods (configurable for staging/production)
const PROJECT_NAMESPACE = process.env.PROJECT_NAMESPACE || 'shogo-workspaces'

/**
 * Call an MCP tool with proper session handling
 */
async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<{ ok: boolean; error?: { code: string; message: string }; data?: any }> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    }
    if (mcpSessionId) {
      headers['mcp-session-id'] = mcpSessionId
    }

    const response = await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    })

    // Capture session ID from response
    const responseSessionId = response.headers.get('mcp-session-id')
    if (responseSessionId) {
      mcpSessionId = responseSessionId
    }

    const text = await response.text()
    
    // Parse SSE response to get the result
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6))
          if (parsed.result?.content?.[0]?.text) {
            return JSON.parse(parsed.result.content[0].text)
          }
          if (parsed.error) {
            return { ok: false, error: { code: 'MCP_ERROR', message: parsed.error.message || 'Unknown MCP error' } }
          }
        } catch { /* skip */ }
      }
    }

    return { ok: false, error: { code: 'MCP_ERROR', message: 'No valid response from MCP' } }
  } catch (err: any) {
    return { ok: false, error: { code: 'MCP_CALL_FAILED', message: err.message || 'MCP call failed' } }
  }
}

/**
 * Get or create the RuntimeManager singleton.
 *
 * Configurable via environment variables:
 * - RUNTIME_BASE_PORT: Base port for Vite runtimes (default: 5200)
 * - RUNTIME_MAX_COUNT: Maximum concurrent runtimes (default: 10)
 * - RUNTIME_DOMAIN_SUFFIX: Domain suffix for URLs (default: localhost)
 * - WORKSPACES_DIR: Directory containing project workspaces (default: PROJECT_ROOT/workspaces)
 */
function getRuntimeManager(): IRuntimeManager {
  if (!runtimeManager) {
    const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
    runtimeManager = createRuntimeManager({
      basePort: parseInt(process.env.RUNTIME_BASE_PORT || '5200', 10),
      maxRuntimes: parseInt(process.env.RUNTIME_MAX_COUNT || '10', 10),
      domainSuffix: process.env.RUNTIME_DOMAIN_SUFFIX || 'localhost',
      workspacesDir,
      templateDir: '_template',
    })
    console.log('[Runtime] RuntimeManager initialized:', {
      basePort: process.env.RUNTIME_BASE_PORT || '5200',
      maxRuntimes: process.env.RUNTIME_MAX_COUNT || '10',
      domainSuffix: process.env.RUNTIME_DOMAIN_SUFFIX || 'localhost',
      workspacesDir,
    })
  }
  return runtimeManager
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

// Get the frontend URL for redirects (Stripe checkout, etc.)
// Priority: APP_URL > first ALLOWED_ORIGINS > localhost fallback
const getFrontendUrl = (): string => {
  if (process.env.APP_URL) {
    return process.env.APP_URL
  }
  const allowedOrigins = process.env.ALLOWED_ORIGINS
  if (allowedOrigins) {
    const firstOrigin = allowedOrigins.split(',')[0]?.trim()
    if (firstOrigin) {
      return firstOrigin
    }
  }
  return `http://localhost:${VITE_PORT}`
}

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
    // For schema operations, calls MCP directly and returns real result
    // For other operations, emits events for client-side execution
    // NOTE: Using z.any() for complex nested types to avoid SDK schema validation issues
    sdkTool(
      'execute',
      'Execute state operations on the client. Use for creating/updating/deleting entities across domains. Each operation has: domain ("component-builder"|"studio-chat"), action ("create"|"update"|"delete"), model (string like "Composition", "ChatSession"), optional id (required for update/delete), and data object.',
      {
        operations: z.array(z.any())
          .describe('Array of operation objects with domain, action, model, optional id, and data'),
      },
      async (args) => {
        console.log(`${VT_LOG_PREFIX} 🎯 SDK tool handler executing execute:`, args)

        const results: Array<{ op: any; success: boolean; error?: string }> = []
        const clientOps: any[] = []

        // Process each operation
        for (const op of args.operations ?? []) {
          // Check if this is a schema operation that should go to MCP
          const isSchemaOperation = op.model === 'Schema' || op.domain === 'schema' || (op.domain === 'wavesmith' && op.model === 'Schema')
          
          if (isSchemaOperation && op.action === 'create' && op.data) {
            // Call MCP schema.set directly and return real result
            const schemaName = (op.data.name || op.data.id || op.id) as string
            if (!schemaName) {
              results.push({ op, success: false, error: 'Schema name is required' })
              continue
            }

            console.log(`${VT_LOG_PREFIX} 📋 Calling MCP schema.set for: ${schemaName}`)
            
            // Extract schema payload - AI sends { name, schema: { $defs: {...} } }
            const schemaPayload = op.data.schema || op.data
            
            const mcpResult = await callMcpTool('schema.set', {
              name: schemaName,
              payload: schemaPayload,
              workspace: 'workspace',
            })

            if (mcpResult.ok) {
              console.log(`${VT_LOG_PREFIX} ✅ MCP schema.set succeeded: ${schemaName}`)
              results.push({ op, success: true })
            } else {
              const errorMsg = mcpResult.error?.message || 'Unknown MCP error'
              const errorCode = mcpResult.error?.code || 'MCP_ERROR'
              console.error(`${VT_LOG_PREFIX} ❌ MCP schema.set failed: ${schemaName}`, mcpResult.error)
              results.push({ op, success: false, error: `[${errorCode}] ${errorMsg}` })
            }
          } else {
            // Non-schema operations go to client for execution
            clientOps.push(op)
          }
        }

        // Emit event for client-side operations (if any)
        if (clientOps.length > 0) {
          const event: VirtualToolEvent = {
            type: 'virtual-tool-execute',
            toolUseId: `vt-${Date.now()}`,
            toolName: 'execute',
            args: { operations: clientOps } as Record<string, unknown>,
            timestamp: Date.now(),
          }
          virtualToolEvents.emit('virtual-tool', event)
          console.log(`${VT_LOG_PREFIX} ✅ Emitted execute virtual tool event for ${clientOps.length} client ops`)
        }

        // Build response message
        const schemaResults = results.filter(r => r.op.model === 'Schema' || r.op.domain === 'schema')
        const failures = schemaResults.filter(r => !r.success)
        
        if (failures.length > 0) {
          // Return error details so AI can see what went wrong
          const errorMessages = failures.map(f => `- ${f.op.data?.name || 'unknown'}: ${f.error}`).join('\n')
          return {
            content: [{
              type: 'text',
              text: `Schema operation(s) failed:\n${errorMessages}\n\nPlease ensure the schema uses Enhanced JSON Schema format with a "$defs" object containing model definitions.`
            }]
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Executed ${args.operations?.length ?? 0} operation(s)${clientOps.length > 0 ? ` (${clientOps.length} sent to client)` : ''}`
          }]
        }
      }
    ),
  ]
})

// Get workspaces directory for project-scoped operations
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')

/**
 * File extensions to include in the project file list.
 */
const PROJECT_FILE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md', '.svg'
])

/**
 * Directories to exclude from project file listing.
 */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.vite', '.cache', '.claude'
])

/**
 * Recursively list files in a project directory.
 * Returns a flat list of relative file paths.
 */
async function listProjectFilesRecursive(
  dir: string,
  basePath: string,
  files: string[] = []
): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const entryPath = join(dir, entry.name)
      const relativePath = relative(basePath, entryPath)

      if (entry.isDirectory()) {
        // Skip excluded directories
        if (EXCLUDED_DIRS.has(entry.name)) {
          continue
        }
        // Recurse into subdirectories
        await listProjectFilesRecursive(entryPath, basePath, files)
      } else {
        const ext = extname(entry.name).toLowerCase()
        // Only include files with allowed extensions
        if (PROJECT_FILE_EXTENSIONS.has(ext)) {
          files.push(relativePath)
        }
      }
    }

    return files
  } catch (err) {
    console.error('[getProjectFiles] Error listing directory:', dir, err)
    return files
  }
}

/**
 * Get a formatted list of project files for inclusion in the system prompt.
 * Returns null if the project directory doesn't exist.
 */
async function getProjectFileList(projectId: string): Promise<string | null> {
  const projectDir = resolve(WORKSPACES_DIR, projectId)

  try {
    await stat(projectDir)
  } catch {
    return null // Project directory doesn't exist
  }

  const files = await listProjectFilesRecursive(projectDir, projectDir)

  if (files.length === 0) {
    return null
  }

  // Sort files for consistent output
  files.sort()

  // Format as a simple list
  return files.map(f => `  ${f}`).join('\n')
}

/**
 * Type for canUseTool permission result.
 * See: https://docs.anthropic.com/en/docs/claude-code/sdk
 */
type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message?: string }

/**
 * Type for canUseTool callback function.
 * Invoked before every tool execution to check permissions.
 */
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal }
) => Promise<PermissionResult>

/**
 * Create a canUseTool callback that restricts file operations to projectDir.
 * This prevents the agent from accessing files outside the project workspace,
 * ensuring proper filesystem isolation for user projects.
 *
 * @param projectDir - The absolute path to the project workspace directory
 * @returns A canUseTool callback function for use with createClaudeCode
 */
function createProjectPathRestrictor(projectDir: string): CanUseTool {
  // Tools that operate on filesystem paths
  const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS']
  // Normalize project directory (ensure no trailing slash for consistent comparison)
  const normalizedProjectDir = projectDir.endsWith('/') ? projectDir.slice(0, -1) : projectDir

  return async (toolName, input, _options) => {
    console.log(`[canUseTool] *** CALLBACK INVOKED for tool: ${toolName}, input: ${JSON.stringify(input).slice(0, 200)}`)
    // Only check file operation tools
    if (!FILE_TOOLS.includes(toolName)) {
      console.log(`[canUseTool] Tool ${toolName} is not a file tool, allowing`)
      return { behavior: 'allow' }
    }

    // Extract path from tool input (different tools use different field names)
    const inputPath = (input.file_path || input.path || input.directory) as string | undefined

    if (!inputPath) {
      // No path = allow (tool will handle missing params)
      return { behavior: 'allow' }
    }

    // Determine the absolute path to check
    let absolutePath: string
    if (isAbsolute(inputPath)) {
      // Absolute path - use directly (don't resolve against projectDir)
      absolutePath = inputPath
    } else {
      // Relative path - resolve against projectDir
      absolutePath = resolve(normalizedProjectDir, inputPath)
    }

    // Normalize the absolute path (resolve .. and .)
    absolutePath = resolve(absolutePath)

    // Check if path is within project directory
    // Path is valid if it equals projectDir or starts with projectDir/
    const isWithinProject =
      absolutePath === normalizedProjectDir ||
      absolutePath.startsWith(`${normalizedProjectDir}/`)

    if (!isWithinProject) {
      console.warn(`[ClaudeCode] Blocked ${toolName} access outside project: ${inputPath} -> ${absolutePath}`)
      return {
        behavior: 'deny',
        message: `Access denied: Cannot access files outside the project workspace. Path "${inputPath}" resolves to "${absolutePath}" which is outside "${normalizedProjectDir}". Use relative paths within the project directory.`
      }
    }

    return { behavior: 'allow' }
  }
}

/**
 * Create Claude Code provider with optional project-scoped working directory.
 * When projectId is provided, cwd is set to the project's workspace directory.
 * This enables the code agent to read/write files in the correct project.
 *
 * For project-scoped sessions, file operations are restricted to the project
 * workspace via canUseTool callback. This prevents the agent from accessing
 * files outside the project directory (e.g., the Shogo platform codebase).
 */
function createProjectScopedClaudeCode(projectId?: string) {
  // Determine working directory - project workspace if projectId provided, else project root
  let cwd = PROJECT_ROOT
  // Track project directory for path restriction (null means full access)
  let projectDir: string | null = null

  if (projectId) {
    const resolvedProjectDir = resolve(WORKSPACES_DIR, projectId)
    // Check if project directory exists - if not, fall back to project root
    // This handles the case where a project record exists but workspace hasn't been created yet
    try {
      const fs = require('fs')
      if (fs.existsSync(resolvedProjectDir)) {
        cwd = resolvedProjectDir
        projectDir = resolvedProjectDir // Enable path restriction
      } else {
        console.warn(`[ClaudeCode] Project workspace not found: ${resolvedProjectDir}, using project root (no path restriction)`)
      }
    } catch (e) {
      console.warn(`[ClaudeCode] Error checking project workspace: ${e}, using project root (no path restriction)`)
    }
  }

  const pathRestrictor = projectDir ? createProjectPathRestrictor(projectDir) : undefined
  console.log(`[ClaudeCode] Creating provider with cwd: ${cwd}${projectId ? ` (project: ${projectId})` : ' (platform)'}${projectDir ? ' [path-restricted]' : ''}`);
  console.log(`[ClaudeCode] canUseTool callback: ${pathRestrictor ? 'SET' : 'NOT SET'}`);

  return createClaudeCode({
  defaultSettings: {
    // Enable streaming input - REQUIRED for hooks to fire
    // See: https://ai-sdk.dev/providers/claude-code (hooks require streaming input)
    streamingInput: 'always',
    // Enable verbose logging for debugging
    verbose: true,
    // Set working directory - project workspace or project root
    cwd,
    // Path restriction for project-scoped sessions (prevents access outside workspace)
    // undefined means no restriction (full filesystem access for platform-level operations)
    canUseTool: pathRestrictor,
    // Load project settings (picks up .claude/skills, .mcp.json, etc.)
    settingSources: ['project', 'local'],
    // MCP servers - Wavesmith for data + Virtual tools for client-side effects
    mcpServers: {
      wavesmith: {
        // Run MCP server as subprocess (packages/mcp included in Docker build)
        // Use absolute path since cwd is set to project workspace, not app root
        command: 'bun',
        args: ['run', '/app/packages/mcp/src/server.ts'],
      },
      // SDK MCP server for virtual tools (in-process, defined above)
      'virtual-tools': virtualToolsServer,
    },
    // Allow MCP tools, file operations, and skill invocation
    allowedTools: [
      // Virtual tools (SDK MCP server - uses mcp__servername__toolname format)
      'mcp__virtual-tools__set_workspace',
      'mcp__virtual-tools__execute',
      // File operations
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS',
      // Skill and agent tools
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
    // Permission mode:
    // - When canUseTool callback is provided (project-scoped): use 'default' so CLI sends
    //   permission requests to SDK, which invokes our callback for path restriction
    // - When no canUseTool callback (platform-level): use 'bypassPermissions' for non-interactive use
    permissionMode: pathRestrictor ? 'default' : 'bypassPermissions',
    // Skip the dangerous bypass confirmation for non-project sessions
    allowDangerouslySkipPermissions: !pathRestrictor,
    // Hooks for subagent progress streaming (task-subagent-progress-streaming)
    // and virtual tool interception (virtual-tools-domain Phase 0 PoC)
    hooks: {
      // PreToolUse: Currently unused - virtual tools handled via sdkTool()
      // SDK tools (virtualToolsServer) are the single execution path for virtual tools.
      // See: sdkTool('set_workspace', ...), sdkTool('execute', ...)
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
}

// Default Claude Code instance for platform-level operations (skills, non-project chats)
const claudeCode = createProjectScopedClaudeCode()

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

**CRITICAL: Schema Format for schema_set**
When calling schema_set, your payload MUST use Enhanced JSON Schema format with "$defs":

{
  "$defs": {
    "ModelName": {
      "type": "object",
      "x-original-name": "ModelName",
      "properties": {
        "id": { "type": "string", "x-mst-type": "identifier" },
        "name": { "type": "string" }
      },
      "required": ["id", "name"]
    }
  }
}

- Use "$defs" (NOT "models", "x-models", "definitions", or "schemas")
- Each model needs: type="object", x-original-name, properties with id, required array
- id property must have "x-mst-type": "identifier"

You also have access to virtual tools for UI control:
- set_workspace: Declaratively set workspace state
  Arguments: { layout?: "single"|"split-h"|"split-v", panels: [{ slot, section, config? }] }
  Example: set_workspace({ panels: [{ slot: "main", section: "DesignContainerSection", config: { schemaName: "component-builder" } }] })
  Use this to show schemas, change layouts, or display any combination of panels.
  Available sections: DesignContainerSection, WorkspaceBlankStateSection, DynamicCompositionSection, DataGridSection

- execute: Run domain operations on client state
  Arguments: { operations: [{ domain, action, model, id?, data }] }
  Example: execute({ operations: [{ domain: "component-builder", action: "create", model: "Composition", data: { name: "..." } }] })
  Use for creating/updating/deleting entities. Domains: component-builder, studio-chat

Available schemas:
- component-builder: UI composition system - ComponentDefinition, Composition, LayoutTemplate, Registry, RendererBinding
- studio-core: Organizations, projects, project membership
- studio-chat: Chat sessions and messages

You can help users:
- Design and create data schemas for their applications
- Create and manage entity instances
- Query and update data
- Inspect and modify UI compositions (use component-builder schema)
- Explain data modeling concepts and best practices

**Skill Invocation (CRITICAL):**
When a user's message starts with a slash command like "/view-builder", you MUST immediately invoke the Skill tool before doing anything else.

Example:
- User: "/view-builder Create a todo app"
- You: Call the Skill tool with skill="view-builder"
- The skill will load and provide specific instructions to follow

Available skills:
- /view-builder - For displaying data, layouts, views, workspace panels

When users ask to create schemas or data, use the appropriate MCP tools.
When users ask about compositions, or UI sections, query the component-builder schema.
Be concise and practical. Show tool results when relevant.`

/**
 * Build a dynamic system prompt based on agent persona.
 *
 * @param agentPersona - The agent persona ('wavesmith' or 'code'), defaults to 'wavesmith'
 * @returns The complete system prompt with persona guidance and base prompt
 */
export function buildSystemPrompt(
  agentPersona?: AgentPersona | null
): string {
  // Validate and default persona
  const persona: AgentPersona = agentPersona && isAgentPersona(agentPersona) ? agentPersona : 'wavesmith'

  // Code agent gets a completely different prompt (no Wavesmith tools)
  if (persona === 'code') {
    return PERSONA_PROMPTS.code
  }

  // Wavesmith and Shogo agents get persona intro + base prompt
  // Shogo has all the same tools as Wavesmith, plus code generation capabilities
  return `${PERSONA_PROMPTS[persona]}\n\n${BASE_SYSTEM_PROMPT}`
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
// Templates API - Serve SDK example templates
// =============================================================================

/**
 * Template metadata structure from template.json files
 */
interface TemplateMetadata {
  name: string
  description: string
  complexity: 'beginner' | 'intermediate' | 'advanced'
  features: string[]
  models: string[]
  tags: string[]
  useCases: string[]
  techStack: {
    database: string
    orm: string
    frontend: string
    router: string
    sdk: string
    [key: string]: string
  }
}

/**
 * Load all available templates from SDK examples directory
 */
async function loadTemplates(): Promise<TemplateMetadata[]> {
  const templatesDir = resolve(PROJECT_ROOT, 'packages/sdk/examples')
  const templates: TemplateMetadata[] = []

  try {
    const entries = await readdir(templatesDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const templateJsonPath = join(templatesDir, entry.name, 'template.json')
      try {
        const content = await Bun.file(templateJsonPath).text()
        const metadata: TemplateMetadata = JSON.parse(content)
        templates.push(metadata)
      } catch {
        // Skip if no template.json or invalid JSON
      }
    }
  } catch (err) {
    console.error('[Templates] Failed to load templates:', err)
  }

  return templates
}

/**
 * GET /api/templates - List all available SDK templates
 * Returns template metadata for display on the home page
 */
app.get('/api/templates', async (c) => {
  try {
    const templates = await loadTemplates()
    return c.json({ templates }, 200)
  } catch (error: any) {
    console.error('[Templates] Error loading templates:', error)
    return c.json({ error: { code: 'template_error', message: error.message } }, 500)
  }
})

// =============================================================================
// Publish routes - Project publishing to subdomain.shogo.one
// =============================================================================

// Check subdomain availability
app.get('/api/subdomains/:subdomain/check', async (c) => {
  const router = publishRoutes()
  // Forward with properly constructed URL
  const url = new URL(c.req.url)
  url.pathname = `/subdomains/${c.req.param('subdomain')}/check`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Publish a project
app.post('/api/projects/:projectId/publish', async (c) => {
  const router = publishRoutes()
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
  const router = publishRoutes()
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
  const router = publishRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/unpublish`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// =============================================================================
// Runtime routes - Project Vite runtime management
// =============================================================================

// Start project runtime
app.post('/api/projects/:projectId/runtime/start', async (c) => {
  const manager = getRuntimeManager()
  const router = runtimeRoutes({ runtimeManager: manager, workspacesDir: WORKSPACES_DIR })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/runtime/start`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// Stop project runtime
app.post('/api/projects/:projectId/runtime/stop', async (c) => {
  const manager = getRuntimeManager()
  const router = runtimeRoutes({ runtimeManager: manager, workspacesDir: WORKSPACES_DIR })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/runtime/stop`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// Restart project runtime (useful after template copy)
app.post('/api/projects/:projectId/runtime/restart', async (c) => {
  const manager = getRuntimeManager()
  const router = runtimeRoutes({ runtimeManager: manager, workspacesDir: WORKSPACES_DIR })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/runtime/restart`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// Get project runtime status
app.get('/api/projects/:projectId/runtime/status', async (c) => {
  const manager = getRuntimeManager()
  const router = runtimeRoutes({ runtimeManager: manager, workspacesDir: WORKSPACES_DIR })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/runtime/status`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Get project sandbox URL for iframe embedding
app.get('/api/projects/:projectId/sandbox/url', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Return a proxy URL that goes through the API
    // The preview proxy endpoint will forward requests to the project runtime pod
    const { getProjectPodUrl } = await import('./lib/knative-project-manager')
    
    try {
      // This will create the pod if it doesn't exist and wait for it to be ready
      await getProjectPodUrl(projectId)
      
      // Return the proxy URL - all requests to this URL will be proxied to the project pod
      // Use X-Original-Host (set by nginx) if available, otherwise fall back to Host header
      const host = c.req.header('x-original-host') || c.req.header('host') || 'localhost'
      // In Kubernetes, always use HTTPS (Knative/ALB terminates TLS)
      // x-forwarded-proto may not be preserved through all proxy layers
      const protocol = 'https'
      const proxyUrl = `${protocol}://${host}/api/projects/${projectId}/preview/`
      
      return c.json({
        url: proxyUrl,
        directUrl: `http://project-${projectId}.${PROJECT_NAMESPACE}.svc.cluster.local`,
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
        status: 'running',
      }, 200)
    } catch (error: any) {
      console.error('[Runtime] Failed to get project pod URL:', error)
      return c.json({
        error: { code: 'pod_unavailable', message: error.message || 'Failed to start project runtime' }
      }, 503)
    }
  } else {
    // Local development: Use RuntimeManager
    const manager = getRuntimeManager()
    const router = runtimeRoutes({ runtimeManager: manager, workspacesDir: WORKSPACES_DIR })
    const url = new URL(c.req.url)
    url.pathname = `/projects/${projectId}/sandbox/url`
    const newReq = new Request(url.toString(), { method: 'GET' })
    return router.fetch(newReq)
  }
})

// =============================================================================
// Preview Proxy - Proxies preview requests to project runtime pods (Kubernetes only)
// =============================================================================

// Preview proxy for project runtime (all methods, all paths)
// Routes to the /preview/ endpoint on the project-runtime server which proxies to Vite
app.all('/api/projects/:projectId/preview/*', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (!isKubernetes()) {
    // In local dev, redirect to the local Vite dev server directly
    const manager = getRuntimeManager()
    const runtime = manager.status(projectId)
    if (runtime?.url) {
      const path = c.req.path.replace(`/api/projects/${projectId}/preview`, '') || '/'
      return c.redirect(`${runtime.url}${path}`)
    }
    return c.json({ error: { code: 'not_running', message: 'Project runtime not running' } }, 404)
  }
  
  try {
    const { getProjectPodUrl } = await import('./lib/knative-project-manager')
    const podUrl = await getProjectPodUrl(projectId)
    
    // Extract the path after /preview/ and route to /preview/ on the project-runtime
    // The project-runtime server proxies /preview/* to the Vite dev server on port 5173
    const path = c.req.path.replace(`/api/projects/${projectId}/preview`, '') || '/'
    const targetUrl = `${podUrl}/preview${path}`
    
    // Tell project-runtime the external base path for URL rewriting in HTML
    const externalBasePath = `/api/projects/${projectId}/preview/`
    
    console.log(`[PreviewProxy] Proxying ${c.req.method} ${path} to ${targetUrl} (external base: ${externalBasePath})`)
    
    // Forward the request to the project pod's preview proxy
    const headers = new Headers()
    
    // Pass the external base path for HTML rewriting
    headers.set('X-Proxy-Base-Path', externalBasePath)
    
    // Copy relevant headers
    const contentType = c.req.header('content-type')
    if (contentType) headers.set('content-type', contentType)
    const accept = c.req.header('accept')
    if (accept) headers.set('accept', accept)
    const acceptEncoding = c.req.header('accept-encoding')
    if (acceptEncoding) headers.set('accept-encoding', acceptEncoding)
    
    // Handle WebSocket upgrade for HMR
    const upgrade = c.req.header('upgrade')
    if (upgrade) {
      headers.set('upgrade', upgrade)
      headers.set('connection', 'upgrade')
      const wsKey = c.req.header('sec-websocket-key')
      if (wsKey) headers.set('sec-websocket-key', wsKey)
      const wsVersion = c.req.header('sec-websocket-version')
      if (wsVersion) headers.set('sec-websocket-version', wsVersion)
    }
    
    const requestInit: RequestInit = {
      method: c.req.method,
      headers,
    }
    
    // Include body for non-GET requests
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      requestInit.body = await c.req.arrayBuffer()
    }
    
    const response = await fetch(targetUrl, requestInit)
    
    // Copy response headers
    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => {
      // Skip certain headers
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    })
    
    // Add CORS headers for preview
    responseHeaders.set('access-control-allow-origin', '*')
    responseHeaders.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    responseHeaders.set('access-control-allow-headers', '*')
    
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error: any) {
    console.error('[PreviewProxy] Error:', error)
    return c.json({
      error: { code: 'proxy_error', message: error.message || 'Failed to proxy request' }
    }, 502)
  }
})

// Handle the base preview path without trailing content
app.all('/api/projects/:projectId/preview', async (c) => {
  // Redirect to the path with trailing slash
  const projectId = c.req.param('projectId')
  return c.redirect(`/api/projects/${projectId}/preview/`)
})

// =============================================================================
// Files routes - Project file listing and reading
// In Kubernetes mode, proxies to project-runtime pod's /files endpoint
// =============================================================================

// List project files
app.get('/api/projects/:projectId/files', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/files`
      
      console.log(`[FilesProxy] Proxying file list to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[FilesProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to list files' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = filesRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/files`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Get file content
app.get('/api/projects/:projectId/files/*', async (c) => {
  const projectId = c.req.param('projectId')
  const filePath = c.req.path.replace(`/api/projects/${projectId}/files/`, '')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/files/${filePath}`
      
      console.log(`[FilesProxy] Proxying file read to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[FilesProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to read file' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = filesRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/files/${filePath}`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Write file content
app.put('/api/projects/:projectId/files/*', async (c) => {
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = filesRoutes({ workspacesDir })
  const projectId = c.req.param('projectId')
  const filePath = c.req.path.replace(`/api/projects/${projectId}/files/`, '')
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/files/${filePath}`
  const newReq = new Request(url.toString(), {
    method: 'PUT',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// =============================================================================
// S3 Files routes - Project file listing and access via S3 pre-signed URLs
// =============================================================================

// List project files from S3
app.get('/api/projects/:projectId/s3/files', async (c) => {
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = filesRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/s3/files`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Get pre-signed URLs for S3 file read/write
app.post('/api/projects/:projectId/s3/presign', async (c) => {
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = filesRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/s3/presign`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// =============================================================================
// Terminal routes - Execute preset shell commands on project workspaces
// =============================================================================

// List available terminal commands
app.get('/api/projects/:projectId/terminal/commands', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/terminal/commands`
      
      console.log(`[TerminalProxy] Proxying commands list to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[TerminalProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to get terminal commands' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = terminalRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/terminal/commands`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Execute a preset command
app.post('/api/projects/:projectId/terminal/exec', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/terminal/exec`
      
      console.log(`[TerminalProxy] Proxying exec to ${targetUrl}`)
      
      // Read and forward only the necessary headers and body
      const body = await c.req.text()
      
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': c.req.header('Content-Type') || 'application/json',
        },
        body,
      })
      
      console.log(`[TerminalProxy] Response status: ${response.status}`)
      
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[TerminalProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to execute command' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = terminalRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/terminal/exec`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// =============================================================================
// Tests routes - E2E test management and execution
// =============================================================================

// List test files
app.get('/api/projects/:projectId/tests/list', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/tests/list`
      
      console.log(`[TestsProxy] Proxying tests list to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error(`[TestsProxy] Error proxying tests list:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local/development mode: use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = testsRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/tests/list`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Run tests with options
app.post('/api/projects/:projectId/tests/run', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/tests/run`
      
      console.log(`[TestsProxy] Proxying tests run to ${targetUrl}`)
      
      // Read body first to avoid streaming issues
      const body = await c.req.text()
      
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': c.req.header('Content-Type') || 'application/json',
        },
        body,
      })
      
      console.log(`[TestsProxy] Response status: ${response.status}`)
      
      // Return streaming response
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error(`[TestsProxy] Error proxying tests run:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local/development mode: use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = testsRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/tests/run`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// List test traces
app.get('/api/projects/:projectId/tests/traces', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/tests/traces`
      
      console.log(`[TestsProxy] Proxying traces list to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error(`[TestsProxy] Error proxying traces list:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local development: Return empty for now
  return c.json({ traces: [] })
})

// CORS headers for trace viewer (trace.playwright.dev)
const traceViewerCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
}

// Handle CORS preflight for trace files
app.options('/api/projects/:projectId/tests/traces/*', (c) => {
  return new Response(null, {
    status: 204,
    headers: traceViewerCorsHeaders,
  })
})

// Download a specific trace file
app.get('/api/projects/:projectId/tests/traces/*', async (c) => {
  const projectId = c.req.param('projectId')
  // Get the trace path from the URL (everything after /tests/traces/)
  const tracePath = c.req.path.replace(`/api/projects/${projectId}/tests/traces/`, '')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/tests/traces/${tracePath}`
      
      console.log(`[TestsProxy] Proxying trace download to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      // Pass through all headers from project-runtime
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      // Ensure CORS headers are set
      Object.entries(traceViewerCorsHeaders).forEach(([key, value]) => {
        responseHeaders.set(key, value)
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error(`[TestsProxy] Error proxying trace download:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local development: Not implemented
  return c.json({ error: 'Not implemented' }, 501)
})

// Clear all traces
app.delete('/api/projects/:projectId/tests/traces', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/tests/traces`
      
      console.log(`[TestsProxy] Proxying traces clear to ${targetUrl}`)
      
      const response = await fetch(targetUrl, { method: 'DELETE' })
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error(`[TestsProxy] Error proxying traces clear:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local development: Not implemented
  return c.json({ ok: true, message: 'Not implemented in local mode' })
})

// =============================================================================
// Database routes - Prisma Studio management for project workspaces
// =============================================================================

// Start Prisma Studio
app.post('/api/projects/:projectId/database/start', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/database/start`
      
      console.log(`[DatabaseProxy] Proxying start to ${targetUrl}`)
      
      const response = await fetch(targetUrl, { method: 'POST' })
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[DatabaseProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to start database' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = databaseRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/database/start`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// Stop Prisma Studio
app.post('/api/projects/:projectId/database/stop', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/database/stop`
      
      console.log(`[DatabaseProxy] Proxying stop to ${targetUrl}`)
      
      const response = await fetch(targetUrl, { method: 'POST' })
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[DatabaseProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to stop database' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = databaseRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/database/stop`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// Get Prisma Studio status
app.get('/api/projects/:projectId/database/status', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/database/status`
      
      console.log(`[DatabaseProxy] Proxying status to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[DatabaseProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to get database status' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = databaseRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/database/status`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Get Prisma Studio URL (starts if needed)
app.get('/api/projects/:projectId/database/url', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to project-runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/database/url`
      
      console.log(`[DatabaseProxy] Proxying URL request to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const data = await response.json()
      
      // Transform 'proxy' URL to actual proxy path through API
      if (data.url === 'proxy') {
        data.url = `/api/projects/${projectId}/database/proxy/`
      }
      
      return c.json(data, response.status as any)
    } catch (error: any) {
      console.error('[DatabaseProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to get database URL' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = databaseRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/database/url`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Proxy requests to Prisma Studio running on project pod
app.all('/api/projects/:projectId/database/proxy', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (!isKubernetes()) {
    // Local development not supported for proxy yet
    return c.json({ error: 'Database proxy not available in local development' }, 501)
  }
  
  try {
    const { getProjectPodUrl } = await import('./lib/knative-project-manager')
    const podUrl = await getProjectPodUrl(projectId)
    const targetUrl = `${podUrl}/database/proxy`
    
    // Tell project-runtime the external base path for URL rewriting
    const externalBasePath = `/api/projects/${projectId}/database/proxy/`
    
    console.log(`[DatabaseProxy] Proxying to ${targetUrl} (external base: ${externalBasePath})`)
    
    const reqHeaders: Record<string, string> = {
      'Accept': c.req.header('Accept') || '*/*',
      'X-Proxy-Base-Path': externalBasePath,
    }
    const contentType = c.req.header('Content-Type')
    if (contentType) {
      reqHeaders['Content-Type'] = contentType
    }
    
    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers: reqHeaders,
      body: ['POST', 'PUT', 'PATCH'].includes(c.req.method) ? await c.req.arrayBuffer() : undefined,
    })
    
    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    })
    
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error: any) {
    console.error('[DatabaseProxy] Error:', error)
    return c.json({ error: 'Failed to proxy to Prisma Studio' }, 502)
  }
})

app.all('/api/projects/:projectId/database/proxy/*', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (!isKubernetes()) {
    return c.json({ error: 'Database proxy not available in local development' }, 501)
  }
  
  try {
    const { getProjectPodUrl } = await import('./lib/knative-project-manager')
    const podUrl = await getProjectPodUrl(projectId)
    
    // Get the path after /database/proxy
    const fullPath = c.req.path
    const proxyPath = fullPath.replace(`/api/projects/${projectId}/database/proxy`, '') || '/'
    const query = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''
    const targetUrl = `${podUrl}/database/proxy${proxyPath}${query}`
    
    // Tell project-runtime the external base path for URL rewriting
    const externalBasePath = `/api/projects/${projectId}/database/proxy/`
    
    console.log(`[DatabaseProxy] Proxying to ${targetUrl}`)
    
    const reqHeaders: Record<string, string> = {
      'Accept': c.req.header('Accept') || '*/*',
      'X-Proxy-Base-Path': externalBasePath,
    }
    const contentType = c.req.header('Content-Type')
    if (contentType) {
      reqHeaders['Content-Type'] = contentType
    }
    
    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers: reqHeaders,
      body: ['POST', 'PUT', 'PATCH'].includes(c.req.method) ? await c.req.arrayBuffer() : undefined,
    })
    
    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    })
    
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error: any) {
    console.error('[DatabaseProxy] Error:', error)
    return c.json({ error: 'Failed to proxy to Prisma Studio' }, 502)
  }
})

// =============================================================================
// Project Chat Proxy Routes (pod-per-project architecture)
// =============================================================================

// POST /api/projects/:projectId/chat - Proxy chat to project pod
app.post('/api/projects/:projectId/chat', async (c) => {
  const manager = getRuntimeManager()
  const router = projectChatRoutes({ runtimeManager: manager })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/chat`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// GET /api/projects/:projectId/chat/status - Check project runtime status
app.get('/api/projects/:projectId/chat/status', async (c) => {
  const manager = getRuntimeManager()
  const router = projectChatRoutes({ runtimeManager: manager })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/chat/status`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// POST /api/projects/:projectId/chat/wake - Wake up a scaled-to-zero pod
app.post('/api/projects/:projectId/chat/wake', async (c) => {
  const manager = getRuntimeManager()
  const router = projectChatRoutes({ runtimeManager: manager })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/chat/wake`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// =============================================================================
// Project Admin Routes (Kubernetes pod management)
// =============================================================================

// GET /api/admin/projects - List all project pods
app.get('/api/admin/projects', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = '/admin/projects'
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// GET /api/admin/stats - Get aggregate stats
app.get('/api/admin/stats', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = '/admin/stats'
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// GET /api/admin/projects/:projectId - Get project pod status
app.get('/api/admin/projects/:projectId', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/admin/projects/${c.req.param('projectId')}`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// POST /api/admin/projects/:projectId/scale - Scale project pod
app.post('/api/admin/projects/:projectId/scale', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/admin/projects/${c.req.param('projectId')}/scale`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// POST /api/admin/projects/:projectId/warmup - Warm up a project pod
app.post('/api/admin/projects/:projectId/warmup', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/admin/projects/${c.req.param('projectId')}/warmup`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// DELETE /api/admin/projects/:projectId - Delete project pod
app.delete('/api/admin/projects/:projectId', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/admin/projects/${c.req.param('projectId')}`
  const newReq = new Request(url.toString(), { method: 'DELETE' })
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
    const { messages, ccSessionId, workspaceId, userId, projectId } = await c.req.json()

    // Create project-scoped Claude Code instance if projectId is provided
    // This sets the cwd to the project's workspace directory for file operations
    const scopedClaudeCode = projectId
      ? createProjectScopedClaudeCode(projectId)
      : claudeCode

    // credit-limit-enforcement: Pre-check credits BEFORE calling AI
    // This prevents users from sending messages when they have no credits remaining
    if (workspaceId) {
      // Get credit ledger via Prisma service
      let ledger = await billingService.getCreditLedger(workspaceId)

      // If no ledger exists, allocate free tier credits
      if (!ledger) {
        ledger = await billingService.allocateFreeCredits(workspaceId)
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

    // Build dynamic system prompt based on agent persona (env var)
    const agentPersona = process.env.SHOGO_AGENT as AgentPersona | undefined
    let systemPrompt = buildSystemPrompt(agentPersona)

    // Include project file list in the prompt so agent knows what files exist
    if (projectId) {
      const projectFileList = await getProjectFileList(projectId)
      if (projectFileList) {
        systemPrompt = `${systemPrompt}

**Project Files:**
You are working in a project workspace. Here are the files in the project:
${projectFileList}

Use the Read, Write, and Edit tools to view and modify these files. All file paths are relative to the project root.`
      }
    }

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
      model: scopedClaudeCode('opus', {
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

                await billingService.consumeCredits(
                  workspaceId,
                  projectId || null, // projectId
                  userId,
                  'chat_message',
                  creditCost,
                  {
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
    const frontendUrl = getFrontendUrl()
    const successUrl = `${frontendUrl}/app?workspace=${workspaceId}&checkout=success&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${frontendUrl}/app?workspace=${workspaceId}&checkout=canceled`

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
    let returnUrl = `${getFrontendUrl()}/app/billing`
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
app.post('/api/webhooks/stripe', async (c) => {
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
            // Note: current_period_start/end are returned by the API but not in the TypeScript types for Stripe v20+
            const stripeSubscription = await stripe!.subscriptions.retrieve(session.subscription as string) as Stripe.Subscription & {
              current_period_start?: number
              current_period_end?: number
            }

            // Convert Stripe timestamps (seconds) to milliseconds, with fallbacks
            // Use billing_cycle_anchor or start_date as fallback if current_period fields are missing
            const now = Date.now()
            const currentPeriodStart = stripeSubscription.current_period_start
              ? stripeSubscription.current_period_start * 1000
              : (stripeSubscription.billing_cycle_anchor || stripeSubscription.start_date) * 1000 || now
            const currentPeriodEnd = stripeSubscription.current_period_end
              ? stripeSubscription.current_period_end * 1000
              : now + (30 * 24 * 60 * 60 * 1000) // Default to 30 days from now

            await billingService.syncFromStripe({
              stripeSubscriptionId: stripeSubscription.id,
              stripeCustomerId: session.customer as string,
              workspaceId,
              planId: planId as 'pro' | 'business' | 'enterprise',
              status: stripeSubscription.status as 'active' | 'past_due' | 'canceled' | 'trialing' | 'paused',
              billingInterval: billingInterval as 'monthly' | 'annual',
              currentPeriodStart: new Date(currentPeriodStart),
              currentPeriodEnd: new Date(currentPeriodEnd),
              cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end ?? false,
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

// =============================================================================
// Domain API routes - For APIPersistence layer
// =============================================================================

// Note: Domain routes are now served via /api/v2 (generated routes below)

// =============================================================================
// Generated API routes (v2) - Auto-generated from Prisma schema with hooks
// =============================================================================

// Mount generated routes at /api/v2
const generatedRoutes = createGeneratedRoutes({
  prisma,
  hooks: routeHooks,
})
app.route('/api/v2', generatedRoutes)

// =============================================================================
// Graceful shutdown handling
// =============================================================================

// Stop all runtimes on server shutdown
async function gracefulShutdown(signal: string) {
  console.log(`[Server] Received ${signal}, starting graceful shutdown...`)

  // Stop all project runtimes
  if (runtimeManager) {
    console.log('[Server] Stopping all project runtimes...')
    try {
      await runtimeManager.stopAll()
      console.log('[Server] All runtimes stopped')
    } catch (err: any) {
      console.error('[Server] Error stopping runtimes:', err.message)
    }
  }

  // Stop all Prisma Studio instances
  console.log('[Server] Stopping all Prisma Studio instances...')
  stopAllPrismaStudios()
  console.log('[Server] All Prisma Studios stopped')

  console.log('[Server] Shutdown complete')
  process.exit(0)
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Start server
console.log(`🚀 API server running on http://localhost:${API_PORT}`)
console.log(`   Chat endpoint: POST http://localhost:${API_PORT}/api/chat`)
console.log(`   Runtime endpoints: POST/GET http://localhost:${API_PORT}/api/projects/:id/runtime/*`)
console.log(`   CORS origin: http://localhost:${VITE_PORT}`)

export default {
  port: API_PORT,
  hostname: "0.0.0.0", // Bind to all interfaces for Docker/Kubernetes
  fetch: app.fetch,
  // Increase idle timeout for long-running subagent operations
  // Default is 10 seconds which is too short for Claude Code tool execution
  idleTimeout: 120, // 2 minutes
}

