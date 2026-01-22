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
import { resolve, isAbsolute, relative, dirname, join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync, cpSync, mkdirSync, rmSync } from 'fs'
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
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || '/app/packages/mcp/src/server-templates.ts'
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

After using template.copy, the Vite server restarts automatically and the preview will update to show the new app. No manual restart is needed.

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
// Preview Restart Endpoint
// =============================================================================

const DIST_DIR = join(PROJECT_DIR, 'dist')
const NITRO_SERVER_PORT = parseInt(process.env.NITRO_SERVER_PORT || '3000', 10)

// Track current preview mode and Nitro server process
let isTanStackStart = process.env.IS_TANSTACK_START === 'true'
let nitroProcess: ReturnType<typeof Bun.spawn> | null = null

/**
 * Restart the preview server after template changes.
 * This will:
 * 1. Kill any existing Nitro server process
 * 2. Install dependencies
 * 3. Run prisma generate/push if needed
 * 4. Build with Vite (Nitro produces .output/server/index.mjs)
 * 5. Start the Nitro server (for TanStack Start) or serve static files (plain Vite)
 */
app.post('/preview/restart', async (c) => {
  console.log(`[project-runtime] Restarting preview for project ${PROJECT_ID}...`)
  
  try {
    // 1. Kill existing Nitro server if running
    if (nitroProcess) {
      console.log('[project-runtime] Stopping existing Nitro server...')
      nitroProcess.kill()
      nitroProcess = null
    }
    
    // 2. Check if this is a TanStack Start project
    const packageJsonPath = join(PROJECT_DIR, 'package.json')
    if (!existsSync(packageJsonPath)) {
      return c.json({ success: false, error: 'No package.json found' }, 400)
    }
    
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies }
    isTanStackStart = !!deps['@tanstack/react-start']
    const hasPrisma = !!deps['@prisma/client'] || !!deps['prisma']
    
    console.log(`[project-runtime] Project type: ${isTanStackStart ? 'TanStack Start (Nitro)' : 'Plain Vite'}`)
    
    // 3. Install dependencies
    console.log('[project-runtime] Installing dependencies...')
    const installProc = Bun.spawn(['bun', 'install'], {
      cwd: PROJECT_DIR,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    await installProc.exited
    
    if (installProc.exitCode !== 0) {
      console.error('[project-runtime] Install failed')
      return c.json({ success: false, error: 'Dependency installation failed' }, 500)
    }
    
    // 4. Run prisma generate and db push if prisma is present
    if (hasPrisma) {
      console.log('[project-runtime] Running prisma generate...')
      const prismaGenProc = Bun.spawn(['bunx', 'prisma', 'generate'], {
        cwd: PROJECT_DIR,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await prismaGenProc.exited
      
      console.log('[project-runtime] Running prisma db push...')
      const prismaPushProc = Bun.spawn(['bunx', 'prisma', 'db', 'push'], {
        cwd: PROJECT_DIR,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await prismaPushProc.exited
    }
    
    // 5. Build the project
    console.log('[project-runtime] Building project...')
    const buildProc = Bun.spawn(['bun', '--bun', 'vite', 'build'], {
      cwd: PROJECT_DIR,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    await buildProc.exited
    
    if (buildProc.exitCode !== 0) {
      console.error('[project-runtime] Build failed')
      return c.json({ success: false, error: 'Build failed' }, 500)
    }
    
    // 6. Start Nitro server for TanStack Start
    if (isTanStackStart) {
      const serverPath = join(PROJECT_DIR, '.output', 'server', 'index.mjs')
      if (!existsSync(serverPath)) {
        return c.json({ success: false, error: 'Nitro build output not found at .output/server/index.mjs' }, 500)
      }
      
      console.log(`[project-runtime] Starting Nitro server on port ${NITRO_SERVER_PORT}...`)
      nitroProcess = Bun.spawn(['bun', 'run', serverPath], {
        cwd: PROJECT_DIR,
        env: { ...process.env, PORT: String(NITRO_SERVER_PORT) },
        stdout: 'inherit',
        stderr: 'inherit',
      })
      
      // Wait for server to start
      await new Promise(resolve => setTimeout(resolve, 3000))
      
      // Check if running
      try {
        const healthCheck = await fetch(`http://localhost:${NITRO_SERVER_PORT}/`)
        console.log(`[project-runtime] Nitro server health check: ${healthCheck.status}`)
      } catch (e) {
        console.warn('[project-runtime] Nitro server may still be starting...')
      }
    }
    
    console.log('[project-runtime] Preview restart completed')
    return c.json({
      success: true,
      mode: isTanStackStart ? 'nitro' : 'static',
      port: isTanStackStart ? NITRO_SERVER_PORT : null,
    })
  } catch (error: any) {
    console.error('[project-runtime] Preview restart error:', error)
    return c.json({ success: false, error: error.message }, 500)
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
              'Cache-Control': 'no-cache',
              'Access-Control-Allow-Origin': '*',
            },
          })
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
        const content = readFileSync(indexPath)
        return new Response(content, {
          status: 200,
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
      return c.text('Not Found', 404)
    }
    
    // Read and serve the file
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
