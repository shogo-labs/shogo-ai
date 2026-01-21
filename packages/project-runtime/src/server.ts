/**
 * Project Runtime Server
 *
 * Runs inside each project's Knative pod, providing:
 * - Claude Code agent with project-scoped file access
 * - MCP (Wavesmith) subprocess for schema/data tools
 * - Health check endpoint for Kubernetes probes
 * - S3 file synchronization for persistent storage
 *
 * This is a simplified, isolated runtime - each project gets its own pod.
 * The API server proxies chat requests here.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamText, tool, type CoreMessage } from 'ai'
import { createClaudeCode } from 'ai-sdk-provider-claude-code'
import { z } from 'zod'
import { resolve, isAbsolute, relative, dirname } from 'path'
import { existsSync, readdirSync, readFileSync, cpSync, mkdirSync, rmSync } from 'fs'
import { initializeS3Sync, type S3Sync } from './s3-sync'
import { fileURLToPath } from 'url'

// Get monorepo root for template access
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// project-runtime/src/server.ts -> monorepo root is 3 levels up
const MONOREPO_ROOT = resolve(__dirname, '../../..')

// =============================================================================
// Configuration
// =============================================================================

const PROJECT_ID = process.env.PROJECT_ID
const PROJECT_DIR = process.env.PROJECT_DIR || '/app/project'
const SCHEMAS_PATH = process.env.SCHEMAS_PATH || '/app/.schemas'
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || '/app/packages/mcp/src/server.ts'
const PORT = parseInt(process.env.PORT || '8080', 10)

// Validate required environment
if (!PROJECT_ID) {
  console.error('[project-runtime] ERROR: PROJECT_ID environment variable is required')
  process.exit(1)
}

console.log(`[project-runtime] Starting for project: ${PROJECT_ID}`)
console.log(`[project-runtime] Project directory: ${PROJECT_DIR}`)
console.log(`[project-runtime] Schemas path: ${SCHEMAS_PATH}`)
console.log(`[project-runtime] MCP server path: ${MCP_SERVER_PATH}`)

// =============================================================================
// S3 Sync Initialization
// =============================================================================

let s3Sync: S3Sync | null = null

// Initialize S3 sync in background (don't block server startup)
;(async () => {
  try {
    s3Sync = await initializeS3Sync(PROJECT_DIR)
    if (s3Sync) {
      console.log(`[project-runtime] S3 sync initialized`)
    }
  } catch (error) {
    console.error(`[project-runtime] S3 sync initialization failed:`, error)
  }
})()

// =============================================================================
// Template Tools (Native - no MCP required)
// =============================================================================

interface TemplateMetadata {
  name: string
  description: string
  complexity: string
  features: string[]
  models: string[]
  tags: string[]
  useCases: string[]
  techStack: Record<string, string>
}

interface TemplateInfo extends TemplateMetadata {
  path: string
}

/**
 * Load all available templates from the SDK examples directory
 */
function loadTemplates(): TemplateInfo[] {
  const templatesDir = resolve(MONOREPO_ROOT, 'packages/sdk/examples')
  const templates: TemplateInfo[] = []

  if (!existsSync(templatesDir)) {
    console.warn(`[project-runtime] Templates directory not found: ${templatesDir}`)
    return templates
  }

  const entries = readdirSync(templatesDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const templateJsonPath = resolve(templatesDir, entry.name, 'template.json')
    if (!existsSync(templateJsonPath)) continue

    try {
      const content = readFileSync(templateJsonPath, 'utf-8')
      const metadata: TemplateMetadata = JSON.parse(content)
      templates.push({
        ...metadata,
        path: resolve(templatesDir, entry.name),
      })
    } catch {
      // Skip invalid template.json files
    }
  }

  return templates
}

/**
 * Copy a template to the project directory
 */
function copyTemplate(templateName: string, projectName: string): { ok: boolean; message?: string; error?: string; needsRestart?: boolean } {
  const templatesDir = resolve(MONOREPO_ROOT, 'packages/sdk/examples')
  const templatePath = resolve(templatesDir, templateName)

  if (!existsSync(templatePath)) {
    return { ok: false, error: `Template '${templateName}' not found` }
  }

  try {
    // Clean up existing src directory to avoid conflicts
    const srcDir = resolve(PROJECT_DIR, 'src')
    if (existsSync(srcDir)) {
      rmSync(srcDir, { recursive: true, force: true })
    }

    // Copy template files to project directory
    cpSync(templatePath, PROJECT_DIR, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes('.git') && !src.includes('template.json'),
    })

    return {
      ok: true,
      message: `Successfully copied template '${templateName}' to project. The Vite server needs to be restarted for changes to take effect. Run 'bun install' if dependencies changed.`,
      needsRestart: true,
    }
  } catch (error: any) {
    return { ok: false, error: error.message || 'Failed to copy template' }
  }
}

