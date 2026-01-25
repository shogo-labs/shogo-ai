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

// =============================================================================
// Startup Timing - Track cold start performance
// =============================================================================
const SERVER_START_TIME = Date.now()
const ENTRYPOINT_START_TIME = process.env.STARTUP_TIME ? parseInt(process.env.STARTUP_TIME, 10) : SERVER_START_TIME

function logTiming(message: string): void {
  const now = Date.now()
  const fromEntrypoint = ENTRYPOINT_START_TIME ? now - ENTRYPOINT_START_TIME : 0
  const fromServer = now - SERVER_START_TIME
  console.log(`[project-runtime] [+${fromEntrypoint}ms total, +${fromServer}ms server] ${message}`)
}

logTiming('Server module loading...')

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamText, tool, type CoreMessage } from 'ai'
import { createClaudeCode } from 'ai-sdk-provider-claude-code'
import { z } from 'zod'
import { resolve, isAbsolute, relative, dirname, join, basename } from 'path'
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, cpSync, mkdirSync, rmSync } from 'fs'
import { initializeS3Sync, type S3Sync } from './s3-sync'
import { initializePostgresBackup, type PostgresBackup } from './postgres-backup'
import { verifyPreviewToken, type PreviewTokenPayload } from './preview-token'
import { fileURLToPath } from 'url'

// Get monorepo root for template access
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// project-runtime/src/server.ts -> monorepo root is 3 levels up
const MONOREPO_ROOT = resolve(__dirname, '../../..')

// =============================================================================
// Configuration
// =============================================================================

logTiming('Loading configuration...')

const PROJECT_ID = process.env.PROJECT_ID
const PROJECT_DIR = process.env.PROJECT_DIR || '/app/project'
const SCHEMAS_PATH = process.env.SCHEMAS_PATH || '/app/.schemas'
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || '/app/packages/mcp/src/server-templates.ts'
const PORT = parseInt(process.env.PORT || '8080', 10)

// Fast start mode: server starts before build completes
const FAST_START_MODE = process.env.FAST_START_MODE === 'true'
const BUILD_STATUS_FILE = process.env.BUILD_STATUS_FILE || '/tmp/build-status'

// Validate required environment
if (!PROJECT_ID) {
  console.error('[project-runtime] ERROR: PROJECT_ID environment variable is required')
  process.exit(1)
}

logTiming(`Configuration loaded for project: ${PROJECT_ID}`)
console.log(`[project-runtime] Project directory: ${PROJECT_DIR}`)
console.log(`[project-runtime] Schemas path: ${SCHEMAS_PATH}`)
console.log(`[project-runtime] MCP server path: ${MCP_SERVER_PATH}`)
if (FAST_START_MODE) {
  logTiming('Fast start mode enabled (build runs in background)')
}

// =============================================================================
// S3 Sync Initialization
// =============================================================================

logTiming('Setting up S3 sync (async)...')

let s3Sync: S3Sync | null = null
let postgresBackup: PostgresBackup | null = null

// Initialize S3 sync in background (don't block server startup)
// Writes marker file when complete so background init can proceed
const S3_RESTORE_MARKER = '/tmp/s3-restore-complete'

;(async () => {
  const s3StartTime = Date.now()
  try {
    s3Sync = await initializeS3Sync(PROJECT_DIR)
    if (s3Sync) {
      const s3Duration = Date.now() - s3StartTime
      logTiming(`S3 sync initialized (took ${s3Duration}ms)`)
      
      // Write marker file to signal background init that S3 restore is complete
      // This allows background init to skip bun install if node_modules was restored
      writeFileSync(S3_RESTORE_MARKER, `restored:${Date.now()}`)
      logTiming('S3 restore marker written')
    } else {
      logTiming('S3 sync not configured (S3_WORKSPACES_BUCKET not set)')
      // Still write marker so background init doesn't wait forever
      writeFileSync(S3_RESTORE_MARKER, `skipped:${Date.now()}`)
    }
  } catch (error) {
    console.error(`[project-runtime] S3 sync initialization failed:`, error)
    // Write marker even on error so background init doesn't hang
    writeFileSync(S3_RESTORE_MARKER, `error:${Date.now()}`)
  }
})()