/**
 * AI SDK native tools for template operations
 */
const templateTools = {
  'template.list': tool({
    description: `List and search available starter templates. Returns templates with metadata including name, description, complexity, features, models, and tags.

Available templates:
- todo-app: Simple task management
- expense-tracker: Personal finance with categories
- crm: Customer relationship management
- inventory: Stock and product management
- kanban: Project boards with drag-and-drop
- ai-chat: AI chatbot with conversation history`,
    parameters: z.object({
      query: z.string().optional().describe('Optional search query to filter templates'),
    }),
    execute: async ({ query }) => {
      console.log(`[project-runtime] template.list called with query: ${query}`)
      let templates = loadTemplates()

      if (query) {
        const queryLower = query.toLowerCase()
        templates = templates.filter(t =>
          t.name.toLowerCase().includes(queryLower) ||
          t.description.toLowerCase().includes(queryLower) ||
          t.tags.some(tag => tag.toLowerCase().includes(queryLower)) ||
          t.useCases.some(uc => uc.toLowerCase().includes(queryLower))
        )
      }

      return JSON.stringify({ ok: true, templates }, null, 2)
    },
  }),

  'template.copy': tool({
    description: `Copy a starter template to set up the project. This will copy all template files to the current project directory.

IMPORTANT: After copying a template, the Vite server needs to be restarted for changes to take effect.
Call POST /api/projects/{projectId}/runtime/restart to restart the dev server after template copy.`,
    parameters: z.object({
      templateName: z.string().describe('Name of the template to copy (e.g., "ai-chat", "todo-app")'),
      projectName: z.string().optional().describe('Optional project name (for package.json)'),
    }),
    execute: async ({ templateName, projectName }) => {
      console.log(`[project-runtime] template.copy called: ${templateName}`)
      const result = copyTemplate(templateName, projectName || templateName)
      
      // If successful, include instructions about restarting
      if (result.ok) {
        return JSON.stringify({
          ...result,
          instructions: [
            'Template files have been copied to the project directory.',
            'The Vite dev server needs to be restarted for changes to take effect.',
            `Call POST /api/projects/${PROJECT_ID}/runtime/restart to restart the server.`,
            'Run "bun install" if the template has different dependencies.',
          ],
        }, null, 2)
      }
      
      return JSON.stringify(result, null, 2)
    },
  }),
}

// =============================================================================
// Path Restriction (Security)
// =============================================================================

/**
 * Creates a canUseTool callback that restricts file operations to the project directory.
 * This prevents the agent from accessing files outside the project.
 */
function createPathRestrictor(projectDir: string) {
  return async (toolName: string, input: unknown) => {
    // Only restrict file operation tools
    const fileTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'Bash']
    if (!fileTools.includes(toolName)) {
      return { behavior: 'allow' as const }
    }

    // Extract path from various input shapes
    const inputObj = input as Record<string, unknown>
    const inputPath = inputObj.file_path || inputObj.path || inputObj.filePath || inputObj.directory

    if (typeof inputPath === 'string') {
      const absolutePath = isAbsolute(inputPath) ? inputPath : resolve(projectDir, inputPath)
      const relativePath = relative(projectDir, absolutePath)

      // Block if path escapes project directory
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        console.warn(`[project-runtime] Blocked ${toolName} access outside project: ${inputPath}`)
        return {
          behavior: 'deny' as const,
          message: `Access denied: Path "${inputPath}" is outside the project directory`,
        }
      }
    }

    return { behavior: 'allow' as const }
  }
}

// =============================================================================
// Claude Code Provider
// =============================================================================

const pathRestrictor = createPathRestrictor(PROJECT_DIR)