// Initialize PostgreSQL S3 backup in background (after postgres sidecar is ready)
// This provides persistence for postgres data when using emptyDir volumes
;(async () => {
  // Wait a bit for postgres sidecar to start (it runs in the same pod)
  await new Promise(resolve => setTimeout(resolve, 5000))
  
  try {
    postgresBackup = await initializePostgresBackup()
    if (postgresBackup) {
      logTiming('PostgreSQL S3 backup initialized')
    } else {
      logTiming('PostgreSQL S3 backup not configured or postgres not detected')
    }
  } catch (error) {
    console.error(`[project-runtime] PostgreSQL backup initialization failed:`, error)
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

// Embedded template metadata (used when running from Docker with archived templates)
const EMBEDDED_TEMPLATES: TemplateInfo[] = [
  { name: 'todo-app', description: 'Simple task management with lists', path: 'todo-app', complexity: 'beginner', tags: ['productivity', 'tasks'], features: ['CRUD', 'lists'], useCases: ['personal task tracking'], models: ['Todo', 'User'], techStack: { frontend: 'React', backend: 'TanStack Start', database: 'PostgreSQL' } },
  { name: 'expense-tracker', description: 'Personal finance with categories', path: 'expense-tracker', complexity: 'beginner', tags: ['finance', 'budgeting'], features: ['categories', 'charts'], useCases: ['expense tracking'], models: ['Expense', 'Category', 'User'], techStack: { frontend: 'React', backend: 'TanStack Start', database: 'PostgreSQL' } },
  { name: 'crm', description: 'Customer relationship management', path: 'crm', complexity: 'intermediate', tags: ['business', 'sales'], features: ['contacts', 'deals', 'pipeline'], useCases: ['sales management'], models: ['Contact', 'Deal', 'Company', 'User'], techStack: { frontend: 'React', backend: 'TanStack Start', database: 'PostgreSQL' } },
  { name: 'inventory', description: 'Stock and product management', path: 'inventory', complexity: 'intermediate', tags: ['business', 'warehouse'], features: ['products', 'stock', 'suppliers'], useCases: ['inventory management'], models: ['Product', 'Supplier', 'StockMovement', 'User'], techStack: { frontend: 'React', backend: 'TanStack Start', database: 'PostgreSQL' } },
  { name: 'kanban', description: 'Project boards with drag-and-drop', path: 'kanban', complexity: 'intermediate', tags: ['productivity', 'project-management'], features: ['boards', 'columns', 'cards', 'drag-drop'], useCases: ['project management'], models: ['Board', 'Column', 'Card', 'User'], techStack: { frontend: 'React', backend: 'TanStack Start', database: 'PostgreSQL' } },
  { name: 'ai-chat', description: 'AI chatbot with conversation history', path: 'ai-chat', complexity: 'intermediate', tags: ['ai', 'chatbot'], features: ['chat', 'ai-responses', 'history'], useCases: ['ai assistant'], models: ['Conversation', 'Message', 'User'], techStack: { frontend: 'React', backend: 'TanStack Start', database: 'PostgreSQL', ai: 'Anthropic Claude' } },
  { name: 'form-builder', description: 'Build custom forms and collect responses', path: 'form-builder', complexity: 'intermediate', tags: ['forms', 'surveys'], features: ['form-builder', 'responses'], useCases: ['surveys', 'data collection'], models: ['Form', 'Field', 'Response', 'User'], techStack: { frontend: 'React', backend: 'TanStack Start', database: 'PostgreSQL' } },
  { name: 'feedback-form', description: 'Collect user feedback', path: 'feedback-form', complexity: 'beginner', tags: ['feedback', 'forms'], features: ['feedback', 'ratings'], useCases: ['user feedback'], models: ['Feedback', 'User'], techStack: { frontend: 'React', backend: 'TanStack Start', database: 'PostgreSQL' } },
  { name: 'booking-app', description: 'Schedule appointments', path: 'booking-app', complexity: 'intermediate', tags: ['scheduling', 'appointments'], features: ['calendar', 'bookings', 'availability'], useCases: ['appointment scheduling'], models: ['Booking', 'TimeSlot', 'Service', 'User'], techStack: { frontend: 'React', backend: 'TanStack Start', database: 'PostgreSQL' } },
]

/**
 * Load all available templates from the SDK examples directory or archives
 */
function loadTemplates(): TemplateInfo[] {
  const templatesDir = resolve(MONOREPO_ROOT, 'packages/sdk/examples')
  const templatesArchiveDir = resolve(MONOREPO_ROOT, 'packages/sdk/templates')
  const templates: TemplateInfo[] = []

  // Check if we have uncompressed templates (local development)
  if (existsSync(templatesDir)) {
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
    
    if (templates.length > 0) {
      return templates
    }
  }

  // Check if we have archived templates (Docker production mode)
  if (existsSync(templatesArchiveDir)) {
    const entries = readdirSync(templatesArchiveDir)
    const archiveNames = entries
      .filter(f => f.endsWith('.tar.gz'))
      .map(f => f.replace('.tar.gz', ''))
    
    // Return embedded metadata for available archives
    return EMBEDDED_TEMPLATES.filter(t => archiveNames.includes(t.name))
  }

  console.warn(`[project-runtime] No templates found in ${templatesDir} or ${templatesArchiveDir}`)
  return []
}

/**
 * Sanitize .env file to remove DATABASE_URL.
 * In K8s, DATABASE_URL is provided via environment variable.
 * Template .env files have local dev URLs that would override this.
 */
function sanitizeEnvFile(projectDir: string): void {
  const envPath = resolve(projectDir, '.env')
  if (!existsSync(envPath)) return

  try {
    const content = readFileSync(envPath, 'utf-8')
    const lines = content.split('\n')
    
    // Filter out DATABASE_URL lines
    const filteredLines = lines.filter(line => {
      const trimmed = line.trim()
      if (trimmed.startsWith('DATABASE_URL=') || trimmed.startsWith('DATABASE_URL =')) {
        console.log(`[project-runtime] Removing DATABASE_URL from .env (will use environment variable)`)
        return false
      }
      return true
    })
    
    writeFileSync(envPath, filteredLines.join('\n'), 'utf-8')
  } catch (err: any) {
    console.warn(`[project-runtime] Warning: Could not sanitize .env file: ${err.message}`)
  }
}

/**
 * Copy a template to the project directory
 */
function copyTemplate(templateName: string, projectName: string): { ok: boolean; message?: string; error?: string; needsRestart?: boolean } {
  // First, try to find the template archive (tar.gz - includes node_modules + .output)
  const templatesArchiveDir = resolve(MONOREPO_ROOT, 'packages/sdk/templates')
  const templateArchivePath = resolve(templatesArchiveDir, `${templateName}.tar.gz`)
  
  // Fallback to uncompressed directory (for local development)
  const templatesDir = resolve(MONOREPO_ROOT, 'packages/sdk/examples')
  const templatePath = resolve(templatesDir, templateName)
  
  const hasArchive = existsSync(templateArchivePath)
  const hasDirectory = existsSync(templatePath)

  if (!hasArchive && !hasDirectory) {
    return { ok: false, error: `Template '${templateName}' not found (checked ${templateArchivePath} and ${templatePath})` }
  }

  try {
    // Clean up existing src directory to avoid conflicts
    const srcDir = resolve(PROJECT_DIR, 'src')
    if (existsSync(srcDir)) {
      rmSync(srcDir, { recursive: true, force: true })
    }
    
    // Clean up existing node_modules and .output to ensure fresh copy
    const nodeModulesDir = resolve(PROJECT_DIR, 'node_modules')
    const outputDir = resolve(PROJECT_DIR, '.output')
    if (existsSync(nodeModulesDir)) {
      rmSync(nodeModulesDir, { recursive: true, force: true })
    }
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true })
    }

    if (hasArchive) {
      // Extract from tar.gz archive (includes node_modules + .output for instant cold start)
      console.log(`[project-runtime] Extracting template archive: ${templateArchivePath}`)
      const startTime = Date.now()
      
      // Extract archive - tar strips the first component (template name) with --strip-components=1
      const result = Bun.spawnSync(['tar', '-xzf', templateArchivePath, '--strip-components=1', '-C', PROJECT_DIR], {
        stdout: 'inherit',
        stderr: 'inherit',
      })
      
      if (result.exitCode !== 0) {
        return { ok: false, error: `Failed to extract template archive (exit code ${result.exitCode})` }
      }
      
      const extractTime = Date.now() - startTime
      console.log(`[project-runtime] Template extracted in ${extractTime}ms (with node_modules + .output)`)
    } else {
      // Fallback: Copy from uncompressed directory (local development mode)
      console.log(`[project-runtime] Copying template directory: ${templatePath}`)
      cpSync(templatePath, PROJECT_DIR, {
        recursive: true,
        filter: (src) => !src.includes('.git') && !src.includes('template.json'),
      })
    }

    // Sanitize .env file to remove DATABASE_URL (K8s provides it via env var)
    sanitizeEnvFile(PROJECT_DIR)

    return {
      ok: true,
      message: hasArchive 
        ? `Successfully extracted template '${templateName}' with pre-installed dependencies. No bun install needed.`
        : `Successfully copied template '${templateName}' to project. The Vite server needs to be restarted for changes to take effect.`,
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
    description: `Copy a starter template to set up the project. This will copy all template files to the current project directory, install dependencies, build the project, and start the preview server automatically.`,
    parameters: z.object({
      templateName: z.string().describe('Name of the template to copy (e.g., "ai-chat", "todo-app", "expense-tracker")'),
      projectName: z.string().optional().describe('Optional project name (for package.json)'),
    }),
    execute: async ({ templateName, projectName }) => {
      console.log(`[project-runtime] template.copy called: ${templateName}`)
      const result = copyTemplate(templateName, projectName || templateName)
      
      // If successful, automatically rebuild and restart the preview
      if (result.ok) {
        let restartResult: { success: boolean; message: string; mode?: string; port?: number | null } = {
          success: false,
          message: 'Restart not attempted',
        }
        
        try {
          console.log(`[project-runtime] Rebuilding and restarting preview for project ${PROJECT_ID}...`)
          // Call our local restart endpoint
          const response = await fetch(`http://localhost:${PORT}/preview/restart`, {
            method: 'POST',
          })
          
          if (response.ok) {
            const data = await response.json() as { success: boolean; mode: string; port: number | null }
            restartResult = {
              success: true,
              message: `Preview restarted in ${data.mode} mode`,
              mode: data.mode,
              port: data.port,
            }
            console.log(`[project-runtime] Preview restarted in ${data.mode} mode`)
          } else {
            const errorData = await response.json().catch(() => ({})) as { error?: string }
            restartResult = {
              success: false,
              message: errorData.error || `Restart failed with status ${response.status}`,
            }
          }
        } catch (err: any) {
          console.warn(`[project-runtime] Restart error: ${err.message}`)
          restartResult = {
            success: false,
            message: err.message,
          }
        }
        
        return JSON.stringify({
          ...result,
          restart: restartResult,
          message: restartResult.success 
            ? `Template copied and preview rebuilt. The preview will show the ${templateName} app.`
            : 'Template copied but rebuild failed. Try refreshing the preview.',
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
    // Verbose logging (disabled in production)
    verbose: false,
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
          PROJECT_DIR,  // Critical: template.copy needs this to copy to the right location
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
// Stream Keep-Alive Utility
// =============================================================================

/**
 * Wrap a ReadableStream with periodic keep-alive comments.
 * This prevents HTTP/2 connections from being terminated by load balancers
 * during long-running operations like template copying (45+ seconds).
 * 
 * SSE format keep-alive: ": keep-alive\n\n" (comment line, doesn't affect data)
 * 
 * @param stream - Original stream to wrap
 * @param intervalMs - Interval between keep-alive messages (default 15s)
 * @returns New stream with keep-alive messages injected
 */
function wrapStreamWithKeepalive(
  stream: ReadableStream<Uint8Array>,
  intervalMs: number = 15000
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const keepAliveMessage = encoder.encode(': keep-alive\n\n')
  
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  
  const reader = stream.getReader()
  
  return new ReadableStream({
    start(ctrl) {
      controller = ctrl
      
      // Start keep-alive interval
      keepAliveInterval = setInterval(() => {
        try {
          if (controller) {
            controller.enqueue(keepAliveMessage)
            console.log('[project-runtime] Sent keep-alive')
          }
        } catch {
          // Stream closed, stop sending
          if (keepAliveInterval) {
            clearInterval(keepAliveInterval)
            keepAliveInterval = null
          }
        }
      }, intervalMs)
    },
    
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read()
        
        if (done) {
          // Clean up and close
          if (keepAliveInterval) {
            clearInterval(keepAliveInterval)
            keepAliveInterval = null
          }
          ctrl.close()
          return
        }
        
        ctrl.enqueue(value)
      } catch (error) {
        // Clean up on error
        if (keepAliveInterval) {
          clearInterval(keepAliveInterval)
          keepAliveInterval = null
        }
        ctrl.error(error)
      }
    },
    
    cancel() {
      // Clean up on cancel
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval)
        keepAliveInterval = null
      }
      reader.cancel()
    },
  })
}

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

// =============================================================================
// Build Status Helper (for fast start mode)
// =============================================================================

function getBuildStatus(): { status: string; ready: boolean } {
  if (!FAST_START_MODE) {
    return { status: 'ready', ready: true }
  }
  
  try {
    if (existsSync(BUILD_STATUS_FILE)) {
      const status = readFileSync(BUILD_STATUS_FILE, 'utf-8').trim()
      return {
        status,
        ready: status === 'ready',
      }
    }
  } catch {
    // File doesn't exist yet
  }
  
  return { status: 'initializing', ready: false }
}

// Health check endpoint for Kubernetes probes
// Always returns ok quickly - this is for liveness, not readiness
app.get('/health', (c) => {
  const uptimeMs = Date.now() - SERVER_START_TIME
  return c.json({
    status: 'ok',
    projectId: PROJECT_ID,
    projectDir: PROJECT_DIR,
    uptime: process.uptime(),
    uptimeMs,
    fastStartMode: FAST_START_MODE,
    coldStartMs: uptimeMs < 60000 ? uptimeMs : undefined, // Only show for first minute
  })
})

// Readiness check - returns 503 until build completes in fast start mode
// Tracks timing to help diagnose cold start delays
let firstReadyTime: number | null = null
let readyCheckCount = 0

app.get('/ready', (c) => {
  readyCheckCount++
  const uptimeMs = Date.now() - SERVER_START_TIME
  const projectDirExists = existsSync(PROJECT_DIR)
  
  if (!projectDirExists) {
    console.log(`[project-runtime] [ready-check #${readyCheckCount}] [+${uptimeMs}ms] NOT READY: Project directory does not exist`)
    return c.json({
      status: 'not_ready',
      reason: 'Project directory does not exist',
      projectDir: PROJECT_DIR,
      uptimeMs,
      checkCount: readyCheckCount,
    }, 503)
  }
  
  // In fast start mode, check if background build has completed
  if (FAST_START_MODE) {
    const buildStatus = getBuildStatus()
    
    if (!buildStatus.ready) {
      console.log(`[project-runtime] [ready-check #${readyCheckCount}] [+${uptimeMs}ms] NOT READY: ${buildStatus.status}`)
      return c.json({
        status: 'initializing',
        buildStatus: buildStatus.status,
        reason: 'Background initialization in progress',
        projectId: PROJECT_ID,
        uptimeMs,
        checkCount: readyCheckCount,
      }, 503)
    }
  }
  
  // Track when we first became ready
  if (!firstReadyTime) {
    firstReadyTime = uptimeMs
    logTiming(`READY! First ready after ${firstReadyTime}ms (${readyCheckCount} checks)`)
  }
  
  return c.json({
    status: 'ready',
    projectId: PROJECT_ID,
    projectDir: PROJECT_DIR,
    uptimeMs,
    firstReadyAfterMs: firstReadyTime,
    checkCount: readyCheckCount,
  })
})

// Build status endpoint - shows detailed initialization progress
app.get('/build-status', (c) => {
  const buildStatus = getBuildStatus()
  return c.json({
    projectId: PROJECT_ID,
    fastStartMode: FAST_START_MODE,
    ...buildStatus,
    uptime: process.uptime(),
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

After using template.copy, the Vite server restarts automatically and the preview will update to show the new app. No manual restart is needed.

You also have access to file operations (Read, Write, Edit, Glob, Grep, Bash) for file management.`,
      messages: coreMessages,
      tools: templateTools,
      maxSteps: 10,
    })
    
    // Return the AI SDK UI message stream response with keep-alive wrapper
    // This ensures compatibility with @ai-sdk/react's useChat hook (DefaultChatTransport)
    // The keep-alive wrapper prevents HTTP/2 connection termination during long tool calls
    const response = result.toUIMessageStreamResponse()
    
    // Wrap the stream with keep-alive messages to prevent ALB/proxy timeouts
    // This is critical for long-running operations like template.copy (45+ seconds)
    if (response.body) {
      const wrappedStream = wrapStreamWithKeepalive(response.body, 15000)
      return new Response(wrappedStream, {
        status: response.status,
        headers: response.headers,
      })
    }
    
    return response
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
// Preview Restart Endpoint
// =============================================================================

const DIST_DIR = join(PROJECT_DIR, 'dist')
const NITRO_SERVER_PORT = parseInt(process.env.NITRO_SERVER_PORT || '3000', 10)

// Track current preview mode and Nitro server process
let isTanStackStart = process.env.IS_TANSTACK_START === 'true'
let nitroProcess: ReturnType<typeof Bun.spawn> | null = null

/**
 * Wait for PostgreSQL to be ready to accept connections.
 * This is critical when using postgres sidecar - we need to wait for it to start
 * before running prisma commands.
 * 
 * @param timeoutMs - Maximum time to wait (default 30s)
 * @returns true if postgres is ready, false if timeout
 */
async function waitForPostgresReady(timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 500
  
  console.log('[project-runtime] Waiting for PostgreSQL to be ready...')
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      // Use pg_isready if available (postgres image includes it)
      const proc = Bun.spawn(['pg_isready', '-h', 'localhost', '-p', '5432', '-q'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      
      if (exitCode === 0) {
        const elapsed = Date.now() - startTime
        console.log(`[project-runtime] PostgreSQL ready after ${elapsed}ms`)
        return true
      }
    } catch {
      // pg_isready not available, try direct connection test
      try {
        const testProc = Bun.spawn(['bunx', 'prisma', 'db', 'execute', '--stdin', '--schema', join(PROJECT_DIR, 'prisma', 'schema.prisma')], {
          cwd: PROJECT_DIR,
          stdin: new Blob(['SELECT 1']),
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const testExitCode = await testProc.exited
        if (testExitCode === 0) {
          const elapsed = Date.now() - startTime
          console.log(`[project-runtime] PostgreSQL ready after ${elapsed}ms (via prisma test)`)
          return true
        }
      } catch {
        // Connection test failed, keep waiting
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, checkInterval))
  }
  
  console.error(`[project-runtime] PostgreSQL not ready after ${timeoutMs}ms`)
  return false
}

/**
 * Restart the preview server after template changes.
 * This will:
 * 1. Kill any existing Nitro server process
 * 2. Install dependencies
 * 3. Wait for PostgreSQL sidecar to be ready (if prisma is present)
 * 4. Run prisma generate/push if needed
 * 5. Build with Vite (Nitro produces .output/server/index.mjs)
 * 6. Start the Nitro server (for TanStack Start) or serve static files (plain Vite)
 */
app.post('/preview/restart', async (c) => {
  const startTime = performance.now()
  const timings: { step: string; durationMs: number }[] = []
  let lastMark = startTime
  
  const markStep = (name: string) => {
    const now = performance.now()
    const duration = Math.round(now - lastMark)
    timings.push({ step: name, durationMs: duration })
    console.log(`[project-runtime] ⏱️  ${name}: ${duration}ms`)
    lastMark = now
  }
  
  console.log(`[project-runtime] ⏱️  Starting preview restart for project ${PROJECT_ID}...`)
  
  try {
    // 1. Kill existing Nitro server if running
    if (nitroProcess) {
      console.log('[project-runtime] Stopping existing Nitro server...')
      nitroProcess.kill()
      nitroProcess = null
    }
    markStep('killExistingServer')
    
    // 2. Check if this is a TanStack Start project
    const packageJsonPath = join(PROJECT_DIR, 'package.json')
    if (!existsSync(packageJsonPath)) {
      const totalMs = Math.round(performance.now() - startTime)
      return c.json({ success: false, error: 'No package.json found', timings: { steps: timings, totalMs } }, 400)
    }
    
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies }
    isTanStackStart = !!deps['@tanstack/react-start']
    const hasPrisma = !!deps['@prisma/client'] || !!deps['prisma']
    markStep('parsePackageJson')
    
    console.log(`[project-runtime] Project type: ${isTanStackStart ? 'TanStack Start (Nitro)' : 'Plain Vite'}`)
    
    // 3. Install dependencies (skip if node_modules was copied from pre-installed template)
    const nodeModulesPath = join(PROJECT_DIR, 'node_modules')
    const nodeModulesExists = existsSync(nodeModulesPath)
    
    // Check if node_modules appears complete (has key packages)
    const hasReact = existsSync(join(nodeModulesPath, 'react'))
    const hasVite = existsSync(join(nodeModulesPath, 'vite'))
    const nodeModulesComplete = nodeModulesExists && hasReact && hasVite
    
    if (nodeModulesComplete) {
      console.log('[project-runtime] ⚡ node_modules already exists (pre-installed from template) - skipping bun install')
      markStep('bunInstall (skipped - pre-installed)')
    } else {
      console.log('[project-runtime] ⏱️  Installing dependencies...')
      const installProc = Bun.spawn(['bun', 'install'], {
        cwd: PROJECT_DIR,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await installProc.exited
      markStep('bunInstall')
      
      if (installProc.exitCode !== 0) {
        console.error('[project-runtime] Install failed')
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ success: false, error: 'Dependency installation failed', timings: { steps: timings, totalMs } }, 500)
      }
    }
    
    // 4. Run prisma generate and db push if prisma is present
    if (hasPrisma) {
      // 4a. Wait for PostgreSQL to be ready (critical for sidecar postgres)
      // Without this wait, prisma db push fails silently because postgres isn't accepting connections
      const postgresReady = await waitForPostgresReady(30000)
      markStep('waitForPostgres')
      
      if (!postgresReady) {
        console.error('[project-runtime] ❌ PostgreSQL not ready - cannot run prisma commands')
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ 
          success: false, 
          error: 'PostgreSQL database not ready. The postgres sidecar may still be starting.',
          hint: 'Wait a few seconds and try again, or check pod logs for postgres container.',
          timings: { steps: timings, totalMs } 
        }, 503)
      }
      
      // 4b. Run prisma generate (skip if Prisma client already exists from template)
      const prismaClientExists = existsSync(join(PROJECT_DIR, 'node_modules', '.prisma', 'client', 'index.js'))
      
      if (prismaClientExists) {
        console.log('[project-runtime] ⚡ Prisma client already exists (pre-generated from template) - skipping prisma generate')
        markStep('prismaGenerate (skipped - pre-generated)')
      } else {
        console.log('[project-runtime] ⏱️  Running prisma generate...')
        const prismaGenProc = Bun.spawn(['bunx', 'prisma', 'generate'], {
          cwd: PROJECT_DIR,
          stdout: 'inherit',
          stderr: 'inherit',
        })
        await prismaGenProc.exited
        markStep('prismaGenerate')
        
        if (prismaGenProc.exitCode !== 0) {
          console.error('[project-runtime] ❌ prisma generate failed with exit code:', prismaGenProc.exitCode)
          const totalMs = Math.round(performance.now() - startTime)
          return c.json({ 
            success: false, 
            error: `prisma generate failed with exit code ${prismaGenProc.exitCode}`,
            hint: 'Check that the prisma schema is valid.',
            timings: { steps: timings, totalMs } 
          }, 500)
        }
      }
      
      // 4c. Run prisma db push with --accept-data-loss flag for development
      // This ensures tables are created even if there are schema changes
      console.log('[project-runtime] ⏱️  Running prisma db push...')
      const prismaPushProc = Bun.spawn(['bunx', 'prisma', 'db', 'push', '--accept-data-loss'], {
        cwd: PROJECT_DIR,
        stdout: 'inherit',
        stderr: 'inherit',
        env: {
          ...process.env,
          // Ensure DATABASE_URL from environment takes precedence over .env file
          DATABASE_URL: process.env.DATABASE_URL,
        },
      })
      await prismaPushProc.exited
      markStep('prismaDbPush')
      
      if (prismaPushProc.exitCode !== 0) {
        console.error('[project-runtime] ❌ prisma db push failed with exit code:', prismaPushProc.exitCode)
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ 
          success: false, 
          error: `prisma db push failed with exit code ${prismaPushProc.exitCode}`,
          hint: 'Check database connection and schema compatibility. DATABASE_URL: ' + 
                (process.env.DATABASE_URL ? '[set]' : '[not set]'),
          timings: { steps: timings, totalMs } 
        }, 500)
      }
      
      console.log('[project-runtime] ✅ Database schema pushed successfully')
    }
    
    // 5. Build the project (skip if build artifacts are up-to-date)
    // Conditions to skip build:
    //   - Build artifacts exist (dist/ or .output/)
    //   - force=false (force=true always rebuilds)
    //   - No source files are newer than the build artifacts
    const url = new URL(c.req.url)
    const forceRebuild = url.searchParams.get('force') === 'true'
    
    const nitroOutputPath = join(PROJECT_DIR, '.output', 'server', 'index.mjs')
    const viteDistPath = join(PROJECT_DIR, 'dist', 'index.html')
    const nitroOutputExists = existsSync(nitroOutputPath)
    const viteDistExists = existsSync(viteDistPath)
    const buildExists = isTanStackStart ? nitroOutputExists : viteDistExists
    
    // Check if source files have been modified since the last build
    let sourceFilesModified = false
    if (buildExists && !forceRebuild) {
      const buildPath = isTanStackStart ? nitroOutputPath : viteDistPath
      const buildMtime = statSync(buildPath).mtimeMs
      
      // Check if any source files are newer than the build
      const srcDir = join(PROJECT_DIR, 'src')
      if (existsSync(srcDir)) {
        const checkSourceFiles = (dir: string): boolean => {
          try {
            const entries = readdirSync(dir, { withFileTypes: true })
            for (const entry of entries) {
              const fullPath = join(dir, entry.name)
              if (entry.isDirectory() && entry.name !== 'node_modules') {
                if (checkSourceFiles(fullPath)) return true
              } else if (entry.isFile() && /\.(tsx?|jsx?|css|scss|html|json)$/.test(entry.name)) {
                const fileMtime = statSync(fullPath).mtimeMs
                if (fileMtime > buildMtime) {
                  console.log(`[project-runtime] Source file modified: ${fullPath} (${new Date(fileMtime).toISOString()} > ${new Date(buildMtime).toISOString()})`)
                  return true
                }
              }
            }
          } catch {
            // Ignore errors reading directories
          }
          return false
        }
        sourceFilesModified = checkSourceFiles(srcDir)
      }
    }
    
    if (buildExists && !forceRebuild && !sourceFilesModified) {
      console.log('[project-runtime] ⚡ Build output already exists and up-to-date - skipping vite build')
      markStep('viteBuild (skipped - up-to-date)')
    } else {
      if (sourceFilesModified) {
        console.log('[project-runtime] ⏱️  Rebuilding project (source files modified)...')
      } else if (forceRebuild && buildExists) {
        console.log('[project-runtime] ⏱️  Rebuilding project (force=true)...')
      } else {
        console.log('[project-runtime] ⏱️  Building project...')
      }
      console.log('[project-runtime] ════════════════════════════════════════')
      console.log('[project-runtime] 🔨 VITE BUILD STARTING...')
      console.log('[project-runtime] ════════════════════════════════════════')
      const buildStartTime = performance.now()
      const buildProc = Bun.spawn(['bun', '--bun', 'vite', 'build'], {
        cwd: PROJECT_DIR,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await buildProc.exited
      const buildDuration = Math.round(performance.now() - buildStartTime)
      console.log('[project-runtime] ════════════════════════════════════════')
      console.log(`[project-runtime] ✅ VITE BUILD COMPLETED: ${buildDuration}ms (${(buildDuration / 1000).toFixed(2)}s)`)
      console.log('[project-runtime] ════════════════════════════════════════')
      markStep('viteBuild')
      
      if (buildProc.exitCode !== 0) {
        console.error('[project-runtime] Build failed')
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ success: false, error: 'Build failed', timings: { steps: timings, totalMs } }, 500)
      }
    }
    
    // 6. Start Nitro server for TanStack Start
    if (isTanStackStart) {
      const serverPath = join(PROJECT_DIR, '.output', 'server', 'index.mjs')
      if (!existsSync(serverPath)) {
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ success: false, error: 'Nitro build output not found at .output/server/index.mjs', timings: { steps: timings, totalMs } }, 500)
      }
      
      console.log(`[project-runtime] ⏱️  Starting Nitro server on port ${NITRO_SERVER_PORT}...`)
      nitroProcess = Bun.spawn(['bun', 'run', serverPath], {
        cwd: PROJECT_DIR,
        env: { ...process.env, PORT: String(NITRO_SERVER_PORT) },
        stdout: 'inherit',
        stderr: 'inherit',
      })
      
      // Wait for server to be ready with exponential backoff (max ~2s total)
      let serverReady = false
      const maxAttempts = 10
      const baseDelayMs = 100
      
      for (let attempt = 1; attempt <= maxAttempts && !serverReady; attempt++) {
        try {
          const healthCheck = await fetch(`http://localhost:${NITRO_SERVER_PORT}/`, {
            signal: AbortSignal.timeout(500),
          })
          if (healthCheck.ok || healthCheck.status < 500) {
            serverReady = true
            console.log(`[project-runtime] ⏱️  Nitro server ready after ${attempt} attempt(s)`)
          }
        } catch (e) {
          // Server not ready yet, wait with exponential backoff
          const delay = Math.min(baseDelayMs * attempt, 500)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
      markStep('startNitroServer')
      
      if (!serverReady) {
        console.warn('[project-runtime] Nitro server may still be starting after health checks...')
      }
    }
    
    const totalMs = Math.round(performance.now() - startTime)
    console.log('[project-runtime] ════════════════════════════════════════')
    console.log(`[project-runtime] 🎉 PREVIEW RESTART COMPLETED: ${totalMs}ms (${(totalMs / 1000).toFixed(2)}s)`)
    console.log('[project-runtime] ════════════════════════════════════════')
    console.log('[project-runtime] ⏱️  Timing breakdown:')
    for (const { step, durationMs } of timings) {
      console.log(`[project-runtime]    • ${step}: ${durationMs}ms`)
    }
    console.log('[project-runtime] ════════════════════════════════════════')
    
    return c.json({
      success: true,
      mode: isTanStackStart ? 'nitro' : 'static',
      port: isTanStackStart ? NITRO_SERVER_PORT : null,
      timings: { steps: timings, totalMs },
    })
  } catch (error: any) {
    const totalMs = Math.round(performance.now() - startTime)
    console.error(`[project-runtime] ⏱️  Preview restart error after ${totalMs}ms:`, error)
    return c.json({ success: false, error: error.message, timings: { steps: timings, totalMs } }, 500)
  }
})

console.log(`[project-runtime] Preview mode: ${isTanStackStart ? 'TanStack Start (proxy)' : 'Static files'}`)

/**
 * MIME type mapping for static files (used for plain Vite projects)
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.'))
  return MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream'
}

/**
 * Rewrite HTML content for preview to work through a proxy path.
 * Vite/React apps assume they run at root, but we serve through /preview/.
 * When accessed through API proxy, the full path is /api/projects/:id/preview/.
 * 
 * This fixes dynamic imports and asset loading by:
 * - Rewriting absolute paths in link/script tags to use the proxy path
 * - Adding a <base> tag with the correct proxy path
 * - Patching fetch/XHR to handle dynamically constructed URLs
 * 
 * @param html - The original HTML content
 * @param basePath - The full proxy base path (e.g., '/api/projects/xyz/preview/')
 */
function rewritePreviewHtml(html: string, basePath: string = '/preview/'): string {
  // Ensure basePath ends with /
  if (!basePath.endsWith('/')) {
    basePath += '/'
  }
  
  // Rewrite absolute paths in link tags (modulepreload, stylesheet, etc.)
  // This is critical because <link rel="modulepreload" href="/assets/..."> is fetched
  // by the browser before any JavaScript runs, so the script patch doesn't help
  html = html.replace(/<link([^>]*)\s+href="\/assets\/([^"]+)"([^>]*)>/gi, 
    `<link$1 href="${basePath}assets/$2"$3>`)
  html = html.replace(/<link([^>]*)\s+href="\/src\/([^"]+)"([^>]*)>/gi, 
    `<link$1 href="${basePath}src/$2"$3>`)
  
  // Rewrite absolute paths in script tags
  html = html.replace(/<script([^>]*)\s+src="\/assets\/([^"]+)"([^>]*)>/gi, 
    `<script$1 src="${basePath}assets/$2"$3>`)
  html = html.replace(/<script([^>]*)\s+src="\/src\/([^"]+)"([^>]*)>/gi, 
    `<script$1 src="${basePath}src/$2"$3>`)
  
  // Check if already has a base tag
  if (html.includes('<base')) {
    // Replace existing base tag
    html = html.replace(/<base[^>]*>/, `<base href="${basePath}">`)
  } else if (html.includes('<head>')) {
    // Inject base tag after <head>
    html = html.replace('<head>', `<head><base href="${basePath}">`)
  }
  
  // Inject a script to patch dynamic imports and fetch calls
  // This handles cases where code constructs URLs dynamically at runtime
  const patchScript = `
<script>
(function() {
  var proxyBase = ${JSON.stringify(basePath)};
  
  // Store original fetch
  var originalFetch = window.fetch;
  window.fetch = function(url, options) {
    if (typeof url === 'string') {
      // Rewrite absolute /assets/ paths to use proxy base
      if (url.startsWith('/assets/') || url.startsWith('/src/')) {
        url = proxyBase + url.substring(1);
      }
      // Fix any http:// to https:// if current page is https
      if (window.location.protocol === 'https:' && url.startsWith('http://')) {
        url = url.replace('http://', 'https://');
      }
    }
    return originalFetch.call(this, url, options);
  };
  
  // Store original XMLHttpRequest.open
  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof url === 'string') {
      if (url.startsWith('/assets/') || url.startsWith('/src/')) {
        url = proxyBase + url.substring(1);
      }
      if (window.location.protocol === 'https:' && url.startsWith('http://')) {
        url = url.replace('http://', 'https://');
      }
    }
    return originalOpen.apply(this, [method, url].concat(args));
  };
  
  console.log('[Preview Proxy] URL rewriting enabled, base:', proxyBase);
})();
</script>`
  
  // Insert patch script early in head (after base tag if present)
  if (html.includes('<base')) {
    html = html.replace(/<base[^>]*>/, (match) => match + patchScript)
  } else if (html.includes('<head>')) {
    html = html.replace('<head>', `<head>${patchScript}`)
  }
  
  return html
}

/**
 * Preview handler - proxies to TanStack Start server or serves static files.
 * 
 * For TanStack Start projects:
 * - Proxies all requests to the running TanStack Start server on port 3000
 * - Full SSR, server functions, and routing handled by TanStack
 * 
 * For plain Vite projects:
 * - Serves pre-built static assets from dist/
 */
app.get('/preview/*', async (c) => {
  const relativePath = c.req.path.replace('/preview', '') || '/'
  
  // Get external proxy base path from header (set by API server when proxying)
  // Falls back to local /preview/ path if not proxied through API
  const externalBasePath = c.req.header('X-Proxy-Base-Path') || '/preview/'
  
  // In fast start mode, show loading page if build not ready
  if (FAST_START_MODE) {
    const buildStatus = getBuildStatus()
    if (!buildStatus.ready) {
      return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loading Preview...</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .spinner {
      width: 50px;
      height: 50px;
      border: 3px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 1s ease-in-out infinite;
      margin: 0 auto 1.5rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { opacity: 0.8; font-size: 0.9rem; }
    .status { 
      margin-top: 1rem; 
      padding: 0.5rem 1rem; 
      background: rgba(255,255,255,0.2); 
      border-radius: 20px;
      font-size: 0.8rem;
      text-transform: capitalize;
    }
  </style>
  <script>
    // Auto-refresh when build completes
    setInterval(async () => {
      try {
        const res = await fetch('/build-status');
        const data = await res.json();
        if (data.ready) location.reload();
      } catch {}
    }, 2000);
  </script>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h1>Building Your App</h1>
    <p>Installing dependencies and compiling...</p>
    <div class="status">${buildStatus.status}</div>
  </div>
</body>
</html>
      `, 200)
    }
  }
  
  // TanStack Start: proxy to the running server
  if (isTanStackStart) {
    const targetUrl = `http://localhost:${NITRO_SERVER_PORT}${relativePath}`
    console.log(`[project-runtime] Proxying preview to TanStack: ${targetUrl}`)
    
    try {
      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers: {
          'Host': `localhost:${NITRO_SERVER_PORT}`,
          'Accept': c.req.header('Accept') || '*/*',
          'Accept-Encoding': c.req.header('Accept-Encoding') || '',
        },
      })
      
      // Get response body
      const contentType = response.headers.get('Content-Type') || 'text/html'
      const body = await response.arrayBuffer()
      
      // Rewrite HTML responses to fix asset paths when accessed through proxy
      if (contentType.includes('text/html')) {
        const html = new TextDecoder().decode(body)
        const rewrittenHtml = rewritePreviewHtml(html, externalBasePath)
        return new Response(rewrittenHtml, {
          status: response.status,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(Buffer.byteLength(rewrittenHtml)),
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
      
      // Rewrite JavaScript responses to fix dynamic import paths
      // Vite generates code like import('/assets/...') which needs to be rewritten
      if (contentType.includes('javascript') || contentType.includes('application/javascript')) {
        let js = new TextDecoder().decode(body)
        // Rewrite absolute paths in dynamic imports: import("/assets/...") and import('/assets/...')
        js = js.replace(/import\(["']\/assets\//g, `import("${externalBasePath}assets/`)
        js = js.replace(/import\(["']\/src\//g, `import("${externalBasePath}src/`)
        // Also handle other common patterns: __vite_ssr_dynamic_import__, etc.
        js = js.replace(/"\/assets\//g, `"${externalBasePath}assets/`)
        js = js.replace(/'\/assets\//g, `'${externalBasePath}assets/`)
        js = js.replace(/"\/src\//g, `"${externalBasePath}src/`)
        js = js.replace(/'\/src\//g, `'${externalBasePath}src/`)
        return new Response(js, {
          status: response.status,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(Buffer.byteLength(js)),
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
      
      return new Response(body, {
        status: response.status,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch (error: any) {
      console.error('[project-runtime] TanStack proxy error:', error)
      return c.html(`
        <html>
          <body style="font-family: system-ui; padding: 2rem;">
            <h1>Preview Loading...</h1>
            <p>The TanStack Start server is starting up. Please wait a moment and refresh.</p>
            <p style="color: #666; font-size: 0.9em;">Error: ${error.message}</p>
            <script>setTimeout(() => location.reload(), 3000)</script>
          </body>
        </html>
      `, 503)
    }
  }
  
  // Plain Vite: serve static files from dist/
  let filePath = relativePath
  if (filePath.startsWith('/')) {
    filePath = filePath.substring(1)
  }
  if (filePath === '' || filePath === '/') {
    filePath = 'index.html'
  }
  
  const absolutePath = join(DIST_DIR, filePath)
  
  console.log(`[project-runtime] Serving static preview: ${filePath} from ${absolutePath}`)
  
  // Helper to serve HTML with rewriting for proxy support
  const serveHtml = (htmlPath: string) => {
    const content = readFileSync(htmlPath)
    const html = content.toString()
    const rewrittenHtml = rewritePreviewHtml(html, externalBasePath)
    return new Response(rewrittenHtml, {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Content-Length': String(Buffer.byteLength(rewrittenHtml)),
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }
  
  try {
    // Security: prevent path traversal
    if (!absolutePath.startsWith(DIST_DIR)) {
      return c.text('Forbidden', 403)
    }
    
    // Check if file exists
    if (!existsSync(absolutePath)) {
      // For SPA routing: if file not found and not an asset, serve index.html
      const ext = filePath.substring(filePath.lastIndexOf('.'))
      if (!MIME_TYPES[ext.toLowerCase()]) {
        const indexPath = join(DIST_DIR, 'index.html')
        if (existsSync(indexPath)) {
          return serveHtml(indexPath)
        }
      }
      
      console.log(`[project-runtime] File not found: ${absolutePath}`)
      return c.text('Not Found', 404)
    }
    
    // Check if it's a directory
    const stats = statSync(absolutePath)
    if (stats.isDirectory()) {
      const indexPath = join(absolutePath, 'index.html')
      if (existsSync(indexPath)) {
        return serveHtml(indexPath)
      }
      return c.text('Not Found', 404)
    }
    
    // Read and serve the file
    const content = readFileSync(absolutePath)
    const mimeType = getMimeType(absolutePath)
    
    // Rewrite HTML files for proxy support
    if (mimeType === 'text/html') {
      const html = content.toString()
      const rewrittenHtml = rewritePreviewHtml(html, externalBasePath)
      return new Response(rewrittenHtml, {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Content-Length': String(Buffer.byteLength(rewrittenHtml)),
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }
    
    // Rewrite JavaScript files for proxy support (fix dynamic imports)
    if (mimeType === 'application/javascript' || mimeType === 'text/javascript') {
      let js = content.toString()
      // Rewrite absolute paths in dynamic imports: import("/assets/...") and import('/assets/...')
      js = js.replace(/import\(["']\/assets\//g, `import("${externalBasePath}assets/`)
      js = js.replace(/import\(["']\/src\//g, `import("${externalBasePath}src/`)
      // Also handle other common patterns
      js = js.replace(/"\/assets\//g, `"${externalBasePath}assets/`)
      js = js.replace(/'\/assets\//g, `'${externalBasePath}assets/`)
      js = js.replace(/"\/src\//g, `"${externalBasePath}src/`)
      js = js.replace(/'\/src\//g, `'${externalBasePath}src/`)
      return new Response(js, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(Buffer.byteLength(js)),
          'Cache-Control': 'no-cache', // Don't cache rewritten JS
          'Access-Control-Allow-Origin': '*',
        },
      })
    }
    
    // Set cache headers (long cache for hashed assets)
    const isHashedAsset = /\.[a-f0-9]{8,}\.(js|css|woff2?|ttf|png|jpg|svg)$/i.test(filePath)
    const cacheControl = isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
    
    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(content.length),
        'Cache-Control': cacheControl,
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (error: any) {
    console.error('[project-runtime] Static file serve error:', error)
    return c.json({
      error: { code: 'static_serve_error', message: error.message || 'Failed to serve file' }
    }, 500)
  }
})

// Handle base /preview path (redirect to /preview/)
app.get('/preview', (c) => {
  return c.redirect('/preview/')
})

// =============================================================================
// Subdomain Preview Routes - Direct access via preview--{projectId}--{env}.{domain}
// =============================================================================
// When accessed via subdomain, serve the app at root (/) instead of /preview/
// This eliminates the need for path rewriting and makes dynamic imports work correctly.
// Authentication is via __preview_token query parameter (JWT).

/**
 * Validate preview token middleware for subdomain access.
 * Called when __preview_token is present in query string.
 */
async function validateSubdomainAccess(token: string): Promise<PreviewTokenPayload | null> {
  if (!token) {
    return null
  }
  
  const payload = await verifyPreviewToken(token)
  if (!payload) {
    return null
  }
  
  // Verify the token is for this project
  if (payload.projectId !== PROJECT_ID) {
    console.log(`[project-runtime] Token project ID mismatch: expected ${PROJECT_ID}, got ${payload.projectId}`)
    return null
  }
  
  return payload
}

/**
 * Helper to check if request is from subdomain access (has __preview_token)
 */
function isSubdomainAccess(c: any): boolean {
  return !!c.req.query('__preview_token')
}

/**
 * Root path handler for subdomain access.
 * Serves the app directly without any path rewriting.
 * Uses app.all() to handle all HTTP methods (GET, POST, etc.) for API routes.
 */
app.all('/*', async (c) => {
  // Only handle subdomain access (with token) at root
  // Other root paths are handled by specific routes above
  const token = c.req.query('__preview_token')
  
  // If no token and this is not a known API path, this might be a subdomain access
  // Check Host header to determine if this is subdomain access
  const host = c.req.header('host') || ''
  const isPreviewSubdomain = host.startsWith('preview--')
  
  // If not subdomain access and no token, let other routes handle it
  // This is a catch-all so we need to be careful not to intercept other routes
  const path = c.req.path
  
  // Skip if this is an API/internal route
  if (path.startsWith('/health') || 
      path.startsWith('/ready') || 
      path.startsWith('/chat') ||
      path.startsWith('/files') ||
      path.startsWith('/preview') ||
      path.startsWith('/runtime') ||
      path.startsWith('/build-status')) {
    return c.notFound()
  }
  
  // Validate token if present (subdomain access requires valid token)
  if (token) {
    const payload = await validateSubdomainAccess(token)
    if (!payload) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired preview token' } }, 401)
    }
  } else if (!isPreviewSubdomain) {
    // No token and not subdomain - this shouldn't reach here for valid requests
    // Let it fall through to notFound
    return c.notFound()
  }
  
  // === Subdomain access: serve app directly at root ===
  const relativePath = c.req.path || '/'
  
  // In fast start mode, show loading page if build not ready
  if (FAST_START_MODE) {
    const buildStatus = getBuildStatus()
    if (!buildStatus.ready) {
      return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loading Preview...</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    .container { text-align: center; padding: 2rem; }
    .spinner {
      width: 50px; height: 50px;
      border: 3px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 1s ease-in-out infinite;
      margin: 0 auto 1.5rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { opacity: 0.8; font-size: 0.9rem; }
    .status { margin-top: 1rem; padding: 0.5rem 1rem; background: rgba(255,255,255,0.2); border-radius: 20px; font-size: 0.8rem; }
  </style>
  <script>
    setInterval(async () => {
      try {
        const res = await fetch('/build-status');
        const data = await res.json();
        if (data.ready) location.reload();
      } catch {}
    }, 2000);
  </script>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h1>Building Your App</h1>
    <p>Installing dependencies and compiling...</p>
    <div class="status">${buildStatus.status}</div>
  </div>
</body>
</html>
      `, 200)
    }
  }
  
  // TanStack Start: proxy to the running server
  if (isTanStackStart) {
    const targetUrl = `http://localhost:${NITRO_SERVER_PORT}${relativePath}`
    const method = c.req.method
    console.log(`[project-runtime] Subdomain: proxying ${method} to TanStack at ${targetUrl}`)
    
    try {
      // Build headers for the proxy request
      const proxyHeaders: Record<string, string> = {
        'Host': `localhost:${NITRO_SERVER_PORT}`,
        'Accept': c.req.header('Accept') || '*/*',
        'Accept-Encoding': c.req.header('Accept-Encoding') || '',
      }
      
      // Forward Content-Type for POST/PUT/PATCH requests
      const contentType = c.req.header('Content-Type')
      if (contentType) {
        proxyHeaders['Content-Type'] = contentType
      }
      
      // Forward cookies for auth
      const cookies = c.req.header('Cookie')
      if (cookies) {
        proxyHeaders['Cookie'] = cookies
      }
      
      // Build fetch options
      const fetchOptions: RequestInit = {
        method,
        headers: proxyHeaders,
      }
      
      // Forward request body for POST/PUT/PATCH
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          const bodyBuffer = await c.req.arrayBuffer()
          if (bodyBuffer.byteLength > 0) {
            fetchOptions.body = bodyBuffer
          }
        } catch {
          // No body or couldn't read body - that's ok
        }
      }
      
      const response = await fetch(targetUrl, fetchOptions)
      
      const responseContentType = response.headers.get('Content-Type') || 'text/html'
      const body = await response.arrayBuffer()
      
      // Build response headers
      const responseHeaders: Record<string, string> = {
        'Content-Type': responseContentType,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
      }
      
      // Forward Set-Cookie headers for auth
      const setCookie = response.headers.get('Set-Cookie')
      if (setCookie) {
        responseHeaders['Set-Cookie'] = setCookie
      }
      
      // No rewriting needed for subdomain access - serve directly!
      return new Response(body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[project-runtime] Subdomain TanStack proxy error:', error)
      return c.html(`
        <html>
          <body style="font-family: system-ui; padding: 2rem;">
            <h1>Preview Loading...</h1>
            <p>The server is starting up. Please wait a moment and refresh.</p>
            <script>setTimeout(() => location.reload(), 3000)</script>
          </body>
        </html>
      `, 503)
    }
  }
  
  // Plain Vite: serve static files from dist/
  let filePath = relativePath
  if (filePath.startsWith('/')) {
    filePath = filePath.substring(1)
  }
  if (filePath === '' || filePath === '/') {
    filePath = 'index.html'
  }
  
  const absolutePath = join(DIST_DIR, filePath)
  console.log(`[project-runtime] Subdomain: serving static ${filePath} from ${absolutePath}`)
  
  try {
    // Security: prevent path traversal
    if (!absolutePath.startsWith(DIST_DIR)) {
      return c.text('Forbidden', 403)
    }
    
    // Check if file exists
    if (!existsSync(absolutePath)) {
      // For SPA routing: if file not found and not an asset, serve index.html
      const ext = filePath.substring(filePath.lastIndexOf('.'))
      if (!MIME_TYPES[ext.toLowerCase()]) {
        const indexPath = join(DIST_DIR, 'index.html')
        if (existsSync(indexPath)) {
          const content = readFileSync(indexPath)
          return new Response(content, {
            status: 200,
            headers: {
              'Content-Type': 'text/html',
              'Content-Length': String(content.length),
              'Cache-Control': 'no-cache',
              'Access-Control-Allow-Origin': '*',
            },
          })
        }
      }
      return c.text('Not Found', 404)
    }
    
    // Check if it's a directory
    const stats = statSync(absolutePath)
    if (stats.isDirectory()) {
      const indexPath = join(absolutePath, 'index.html')
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath)
        return new Response(content, {
          status: 200,
          headers: {
            'Content-Type': 'text/html',
            'Content-Length': String(content.length),
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
      return c.text('Not Found', 404)
    }
    
    // Read and serve the file (no rewriting needed for subdomain access!)
    const content = readFileSync(absolutePath)
    const mimeType = getMimeType(absolutePath)
    
    // Set cache headers (long cache for hashed assets)
    const isHashedAsset = /\.[a-f0-9]{8,}\.(js|css|woff2?|ttf|png|jpg|svg)$/i.test(filePath)
    const cacheControl = isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
    
    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(content.length),
        'Cache-Control': cacheControl,
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (error: any) {
    console.error('[project-runtime] Subdomain static serve error:', error)
    return c.json({
      error: { code: 'static_serve_error', message: error.message || 'Failed to serve file' }
    }, 500)
  }
})

// =============================================================================
// Files API (for Code Explorer)
// =============================================================================

/**
 * List all source files in the project directory.
 * Used by the Code Explorer panel in the UI.
 */
app.get('/files', (c) => {
  try {
    const files: Array<{ path: string; size: number; isDirectory: boolean }> = []
    
    function listRecursive(dir: string, prefix: string = '') {
      const entries = readdirSync(dir, { withFileTypes: true })
      
      for (const entry of entries) {
        // Skip node_modules, .git, and other common excludes
        if (['node_modules', '.git', '.next', 'dist', 'build', '.cache'].includes(entry.name)) {
          continue
        }
        
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        const fullPath = `${dir}/${entry.name}`
        
        if (entry.isDirectory()) {
          files.push({ path: relativePath, size: 0, isDirectory: true })
          listRecursive(fullPath, relativePath)
        } else {
          const stats = statSync(fullPath)
          files.push({ path: relativePath, size: stats.size, isDirectory: false })
        }
      }
    }
    
    listRecursive(PROJECT_DIR)
    
    return c.json({ files })
  } catch (error: any) {
    console.error('[project-runtime] Files list error:', error)
    return c.json({
      error: { code: 'files_error', message: error.message || 'Failed to list files' }
    }, 500)
  }
})

/**
 * Get all built dist files for publishing.
 * Returns files as base64-encoded content for S3 upload.
 * Used by the publish API to upload built assets.
 */
app.get('/api/dist-files', (c) => {
  try {
    const distDir = join(PROJECT_DIR, 'dist')
    
    if (!existsSync(distDir)) {
      return c.json({ 
        error: { code: 'no_dist', message: 'No dist directory found. Run a build first.' } 
      }, 404)
    }
    
    const files: Array<{ path: string; content: string }> = []
    
    function readRecursive(dir: string, prefix: string = '') {
      const entries = readdirSync(dir, { withFileTypes: true })
      
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        const fullPath = join(dir, entry.name)
        
        if (entry.isDirectory()) {
          readRecursive(fullPath, relativePath)
        } else {
          // Read file and encode as base64
          const content = readFileSync(fullPath)
          files.push({
            path: relativePath,
            content: content.toString('base64'),
          })
        }
      }
    }
    
    readRecursive(distDir)
    
    console.log(`[project-runtime] Returning ${files.length} dist files for publishing`)
    return c.json(files)
  } catch (error: any) {
    console.error('[project-runtime] Dist files error:', error)
    return c.json({
      error: { code: 'dist_error', message: error.message || 'Failed to read dist files' }
    }, 500)
  }
})

/**
 * Get content of a specific file.
 */
app.get('/files/*', (c) => {
  try {
    const filePath = c.req.path.replace('/files/', '')
    
    // Validate path (prevent directory traversal)
    const absolutePath = isAbsolute(filePath) ? filePath : resolve(PROJECT_DIR, filePath)
    const relativePath = relative(PROJECT_DIR, absolutePath)
    
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return c.json({
        error: { code: 'invalid_path', message: 'Path is outside project directory' }
      }, 400)
    }
    
    if (!existsSync(absolutePath)) {
      return c.json({
        error: { code: 'not_found', message: 'File not found' }
      }, 404)
    }
    
    const content = readFileSync(absolutePath, 'utf-8')
    return c.json({ path: filePath, content })
  } catch (error: any) {
    console.error('[project-runtime] File read error:', error)
    return c.json({
      error: { code: 'file_error', message: error.message || 'Failed to read file' }
    }, 500)
  }
})

// =============================================================================
// Terminal API (for Terminal Panel)
// =============================================================================

/**
 * Preset command definition
 */
interface PresetCommand {
  id: string
  label: string
  description: string
  category: string
  dangerous: boolean
}

/**
 * Available preset commands that users can execute
 */
const PRESET_COMMANDS: PresetCommand[] = [
  // Package Management
  { id: 'bun-install', label: 'Install Dependencies', description: 'Install all project dependencies with bun', category: 'package', dangerous: false },
  // Database (Prisma)
  { id: 'prisma-generate', label: 'Generate Prisma Client', description: 'Regenerate Prisma client after schema changes', category: 'database', dangerous: false },
  { id: 'prisma-push', label: 'Push Schema', description: 'Push schema changes to the database', category: 'database', dangerous: false },
  { id: 'prisma-reset', label: 'Reset Database', description: 'Wipe and recreate database from schema (destructive)', category: 'database', dangerous: true },
  { id: 'prisma-migrate', label: 'Run Migrations', description: 'Create and apply database migrations', category: 'database', dangerous: false },
  // Testing
  { id: 'playwright-test', label: 'Run Tests', description: 'Run Playwright E2E tests', category: 'test', dangerous: false },
  // Build
  { id: 'typecheck', label: 'Type Check', description: 'Run TypeScript type checking', category: 'build', dangerous: false },
  { id: 'build', label: 'Build for Production', description: 'Create production build', category: 'build', dangerous: false },
]

/**
 * Map command ID to actual shell command
 */
const COMMAND_MAP: Record<string, { command: string; timeout: number }> = {
  'bun-install': { command: 'bun install', timeout: 120000 },
  'prisma-generate': { command: 'bunx prisma generate', timeout: 60000 },
  'prisma-push': { command: 'bunx prisma db push', timeout: 60000 },
  'prisma-reset': { command: 'bunx prisma db push --force-reset', timeout: 30000 },
  'prisma-migrate': { command: 'bunx prisma migrate dev --name auto', timeout: 60000 },
  'playwright-test': { command: 'bunx playwright test', timeout: 180000 },
  'typecheck': { command: 'bunx tsc --noEmit', timeout: 60000 },
  'build': { command: 'bun run build', timeout: 120000 },
}

/**
 * List available terminal commands
 */
app.get('/terminal/commands', (c) => {
  // Group commands by category
  const commandsByCategory = PRESET_COMMANDS.reduce((acc, cmd) => {
    if (!acc[cmd.category]) {
      acc[cmd.category] = []
    }
    acc[cmd.category].push(cmd)
    return acc
  }, {} as Record<string, PresetCommand[]>)

  return c.json({ commands: commandsByCategory })
})

/**
 * Execute a preset command
 */
app.post('/terminal/exec', async (c) => {
  try {
    const body = await c.req.json() as { commandId: string; confirmDangerous?: boolean }
    const { commandId, confirmDangerous } = body
    
    // Find the preset command
    const preset = PRESET_COMMANDS.find(cmd => cmd.id === commandId)
    if (!preset) {
      return c.json({ error: { code: 'unknown_command', message: `Unknown command: ${commandId}` } }, 400)
    }
    
    // Require confirmation for dangerous commands
    if (preset.dangerous && !confirmDangerous) {
      return c.json({ error: { code: 'confirmation_required', message: 'This command is destructive. Set confirmDangerous: true to proceed.' } }, 400)
    }
    
    const cmdConfig = COMMAND_MAP[commandId]
    if (!cmdConfig) {
      return c.json({ error: { code: 'command_not_found', message: 'Command configuration not found' } }, 500)
    }
    
    console.log(`[project-runtime] Executing terminal command: ${cmdConfig.command}`)
    
    // Create streaming response
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    
    // Execute command asynchronously
    ;(async () => {
      try {
        await writer.write(encoder.encode(`$ ${cmdConfig.command}\n\n`))
        
        const proc = Bun.spawn(['sh', '-c', cmdConfig.command], {
          cwd: PROJECT_DIR,
          env: { ...process.env, FORCE_COLOR: '1', CI: 'true' },
        })
        
        // Stream stdout
        const reader = proc.stdout.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await writer.write(value)
        }
        
        // Stream stderr
        if (proc.stderr) {
          const stderrReader = proc.stderr.getReader()
          while (true) {
            const { done, value } = await stderrReader.read()
            if (done) break
            await writer.write(value)
          }
        }
        
        const exitCode = await proc.exited
        await writer.write(encoder.encode(`\n\n[Process exited with code ${exitCode}]\n`))
        await writer.close()
      } catch (err: any) {
        await writer.write(encoder.encode(`[ERROR] ${err.message}\n`))
        await writer.close()
      }
    })()
    
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (error: any) {
    console.error('[project-runtime] Terminal exec error:', error)
    return c.json({ error: { code: 'exec_error', message: error.message || 'Failed to execute command' } }, 500)
  }
})

// =============================================================================
// Tests API (for Tests Panel)
// =============================================================================

/**
 * Test file with its test cases
 */
interface TestFile {
  /** Relative path to test file */
  path: string
  /** File name */
  name: string
  /** Test cases discovered in file */
  tests: TestCase[]
}

/**
 * Individual test case
 */
interface TestCase {
  /** Test title */
  title: string
  /** Line number where test is defined */
  line?: number
  /** Full test path (describe > test) */
  fullTitle: string
}

/**
 * Parse test file to extract test cases
 * Looks for test('...') and it('...') patterns
 */
function parseTestCases(filePath: string): TestCase[] {
  const tests: TestCase[] = []
  
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    
    // Stack to track describe blocks
    const describeStack: string[] = []
    
    lines.forEach((line, index) => {
      // Match describe blocks
      const describeMatch = line.match(/(?:describe|test\.describe)\s*\(\s*['"`]([^'"`]+)['"`]/)
      if (describeMatch) {
        describeStack.push(describeMatch[1])
      }
      
      // Match end of describe blocks (rough heuristic)
      if (line.match(/^\s*\}\s*\)\s*;?\s*$/)) {
        describeStack.pop()
      }
      
      // Match test/it blocks
      const testMatch = line.match(/(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/)
      if (testMatch) {
        const title = testMatch[1]
        const fullTitle = describeStack.length > 0 
          ? `${describeStack.join(' › ')} › ${title}`
          : title
        
        tests.push({
          title,
          line: index + 1,
          fullTitle,
        })
      }
    })
  } catch {
    // File can't be read, return empty
  }
  
  return tests
}

/**
 * Recursively find test files in a directory
 */
function findTestFiles(dir: string, baseDir: string): TestFile[] {
  const files: TestFile[] = []
  
  if (!existsSync(dir)) {
    return files
  }
  
  const entries = readdirSync(dir, { withFileTypes: true })
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    
    if (entry.isDirectory()) {
      // Skip node_modules
      if (entry.name === 'node_modules') continue
      files.push(...findTestFiles(fullPath, baseDir))
    } else if (entry.isFile()) {
      // Match test files
      if (entry.name.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) {
        const relativePath = relative(baseDir, fullPath)
        const tests = parseTestCases(fullPath)
        
        files.push({
          path: relativePath,
          name: entry.name,
          tests,
        })
      }
    }
  }
  
  return files
}

/**
 * GET /tests/list - List test files and cases in the project
 */
app.get('/tests/list', (c) => {
  console.log(`[project-runtime] Listing tests for project ${PROJECT_ID}`)
  
  // Look for test files in common locations
  const testLocations = ['tests', 'test', '__tests__', 'e2e', 'spec']
  let allFiles: TestFile[] = []
  
  for (const loc of testLocations) {
    const testDir = join(PROJECT_DIR, loc)
    if (existsSync(testDir)) {
      allFiles.push(...findTestFiles(testDir, PROJECT_DIR))
    }
  }
  
  // Also check root for test files
  try {
    const rootEntries = readdirSync(PROJECT_DIR, { withFileTypes: true })
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) {
        const tests = parseTestCases(join(PROJECT_DIR, entry.name))
        allFiles.push({
          path: entry.name,
          name: entry.name,
          tests,
        })
      }
    }
  } catch {
    // Ignore errors reading root
  }

  // Deduplicate by path
  const seen = new Set<string>()
  const files = allFiles.filter(f => {
    if (seen.has(f.path)) return false
    seen.add(f.path)
    return true
  })

  return c.json({
    files,
    hasTests: files.length > 0,
    totalTests: files.reduce((sum, f) => sum + f.tests.length, 0),
  }, 200)
})

/**
 * POST /tests/run - Run tests with options
 * 
 * Request body:
 * - file?: string - Specific test file to run (relative path)
 * - testName?: string - Specific test name pattern (grep)
 * - headed?: boolean - Run in headed mode
 * - reporter?: 'list' | 'json' | 'line' - Reporter to use
 */
app.post('/tests/run', async (c) => {
  console.log(`[project-runtime] Running tests for project ${PROJECT_ID}`)
  
  // Parse request body
  let body: { 
    file?: string
    testName?: string
    headed?: boolean
    reporter?: 'list' | 'json' | 'line'
  } = {}
  
  try {
    body = await c.req.json()
  } catch {
    // Empty body is fine, use defaults
  }

  const { file, testName, headed, reporter = 'list' } = body

  // Build command
  let command = 'bunx playwright test'
  
  // Add specific file
  if (file) {
    command += ` "${file}"`
  }
  
  // Add test name filter (grep)
  if (testName) {
    command += ` --grep "${testName}"`
  }
  
  // Add headed mode
  if (headed) {
    command += ' --headed'
  }
  
  // Add reporter
  command += ` --reporter=${reporter}`

  console.log(`[project-runtime] Executing: ${command}`)

  // Create a streaming response
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  // Execute command asynchronously
  ;(async () => {
    try {
      // Write header
      await writer.write(encoder.encode(`$ ${command}\n\n`))

      // Spawn the command using Bun
      const proc = Bun.spawn(['sh', '-c', command], {
        cwd: PROJECT_DIR,
        env: {
          ...process.env,
          FORCE_COLOR: '1',
          CI: 'true',
        },
      })

      // Stream stdout
      const reader = proc.stdout.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await writer.write(value)
      }
      
      // Stream stderr
      if (proc.stderr) {
        const stderrReader = proc.stderr.getReader()
        while (true) {
          const { done, value } = await stderrReader.read()
          if (done) break
          await writer.write(value)
        }
      }

      const exitCode = await proc.exited
      await writer.write(encoder.encode(`\n\n[Process exited with code ${exitCode}]\n`))
      await writer.close()
    } catch (err: any) {
      try {
        await writer.write(encoder.encode(`[ERROR] ${err.message}\n`))
        await writer.close()
      } catch {
        // Writer already closed, ignore
      }
    }
  })()

  // Return streaming response
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

// =============================================================================
// Test Traces API - List and serve Playwright trace files
// =============================================================================

/**
 * GET /tests/traces
 * List all available trace files from test-results
 * Returns: { traces: [{ name, path, size, modified }] }
 */
app.get('/tests/traces', async (c) => {
  const testResultsDir = join(PROJECT_DIR, 'test-results')
  
  if (!existsSync(testResultsDir)) {
    return c.json({ traces: [] })
  }

  const traces: { name: string; path: string; size: number; modified: string }[] = []
  
  // Recursively find all trace.zip files
  const findTraces = (dir: string) => {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          findTraces(fullPath)
        } else if (entry.name === 'trace.zip' || entry.name.endsWith('-trace.zip')) {
          const stat = statSync(fullPath)
          const relativePath = fullPath.replace(PROJECT_DIR + '/', '')
          traces.push({
            name: entry.name,
            path: relativePath,
            size: stat?.size || 0,
            modified: stat?.mtime?.toISOString() || new Date().toISOString(),
          })
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }

  findTraces(testResultsDir)
  
  // Sort by modified date, newest first
  traces.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
  
  return c.json({ traces })
})

// CORS headers for trace viewer
const traceViewerCorsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*', // Allow all origins for trace viewing
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
}

/**
 * OPTIONS /tests/traces/*
 * Handle CORS preflight for trace files
 */
app.options('/tests/traces/*', (c) => {
  return new Response(null, {
    status: 204,
    headers: traceViewerCorsHeaders,
  })
})

/**
 * GET /tests/traces/:path
 * Download a specific trace file
 * The path should be URL-encoded
 * 
 * Includes CORS headers to allow trace.playwright.dev to load traces
 */
app.get('/tests/traces/*', async (c) => {
  // Get the path from the URL (everything after /tests/traces/)
  const tracePath = c.req.path.replace('/tests/traces/', '')
  
  if (!tracePath || tracePath === '') {
    return c.json({ error: 'No trace path specified' }, 400)
  }

  // Decode the path
  const decodedPath = decodeURIComponent(tracePath)
  const fullPath = join(PROJECT_DIR, decodedPath)
  
  // Security check - ensure path is within project directory
  const normalizedPath = fullPath.replace(/\.\./g, '')
  if (!normalizedPath.startsWith(PROJECT_DIR)) {
    return c.json({ error: 'Invalid path' }, 403)
  }

  // Check if file exists
  if (!existsSync(fullPath)) {
    return c.json({ error: 'Trace file not found' }, 404)
  }
  

  // Serve the trace file with CORS headers for trace.playwright.dev
  const file = Bun.file(fullPath)
  const stat = await file.stat()
  
  return new Response(file.stream(), {
    headers: {
      ...traceViewerCorsHeaders,
      'Content-Type': 'application/zip',
      'Content-Length': String(stat?.size || 0),
      'Content-Disposition': `inline; filename="${basename(fullPath)}"`, // inline for viewing
      'Cache-Control': 'no-cache',
    },
  })
})

/**
 * DELETE /tests/traces
 * Clear all test results (traces, screenshots, videos)
 */
app.delete('/tests/traces', async (c) => {
  const testResultsDir = join(PROJECT_DIR, 'test-results')
  
  if (!existsSync(testResultsDir)) {
    return c.json({ ok: true, message: 'No test results to clear' })
  }

  try {
    // Remove the entire test-results directory
    await Bun.spawn(['rm', '-rf', testResultsDir]).exited
    return c.json({ ok: true, message: 'Test results cleared' })
  } catch (error: any) {
    return c.json({ ok: false, error: error.message }, 500)
  }
})

// =============================================================================
// Database API (Prisma Studio) - Simplified for Kubernetes
// =============================================================================

// Note: In Kubernetes, we don't run Prisma Studio as a separate process.
// Instead, we return a URL that the client can use to access the database.
// For now, we'll indicate that database access is available through the runtime.

let prismaStudioProcess: ReturnType<typeof Bun.spawn> | null = null
const PRISMA_STUDIO_PORT = parseInt(process.env.PRISMA_STUDIO_PORT || '5555', 10)

/**
 * Start Prisma Studio internally (helper function)
 */
async function ensurePrismaStudioRunning(): Promise<{ ok: boolean; error?: string }> {
  const schemaPath = join(PROJECT_DIR, 'prisma', 'schema.prisma')
  
  // Check if Prisma schema exists
  if (!existsSync(schemaPath)) {
    return { ok: false, error: 'no_prisma_schema' }
  }
  
  // Check if Prisma Studio is already running
  if (prismaStudioProcess) {
    try {
      const response = await fetch(`http://localhost:${PRISMA_STUDIO_PORT}`)
      if (response.ok) {
        return { ok: true }
      }
    } catch {
      // Not reachable, need to restart
      prismaStudioProcess.kill()
      prismaStudioProcess = null
    }
  }
  
  // Start Prisma Studio
  console.log(`[project-runtime] Starting Prisma Studio on port ${PRISMA_STUDIO_PORT}...`)
  
  try {
    prismaStudioProcess = Bun.spawn(['bunx', 'prisma', 'studio', '--port', String(PRISMA_STUDIO_PORT), '--browser', 'none'], {
      cwd: PROJECT_DIR,
      env: { ...process.env },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    
    // Wait for studio to start (with retries)
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      try {
        const response = await fetch(`http://localhost:${PRISMA_STUDIO_PORT}`)
        if (response.ok) {
          return { ok: true }
        }
      } catch {
        // Keep waiting
      }
    }
    
    return { ok: true } // Assume it's starting
  } catch (error: any) {
    console.error('[project-runtime] Failed to start Prisma Studio:', error)
    return { ok: false, error: error.message || 'Failed to start Prisma Studio' }
  }
}

/**
 * Get Prisma Studio URL (starts if needed)
 * Note: Returns 'proxy' as URL indicator - actual access is via /database/proxy/*
 */
app.get('/database/url', async (c) => {
  const result = await ensurePrismaStudioRunning()
  
  if (!result.ok) {
    if (result.error === 'no_prisma_schema') {
      return c.json({
        status: 'error',
        url: null,
        error: { code: 'no_prisma_schema', message: 'No Prisma schema found in project' }
      }, 400)
    }
    return c.json({
      status: 'error',
      url: null,
      error: { code: 'start_failed', message: result.error || 'Failed to start Prisma Studio' }
    }, 500)
  }
  
  // Return 'proxy' as indicator - the API layer will construct the correct proxy URL
  return c.json({
    status: 'running',
    url: 'proxy', // Indicator that /database/proxy/* should be used
  })
})

/**
 * Rewrite HTML content for Prisma Studio to work through a proxy path.
 * Prisma Studio assumes it runs at root, but we serve it through a proxy path.
 * This fixes:
 * - Mixed content errors (http:// -> https://)
 * - Asset paths resolved correctly via base tag
 * - API calls intercepted and rewritten via fetch/XHR patching
 * 
 * @param html - The original HTML content
 * @param basePath - The full proxy base path (e.g., '/api/projects/xyz/database/proxy/')
 */
function rewritePrismaStudioHtml(html: string, basePath: string = '/database/proxy/'): string {
  // Ensure basePath ends with /
  if (!basePath.endsWith('/')) {
    basePath += '/'
  }
  
  // Inject a base tag to fix relative URLs - this is the most reliable approach
  // The base tag tells the browser to resolve all relative URLs from this path
  const baseTag = `<base href="${basePath}">`
  
  // Insert base tag after <head>
  if (html.includes('<head>')) {
    html = html.replace('<head>', `<head>${baseTag}`)
  }
  
  // Fix any hardcoded http://localhost:PORT URLs to be empty (rely on base tag)
  html = html.replace(/http:\/\/localhost:\d+/g, '')
  
  // Fix any absolute /api/ paths that bypass the base tag (in inline scripts)
  // Prisma Studio's JS sometimes constructs URLs like: location.origin + '/api/'
  // We inject a script to patch fetch/XMLHttpRequest to rewrite /api/ calls
  const patchScript = `
<script>
(function() {
  var proxyBase = ${JSON.stringify(basePath)};
  
  // Helper to rewrite URL for proxy
  function rewriteUrl(url) {
    if (typeof url !== 'string') return url;
    
    // Handle full URLs (http://... or https://...)
    if (url.indexOf('://') !== -1) {
      try {
        var urlObj = new URL(url);
        // Check if same domain or localhost - rewrite to use proxy
        if (urlObj.hostname === window.location.hostname || urlObj.hostname === 'localhost') {
          // Strip the origin and treat as relative path through proxy
          var path = urlObj.pathname;
          if (path.startsWith('/')) path = path.substring(1);
          url = proxyBase + path + urlObj.search;
          console.log('[Prisma Studio Proxy] Rewrote full URL to:', url);
        }
      } catch(e) {
        // Invalid URL, leave as-is
      }
    }
    // Handle /api/ calls  
    else if (url.startsWith('/api/') || url.startsWith('/api')) {
      url = proxyBase + url.substring(1);
    }
    // Handle other absolute paths at root
    else if (url.startsWith('/') && !url.startsWith(proxyBase)) {
      url = proxyBase + url.substring(1);
    }
    
    // Ensure https if page is https
    if (window.location.protocol === 'https:' && url.startsWith('http://')) {
      url = url.replace('http://', 'https://');
    }
    
    return url;
  }
  
  // Store original fetch
  var originalFetch = window.fetch;
  window.fetch = function(url, options) {
    url = rewriteUrl(url);
    return originalFetch.call(this, url, options);
  };
  
  // Store original XMLHttpRequest.open
  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var args = Array.prototype.slice.call(arguments, 2);
    url = rewriteUrl(url);
    return originalOpen.apply(this, [method, url].concat(args));
  };
  
  console.log('[Prisma Studio Proxy] URL rewriting enabled, base:', proxyBase);
})();
</script>`
  
  // Insert patch script early in head (after base tag)
  if (html.includes(baseTag)) {
    html = html.replace(baseTag, baseTag + patchScript)
  } else if (html.includes('<head>')) {
    html = html.replace('<head>', `<head>${patchScript}`)
  }
  
  return html
}

/**
 * Proxy requests to Prisma Studio
 * This allows the browser to access Prisma Studio through the API without CORS issues
 */
app.all('/database/proxy', async (c) => {
  const result = await ensurePrismaStudioRunning()
  if (!result.ok) {
    return c.json({ error: 'Prisma Studio not available' }, 503)
  }
  
  const targetUrl = `http://localhost:${PRISMA_STUDIO_PORT}/`
  console.log(`[project-runtime] Proxying database request to ${targetUrl}`)
  
  // Get external proxy base path from header (set by API server)
  // Falls back to local path if not proxied through API
  const externalBasePath = c.req.header('X-Proxy-Base-Path') || '/database/proxy/'
  
  try {
    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers: {
        'Accept': c.req.header('Accept') || '*/*',
        'Accept-Language': c.req.header('Accept-Language') || 'en-US,en;q=0.9',
      },
    })
    
    // Copy response headers
    const headers = new Headers()
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
        headers.set(key, value)
      }
    })
    
    // Check if this is HTML and rewrite it
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('text/html')) {
      const html = await response.text()
      const rewrittenHtml = rewritePrismaStudioHtml(html, externalBasePath)
      headers.set('content-length', String(Buffer.byteLength(rewrittenHtml)))
      return new Response(rewrittenHtml, {
        status: response.status,
        headers,
      })
    }
    
    return new Response(response.body, {
      status: response.status,
      headers,
    })
  } catch (error: any) {
    console.error('[project-runtime] Proxy error:', error)
    return c.json({ error: 'Failed to proxy to Prisma Studio' }, 502)
  }
})

app.all('/database/proxy/*', async (c) => {
  const result = await ensurePrismaStudioRunning()
  if (!result.ok) {
    return c.json({ error: 'Prisma Studio not available' }, 503)
  }
  
  // Get the path after /database/proxy/
  const path = c.req.path.replace('/database/proxy', '') || '/'
  const query = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''
  const targetUrl = `http://localhost:${PRISMA_STUDIO_PORT}${path}${query}`
  
  console.log(`[project-runtime] Proxying database request to ${targetUrl}`)
  
  // Get external proxy base path from header (set by API server)
  const externalBasePath = c.req.header('X-Proxy-Base-Path') || '/database/proxy/'
  
  try {
    const reqHeaders: Record<string, string> = {
      'Accept': c.req.header('Accept') || '*/*',
      'Accept-Language': c.req.header('Accept-Language') || 'en-US,en;q=0.9',
    }
    
    // Forward content-type for POST/PUT
    const contentType = c.req.header('Content-Type')
    if (contentType) {
      reqHeaders['Content-Type'] = contentType
    }
    
    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers: reqHeaders,
      body: ['POST', 'PUT', 'PATCH'].includes(c.req.method) ? await c.req.arrayBuffer() : undefined,
    })
    
    // Copy response headers
    const headers = new Headers()
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
        headers.set(key, value)
      }
    })
    
    // Check if this is HTML and rewrite it
    const respContentType = response.headers.get('content-type') || ''
    if (respContentType.includes('text/html')) {
      const html = await response.text()
      const rewrittenHtml = rewritePrismaStudioHtml(html, externalBasePath)
      headers.set('content-length', String(Buffer.byteLength(rewrittenHtml)))
      return new Response(rewrittenHtml, {
        status: response.status,
        headers,
      })
    }
    
    return new Response(response.body, {
      status: response.status,
      headers,
    })
  } catch (error: any) {
    console.error('[project-runtime] Proxy error:', error)
    return c.json({ error: 'Failed to proxy to Prisma Studio' }, 502)
  }
})

/**
 * Get Prisma Studio status
 */
app.get('/database/status', async (c) => {
  const schemaPath = join(PROJECT_DIR, 'prisma', 'schema.prisma')
  
  if (!existsSync(schemaPath)) {
    return c.json({ status: 'stopped', hasPrisma: false })
  }
  
  if (!prismaStudioProcess) {
    return c.json({ status: 'stopped', hasPrisma: true })
  }
  
  try {
    const response = await fetch(`http://localhost:${PRISMA_STUDIO_PORT}`)
    if (response.ok) {
      return c.json({ status: 'running', hasPrisma: true, url: `http://localhost:${PRISMA_STUDIO_PORT}` })
    }
  } catch {
    // Not reachable
  }
  
  return c.json({ status: 'starting', hasPrisma: true })
})

/**
 * Start Prisma Studio
 */
app.post('/database/start', async (c) => {
  // Same as /database/url - fetch URL will start it if needed
  const urlResponse = await fetch(`http://localhost:${PORT}/database/url`)
  return urlResponse
})

/**
 * Stop Prisma Studio
 */
app.post('/database/stop', (c) => {
  if (prismaStudioProcess) {
    prismaStudioProcess.kill()
    prismaStudioProcess = null
    console.log('[project-runtime] Prisma Studio stopped')
  }
  return c.json({ status: 'stopped' })
})

// =============================================================================
// LSP (Language Server Protocol) WebSocket Endpoint
// =============================================================================

import { lspManager } from './lsp-service'
import type { ServerWebSocket } from 'bun'

// Track active LSP WebSocket connections
const lspConnections = new Set<ServerWebSocket<unknown>>()

/**
 * LSP WebSocket handler for Monaco editor IntelliSense
 * Bridges WebSocket messages to TypeScript language server
 */
app.get('/lsp', (c) => {
  // Return info about LSP endpoint (actual WebSocket upgrade happens in server config)
  return c.json({
    status: 'available',
    message: 'Connect via WebSocket to this endpoint for LSP support',
    projectDir: PROJECT_DIR,
  })
})

// =============================================================================
// Graceful Shutdown
// =============================================================================

async function gracefulShutdown(signal: string) {
  console.log(`[project-runtime] Received ${signal}, starting graceful shutdown...`)

  // Stop LSP servers
  console.log(`[project-runtime] Stopping LSP servers...`)
  lspManager.stopAll()

  // Close LSP WebSocket connections
  for (const ws of lspConnections) {
    ws.close(1001, 'Server shutting down')
  }
  lspConnections.clear()

  // Run final postgres backup before shutdown (critical for data persistence)
  if (postgresBackup) {
    console.log(`[project-runtime] Running final PostgreSQL backup to S3...`)
    try {
      await postgresBackup.shutdown()
      console.log(`[project-runtime] PostgreSQL backup completed`)
    } catch (error) {
      console.error(`[project-runtime] PostgreSQL final backup failed:`, error)
    }
  }

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

logTiming(`Starting HTTP server on port ${PORT}...`)

// WebSocket handlers for LSP
const websocketHandlers = {
  async open(ws: ServerWebSocket<unknown>) {
    console.log('[LSP WebSocket] Client connected')
    lspConnections.add(ws)

    try {
      // Get or create language server for this project
      const lspServer = await lspManager.getServer(PROJECT_DIR)
      
      // Forward messages from tsserver to WebSocket
      const unsubscribe = lspServer.onMessage((msg) => {
        // readyState 1 = OPEN
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(msg))
        }
      })

      // Store unsubscribe function on ws for cleanup
      ;(ws as any).__lspUnsubscribe = unsubscribe
      ;(ws as any).__lspServer = lspServer
      
      console.log('[LSP WebSocket] Language server ready')
    } catch (error) {
      console.error('[LSP WebSocket] Failed to start language server:', error)
      ws.close(1011, 'Failed to start language server')
    }
  },
  
  message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
    try {
      const msg = JSON.parse(typeof message === 'string' ? message : message.toString())
      const lspServer = (ws as any).__lspServer
      
      if (lspServer) {
        // Forward message to tsserver
        lspServer.send(msg)
      }
    } catch (error) {
      console.error('[LSP WebSocket] Error handling message:', error)
    }
  },
  
  close(ws: ServerWebSocket<unknown>, code: number, reason: string) {
    console.log('[LSP WebSocket] Client disconnected:', code, reason)
    lspConnections.delete(ws)
    
    // Clean up
    const unsubscribe = (ws as any).__lspUnsubscribe
    if (unsubscribe) {
      unsubscribe()
    }
  },
}

// Create a wrapper fetch function that handles WebSocket upgrades
function fetchHandler(request: Request, server: { upgrade: (req: Request, options?: { data?: unknown }) => boolean }) {
  const url = new URL(request.url)
  
  // Handle WebSocket upgrade for /lsp endpoint
  if (url.pathname === '/lsp' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const success = server.upgrade(request)
    if (success) {
      // Return undefined to signal Bun that the upgrade was handled
      return undefined
    }
    return new Response('WebSocket upgrade failed', { status: 500 })
  }
  
  // Forward all other requests to Hono
  return app.fetch(request)
}

logTiming('Server configuration complete, starting to accept connections')

// Export default server configuration
export default {
  port: PORT,
  fetch: fetchHandler,
  idleTimeout: 120,
  websocket: websocketHandlers,
}