const claudeCode = createClaudeCode({
  defaultSettings: {
    // Enable streaming (required for hooks)
    streamingInput: 'always',
    // Verbose logging for debugging
    verbose: true,
    // Working directory is the project
    cwd: PROJECT_DIR,
    // Path restriction for security
    canUseTool: pathRestrictor,
    // Load project settings (.claude/skills, .mcp.json, etc.)
    settingSources: ['project', 'local'],
    // MCP server configuration
    mcpServers: {
      wavesmith: {
        command: 'bun',
        args: ['run', MCP_SERVER_PATH],
        env: {
          SCHEMAS_PATH,
          PROJECT_ID: PROJECT_ID!,
          NODE_ENV: process.env.NODE_ENV || 'production',
          // Forward S3 configuration for schema persistence
          S3_ENDPOINT: process.env.S3_ENDPOINT || '',
          S3_SCHEMA_BUCKET: process.env.S3_SCHEMA_BUCKET || '',
          S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE || '',
          AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
          AWS_REGION: process.env.AWS_REGION || 'us-east-1',
          SCHEMA_STORAGE: process.env.SCHEMA_STORAGE || '',
          DATABASE_URL: process.env.DATABASE_URL || '',
        },
      },
    },
    // Allowed tools
    allowedTools: [
      // File operations
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS',
      // Skill and agent tools
      'Skill', 'Task', 'Bash', 'TodoWrite',
      // Template tools (underscores - Claude Code converts dots to underscores)
      'mcp__wavesmith__template_list',
      'mcp__wavesmith__template_copy',
      // Wavesmith MCP tools - Schema (underscores)
      // 'mcp__wavesmith__schema_set',
      // 'mcp__wavesmith__schema_get',
      // 'mcp__wavesmith__schema_list',
      // 'mcp__wavesmith__schema_load',
      // // Wavesmith MCP tools - Store (underscores)
      // 'mcp__wavesmith__store_create',
      // 'mcp__wavesmith__store_list',
      // 'mcp__wavesmith__store_get',
      // 'mcp__wavesmith__store_update',
      // 'mcp__wavesmith__store_query',
      // 'mcp__wavesmith__store_models',
      // 'mcp__wavesmith__store_delete',
      // // Wavesmith MCP tools - Views (underscores)
      // 'mcp__wavesmith__view_execute',
      // 'mcp__wavesmith__view_define',
      // 'mcp__wavesmith__view_project',
      // // Wavesmith MCP tools - Data & DDL (underscores)
      // 'mcp__wavesmith__data_load',
      // 'mcp__wavesmith__data_loadAll',
      // 'mcp__wavesmith__ddl_execute',
      // 'mcp__wavesmith__ddl_migrate',
    ],
    // Use default permission mode (our canUseTool callback handles restrictions)
    permissionMode: 'default',
  },
})

// =============================================================================
// Request Schemas
// =============================================================================

// AI SDK can send content as string or array of parts
const MessageContentSchema = z.union([
  z.string(),
  z.array(z.union([
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), image: z.string() }),
    z.object({ type: z.literal('file'), file: z.any() }),
    z.any(), // Allow other part types
  ])),
])

const ChatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: MessageContentSchema.optional(),
    // AI SDK v4 uses 'parts' as well
    parts: z.array(z.any()).optional(),
  })),
  sessionId: z.string().optional(),
  system: z.string().optional(),
  // Additional AI SDK fields
  body: z.any().optional(),
})

// =============================================================================
// Hono Server
// =============================================================================

const app = new Hono()

// CORS for cross-origin requests from API
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Session-Id'],
}))

// Health check endpoint for Kubernetes probes
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    projectId: PROJECT_ID,
    projectDir: PROJECT_DIR,
    uptime: process.uptime(),
  })
})

// Readiness check - verify project directory exists
app.get('/ready', (c) => {
  const projectDirExists = existsSync(PROJECT_DIR)
  
  if (!projectDirExists) {
    return c.json({
      status: 'not_ready',
      reason: 'Project directory does not exist',
      projectDir: PROJECT_DIR,
    }, 503)
  }
  
  return c.json({
    status: 'ready',
    projectId: PROJECT_ID,
    projectDir: PROJECT_DIR,
  })
})

// Main chat endpoint - receives from API, streams response
app.post('/agent/chat', async (c) => {
  console.log(`[project-runtime] Received chat request for project: ${PROJECT_ID}`)
  
  try {
    const body = await c.req.json()
    const parsed = ChatRequestSchema.safeParse(body)
    
    if (!parsed.success) {
      console.error('[project-runtime] Invalid request body:', parsed.error)
      return c.json({
        error: {
          code: 'invalid_request',
          message: 'Invalid request body',
          details: parsed.error.flatten(),
        },
      }, 400)
    }
    
    const { messages, system } = parsed.data
    
    // Convert to CoreMessage format, handling both string and parts content
    const coreMessages: CoreMessage[] = messages.map((msg) => {
      let content: string
      
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        // Extract text from content parts
        content = msg.content
          .filter((part): part is { type: 'text'; text: string } => 
            part && typeof part === 'object' && part.type === 'text')
          .map(part => part.text)
          .join('')
      } else if (Array.isArray(msg.parts)) {
        // AI SDK v4 parts format
        content = msg.parts
          .filter((part): part is { type: 'text'; text: string } => 
            part && typeof part === 'object' && part.type === 'text')
          .map(part => part.text)
          .join('')
      } else {
        content = ''
      }
      
      return {
        role: msg.role,
        content,
      }
    })
    
    console.log(`[project-runtime] Processing ${messages.length} messages`)
    
    // Create streaming response using Claude Code with native template tools
    const result = streamText({
      model: claudeCode('sonnet', {
        streamingInput: 'always',
      }) as Parameters<typeof streamText>[0]['model'],
      system: system || `You are Shogo - an AI assistant for building applications. The project files are in ${PROJECT_DIR}.

## Starter Templates

When a user wants to build an app, use the template tools:

- **template.list** - List and search available starter templates
- **template.copy** - Copy a template to set up the project

Available templates include: todo-app, expense-tracker, crm, inventory, kanban, ai-chat.

IMPORTANT: After using template.copy, you MUST restart the Vite server by telling the user to refresh the preview or by using the Bash tool to call: curl -X POST http://localhost:8002/api/projects/${PROJECT_ID}/runtime/restart

You also have access to file operations (Read, Write, Edit, Glob, Grep, Bash) for file management.`,
      messages: coreMessages,
      tools: templateTools,
      maxSteps: 10,
    })
    
    // Return the AI SDK UI message stream response directly
    // This ensures compatibility with @ai-sdk/react's useChat hook (DefaultChatTransport)
    return result.toUIMessageStreamResponse()
  } catch (error: any) {
    console.error('[project-runtime] Chat error:', error)
    return c.json({
      error: {
        code: 'chat_error',
        message: error.message || 'An error occurred during chat',
      },
    }, 500)
  }
})

// Info endpoint for debugging
app.get('/info', (c) => {
  return c.json({
    projectId: PROJECT_ID,
    projectDir: PROJECT_DIR,
    schemasPath: SCHEMAS_PATH,
    mcpServerPath: MCP_SERVER_PATH,
    nodeEnv: process.env.NODE_ENV,
    port: PORT,
    uptime: process.uptime(),
    s3Sync: s3Sync ? {
      enabled: true,
      stats: s3Sync.getStats(),
    } : {
      enabled: false,
    },
  })
})

// =============================================================================
// S3 Sync Endpoints
// =============================================================================

// Get S3 sync status
app.get('/sync/status', (c) => {
  if (!s3Sync) {
    return c.json({
      enabled: false,
      message: 'S3 sync not configured',
    })
  }

  return c.json({
    enabled: true,
    stats: s3Sync.getStats(),
  })
})

// Trigger manual sync (upload to S3)
app.post('/sync/upload', async (c) => {
  if (!s3Sync) {
    return c.json({
      success: false,
      error: 'S3 sync not configured',
    }, 400)
  }

  try {
    const stats = await s3Sync.uploadAll(false)
    return c.json({
      success: true,
      stats,
    })
  } catch (error: any) {
    return c.json({
      success: false,
      error: error.message,
    }, 500)
  }
})

// Trigger manual sync (download from S3)
app.post('/sync/download', async (c) => {
  if (!s3Sync) {
    return c.json({
      success: false,
      error: 'S3 sync not configured',
    }, 400)
  }

  try {
    const stats = await s3Sync.downloadAll()
    return c.json({
      success: true,
      stats,
    })
  } catch (error: any) {
    return c.json({
      success: false,
      error: error.message,
    }, 500)
  }
})

// =============================================================================
// Graceful Shutdown
// =============================================================================

async function gracefulShutdown(signal: string) {
  console.log(`[project-runtime] Received ${signal}, starting graceful shutdown...`)

  // Upload any pending changes to S3 before shutdown
  if (s3Sync) {
    console.log(`[project-runtime] Uploading final changes to S3...`)
    try {
      await s3Sync.uploadAll(false)
      s3Sync.shutdown()
      console.log(`[project-runtime] S3 sync completed and stopped`)
    } catch (error) {
      console.error(`[project-runtime] S3 final sync failed:`, error)
    }
  }

  console.log(`[project-runtime] Shutdown complete`)
  process.exit(0)
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// =============================================================================
// Start Server
// =============================================================================

console.log(`[project-runtime] Starting server on port ${PORT}`)

export default {
  port: PORT,
  fetch: app.fetch,
  // Increase idle timeout for long-running Claude responses (2 minutes)
  idleTimeout: 120,
}
