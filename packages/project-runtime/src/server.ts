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
import { streamText, tool, type ModelMessage } from 'ai'
import { createClaudeCode } from 'ai-sdk-provider-claude-code'
import { z } from 'zod'
import { resolve, isAbsolute, relative, dirname, join, basename } from 'path'
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, cpSync, mkdirSync, rmSync } from 'fs'
import { initializeS3Sync, type S3Sync } from './s3-sync'
import { initializePostgresBackup, type PostgresBackup } from './postgres-backup'
import { verifyPreviewToken, type PreviewTokenPayload } from './preview-token'
import { buildSystemPrompt } from './system-prompt'
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
    const result = await initializeS3Sync(PROJECT_DIR)
    if (result) {
      const { sync, downloadSucceeded } = result
      const s3Duration = Date.now() - s3StartTime
      
      if (downloadSucceeded) {
        // Download succeeded - safe to enable sync and set the global
        s3Sync = sync
        logTiming(`S3 sync initialized successfully (took ${s3Duration}ms)`)
        // Write marker file to signal background init that S3 restore is complete
        // This allows background init to skip bun install if node_modules was restored
        writeFileSync(S3_RESTORE_MARKER, `restored:${Date.now()}`)
        logTiming('S3 restore marker written')
      } else {
        // Download failed but not a critical auth error.
        // CRITICAL: Do NOT set s3Sync - this prevents ANY uploads of template files.
        // The entrypoint template files are on disk, and uploading them would
        // overwrite the user's actual project data in S3.
        console.warn(`[project-runtime] S3 download failed (took ${s3Duration}ms) - sync DISABLED to protect user data`)
        console.warn(`[project-runtime] Will retry download in 10 seconds...`)
        writeFileSync(S3_RESTORE_MARKER, `download-failed:${Date.now()}`)
        
        // Retry download after a delay
        const retryDownload = async (attempt: number) => {
          try {
            console.log(`[project-runtime] Retrying S3 download (attempt ${attempt})...`)
            const retryStats = await sync.downloadAll()
            if (retryStats.errors.length === 0) {
              console.log(`[project-runtime] S3 download retry succeeded! Enabling sync.`)
              // Now safe to enable sync - set the global and start watcher/periodic
              s3Sync = sync
              sync.startPeriodicSync()
              sync.startWatcher()
              writeFileSync(S3_RESTORE_MARKER, `restored-retry:${Date.now()}`)
            } else {
              console.error(`[project-runtime] S3 download retry ${attempt} failed:`, retryStats.errors)
              // Retry with exponential backoff up to 3 attempts
              if (attempt < 3) {
                const delay = 10000 * Math.pow(2, attempt - 1) // 10s, 20s, 40s
                console.log(`[project-runtime] Will retry again in ${delay / 1000}s...`)
                setTimeout(() => retryDownload(attempt + 1), delay)
              } else {
                console.error(`[project-runtime] All S3 download retries failed. Sync remains disabled.`)
              }
            }
          } catch (retryError) {
            console.error(`[project-runtime] S3 download retry ${attempt} error:`, retryError)
            if (attempt < 3) {
              const delay = 10000 * Math.pow(2, attempt - 1)
              setTimeout(() => retryDownload(attempt + 1), delay)
            }
          }
        }
        setTimeout(() => retryDownload(1), 10000)
      }
    } else {
      logTiming('S3 sync not configured (S3_WORKSPACES_BUCKET not set)')
      // Still write marker so background init doesn't wait forever
      writeFileSync(S3_RESTORE_MARKER, `skipped:${Date.now()}`)
    }
  } catch (error) {
    console.error(`[project-runtime] S3 sync initialization failed:`, error)
    // Write marker even on error so background init doesn't hang
    // But do NOT start uploading - protect user data
    writeFileSync(S3_RESTORE_MARKER, `error:${Date.now()}`)
  }
})()

// PostgreSQL S3 backup initialization
// NOTE: With CloudNativePG shared cluster, postgres backup is handled by the operator
// via Barman WAL archiving. The S3 backup module is only used for legacy sidecar mode.
if (process.env.POSTGRES_S3_BACKUP_ENABLED !== 'false') {
  ;(async () => {
    // Wait a bit for postgres to be reachable
    await new Promise(resolve => setTimeout(resolve, 5000))
    
    try {
      postgresBackup = await initializePostgresBackup()
      if (postgresBackup) {
        logTiming('PostgreSQL S3 backup initialized (legacy sidecar mode)')
      } else {
        logTiming('PostgreSQL S3 backup not configured')
      }
    } catch (error) {
      console.error(`[project-runtime] PostgreSQL backup initialization failed:`, error)
    }
  })()
} else {
  logTiming('PostgreSQL S3 backup disabled (using CloudNativePG managed backups)')
}

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
  { name: 'todo-app', description: 'Simple task management with lists', path: 'todo-app', complexity: 'beginner', tags: ['productivity', 'tasks'], features: ['CRUD', 'lists'], useCases: ['personal task tracking'], models: ['Todo', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'PostgreSQL' } },
  { name: 'expense-tracker', description: 'Personal finance with categories', path: 'expense-tracker', complexity: 'beginner', tags: ['finance', 'budgeting'], features: ['categories', 'charts'], useCases: ['expense tracking'], models: ['Expense', 'Category', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'PostgreSQL' } },
  { name: 'crm', description: 'Customer relationship management', path: 'crm', complexity: 'intermediate', tags: ['business', 'sales'], features: ['contacts', 'deals', 'pipeline'], useCases: ['sales management'], models: ['Contact', 'Deal', 'Company', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'PostgreSQL' } },
  { name: 'inventory', description: 'Stock and product management', path: 'inventory', complexity: 'intermediate', tags: ['business', 'warehouse'], features: ['products', 'stock', 'suppliers'], useCases: ['inventory management'], models: ['Product', 'Supplier', 'StockMovement', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'PostgreSQL' } },
  { name: 'kanban', description: 'Project boards with drag-and-drop', path: 'kanban', complexity: 'intermediate', tags: ['productivity', 'project-management'], features: ['boards', 'columns', 'cards', 'drag-drop'], useCases: ['project management'], models: ['Board', 'Column', 'Card', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'PostgreSQL' } },
  { name: 'ai-chat', description: 'AI chatbot with conversation history', path: 'ai-chat', complexity: 'intermediate', tags: ['ai', 'chatbot'], features: ['chat', 'ai-responses', 'history'], useCases: ['ai assistant'], models: ['Conversation', 'Message', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'PostgreSQL', ai: 'Anthropic Claude' } },
  { name: 'form-builder', description: 'Build custom forms and collect responses', path: 'form-builder', complexity: 'intermediate', tags: ['forms', 'surveys'], features: ['form-builder', 'responses'], useCases: ['surveys', 'data collection'], models: ['Form', 'Field', 'Response', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'PostgreSQL' } },
  { name: 'feedback-form', description: 'Collect user feedback', path: 'feedback-form', complexity: 'beginner', tags: ['feedback', 'forms'], features: ['feedback', 'ratings'], useCases: ['user feedback'], models: ['Feedback', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'PostgreSQL' } },
  { name: 'booking-app', description: 'Schedule appointments', path: 'booking-app', complexity: 'intermediate', tags: ['scheduling', 'appointments'], features: ['calendar', 'bookings', 'availability'], useCases: ['appointment scheduling'], models: ['Booking', 'TimeSlot', 'Service', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'PostgreSQL' } },
  { name: 'expo-app', description: 'Mobile app with Expo and React Native', path: 'expo-app', complexity: 'beginner', tags: ['mobile', 'expo', 'react-native'], features: ['CRUD', 'mobile', 'expo-router'], useCases: ['mobile todo app', 'cross-platform app'], models: ['Todo', 'User'], techStack: { frontend: 'React Native', backend: 'Hono', database: 'PostgreSQL', bundler: 'Metro' } },
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
      
      // If successful, trigger S3 sync immediately to persist the template files
      if (result.ok && s3Sync) {
        console.log(`[project-runtime] Triggering S3 sync after template copy`)
        s3Sync.triggerSync(true) // immediate=true since template copy is a critical operation
      }
      
      // If successful, automatically rebuild and restart the preview
      if (result.ok) {
        let restartResult: { success: boolean; message: string; mode?: string; port?: number | null } = {
          success: false,
          message: 'Restart not attempted',
        }
        
        try {
          console.log(`[project-runtime] Starting dev mode for project ${PROJECT_ID}...`)
          // Call our local dev endpoint (uses vite dev server with HMR for instant updates)
          const response = await fetch(`http://localhost:${PORT}/preview/dev`, {
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
// Path Restriction & Runtime Command Guardrails (Security)
// =============================================================================

/**
 * Forbidden runtime commands that the agent must NEVER execute.
 * These would break the managed vite build --watch process, the Hono API server,
 * or other managed infrastructure inside the project runtime container.
 * 
 * This is a HARD BLOCK — the command is physically prevented from running,
 * regardless of what the LLM decides.
 */
const FORBIDDEN_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Vite commands (already running in watch mode)
  { pattern: /\bvite\s+dev\b/, reason: 'The dev server is already running. Vite build --watch handles rebuilds automatically.' },
  { pattern: /\bvite\s+build\b/, reason: 'Vite build --watch is already running and rebuilds automatically on file changes.' },
  { pattern: /\bvite\s+serve\b/, reason: 'The server is already running and serving the built files.' },
  { pattern: /\bvite\s+preview\b/, reason: 'The server is already running and serving the built files.' },
  { pattern: /\bnpx\s+vite\b/, reason: 'Vite is already running in watch mode. Do not start another instance.' },
  { pattern: /\bbunx\s+vite\b/, reason: 'Vite is already running in watch mode. Do not start another instance.' },
  // Dev/build scripts (handled by watch mode)
  { pattern: /\bbun\s+run\s+dev\b/, reason: 'The dev server is already running. No need to start it manually.' },
  { pattern: /\bbun\s+run\s+build\b/, reason: 'Vite build --watch handles builds automatically. No manual build needed.' },
  { pattern: /\bnpm\s+run\s+dev\b/, reason: 'The dev server is already running. No need to start it manually.' },
  { pattern: /\bnpm\s+run\s+build\b/, reason: 'Vite build --watch handles builds automatically. No manual build needed.' },
  { pattern: /\byarn\s+dev\b/, reason: 'The dev server is already running. No need to start it manually.' },
  { pattern: /\byarn\s+build\b/, reason: 'Vite build --watch handles builds automatically. No manual build needed.' },
  // Process killing (would kill managed infrastructure)
  { pattern: /\bkill\s+-/, reason: 'Do not kill processes. The runtime manages all server processes automatically.' },
  { pattern: /\bkill\s+\d/, reason: 'Do not kill processes. The runtime manages all server processes automatically.' },
  { pattern: /\bpkill\b/, reason: 'Do not kill processes. The runtime manages all server processes automatically.' },
  { pattern: /\bkillall\b/, reason: 'Do not kill processes. The runtime manages all server processes automatically.' },
  // Server restart commands
  { pattern: /\bpm2\s+restart\b/, reason: 'Do not restart processes. The runtime manages the server automatically.' },
  { pattern: /\bsystemctl\s+restart\b/, reason: 'Do not restart system services. The runtime manages everything.' },
]

/**
 * Check if a bash command matches any forbidden runtime command pattern.
 * Returns the reason string if forbidden, or null if allowed.
 */
function checkForbiddenCommand(command: string): string | null {
  const cmd = command.toLowerCase()
  for (const { pattern, reason } of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(cmd)) {
      return reason
    }
  }
  return null
}

/**
 * Creates a canUseTool callback that:
 * 1. Blocks forbidden runtime commands (vite restart, build, kill, etc.)
 * 2. Restricts file operations to the project directory
 * 
 * This prevents the agent from:
 * - Breaking the managed vite build --watch / Hono server infrastructure
 * - Accessing files outside the project directory
 */
function createPathRestrictor(projectDir: string) {
  return async (toolName: string, input: unknown) => {
    // DEBUG: Log EVERY canUseTool invocation so we can verify it's being called
    console.error(`[project-runtime] canUseTool called: tool=${toolName}, input=${JSON.stringify(input).slice(0, 300)}`)

    // GUARDRAIL: Block forbidden runtime commands for Bash/Shell tools
    if (toolName === 'Bash' || toolName === 'bash' || toolName === 'Shell' || toolName === 'shell') {
      const inputObj = input as Record<string, unknown>
      const command = String(inputObj.command || '')
      console.error(`[project-runtime] Bash command intercepted: "${command}"`)
      const reason = checkForbiddenCommand(command)
      if (reason) {
        console.error(`[project-runtime] ❌ BLOCKED forbidden command: "${command}" — reason: ${reason}`)
        return {
          behavior: 'deny' as const,
          message: `Command blocked: ${reason} The runtime container manages vite build --watch and the API server automatically. If something isn't working, check .build.log for errors.`,
        }
      }
      console.error(`[project-runtime] ✅ Bash command allowed: "${command}"`)
    }

    // Only restrict file operation tools for path checks
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
console.log(`[project-runtime] ✅ Forbidden command guardrail ACTIVE (${FORBIDDEN_COMMAND_PATTERNS.length} patterns)`)

// AI Proxy Configuration
// When AI_PROXY_URL and AI_PROXY_TOKEN are set, route Claude Code CLI through
// the proxy instead of directly to Anthropic. This prevents exposing the raw
// ANTHROPIC_API_KEY to the project pod.
//
// How it works:
// - ANTHROPIC_BASE_URL is set to the proxy's Anthropic-native endpoint
// - ANTHROPIC_API_KEY is set to the proxy token (proxy validates it)
// - The proxy forwards requests to the real Anthropic API with server-side keys
const AI_PROXY_URL = process.env.AI_PROXY_URL
const AI_PROXY_TOKEN = process.env.AI_PROXY_TOKEN
const useAIProxy = !!(AI_PROXY_URL && AI_PROXY_TOKEN)

if (useAIProxy) {
  // Derive the Anthropic-native proxy base URL from AI_PROXY_URL
  // AI_PROXY_URL is like: http://api-server/api/ai/v1
  // Anthropic base URL should be: http://api-server/api/ai/anthropic
  const anthropicProxyBase = AI_PROXY_URL.replace(/\/v1$/, '/anthropic')
  console.log(`[project-runtime] AI Proxy enabled: Claude Code → ${anthropicProxyBase}`)
  console.log(`[project-runtime] Proxy token: ${AI_PROXY_TOKEN.slice(0, 20)}...`)
} else {
  console.log(`[project-runtime] AI Proxy not configured, using direct ANTHROPIC_API_KEY`)
}

// Build environment overrides for Claude Code process
// When proxy is enabled, override ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY
// IMPORTANT: Spread process.env first so DATABASE_URL and other runtime vars are inherited
const claudeCodeEnv: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  ),
}
if (useAIProxy) {
  const anthropicProxyBase = AI_PROXY_URL!.replace(/\/v1$/, '/anthropic')
  claudeCodeEnv.ANTHROPIC_BASE_URL = anthropicProxyBase
  claudeCodeEnv.ANTHROPIC_API_KEY = AI_PROXY_TOKEN!
}

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
    // Environment for Claude Code process
    // Inherits all runtime env vars (DATABASE_URL, etc.) plus AI proxy overrides
    env: claudeCodeEnv,
    // MCP server configuration
    mcpServers: {
      wavesmith: {
        command: 'bun',
        args: ['run', MCP_SERVER_PATH],
        env: {
          SCHEMAS_PATH,
          PROJECT_ID: PROJECT_ID!,
          PROJECT_DIR,  // Critical: template.copy needs this to copy to the right location
          RUNTIME_PORT: String(PORT),  // Port for calling /preview/restart from template.copy
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
    // NOTE: 'Bash' is intentionally NOT in allowedTools so that every Bash
    // command triggers a permission check via the canUseTool callback.
    // This is how the forbidden-command guardrail works — the CLI sends a
    // "can_use_tool" request for Bash, and our callback blocks forbidden commands.
    allowedTools: [
      // File operations
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS',
      // Skill and agent tools (Bash excluded — uses canUseTool guardrail)
      'Skill', 'Task', 'TodoWrite',
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
// Model Instance Cache — "keep the CLI warm"
// =============================================================================
// Cache ClaudeCodeLanguageModel instances by model name so the internal sessionId
// persists across HTTP requests.  After the first streamText() call the SDK stores
// the sessionId; subsequent calls automatically pass `resume: <sessionId>` to the
// Claude Code CLI subprocess.  This means the CLI loads the existing session from
// disk (~/.claude/projects/) instead of cold-starting a brand-new conversation,
// saving 1-2 s of MCP/skill initialisation per message.
//
// Only 3 possible keys (haiku | sonnet | opus) so memory is bounded.
const cachedModels = new Map<string, ReturnType<typeof claudeCode>>()

function getOrCreateModel(modelName: 'haiku' | 'sonnet' | 'opus') {
  let model = cachedModels.get(modelName)
  if (!model) {
    model = claudeCode(modelName, {
      streamingInput: 'always',
    })
    cachedModels.set(modelName, model)
    console.log(`[project-runtime] Cached model instance for: ${modelName} (session will auto-resume on next call)`)
  }
  return model
}

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
  let streamClosed = false
  
  const reader = stream.getReader()
  
  function cleanupInterval() {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval)
      keepAliveInterval = null
    }
  }
  
  return new ReadableStream({
    start(ctrl) {
      controller = ctrl
      
      // Start keep-alive interval
      keepAliveInterval = setInterval(() => {
        if (streamClosed || !controller) {
          cleanupInterval()
          return
        }
        try {
          controller.enqueue(keepAliveMessage)
          console.log('[project-runtime] Sent keep-alive')
        } catch {
          // Stream closed, stop sending
          streamClosed = true
          cleanupInterval()
        }
      }, intervalMs)
    },
    
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read()
        
        if (done) {
          // Mark as closed BEFORE closing to prevent keep-alive race
          streamClosed = true
          cleanupInterval()
          ctrl.close()
          return
        }
        
        ctrl.enqueue(value)
      } catch (error) {
        // Clean up on error
        streamClosed = true
        cleanupInterval()
        ctrl.error(error)
      }
    },
    
    cancel() {
      // Clean up on cancel
      streamClosed = true
      cleanupInterval()
      controller = null
      reader.cancel()
    },
  })
}

// =============================================================================
// Image Handling Helpers
// =============================================================================

/**
 * Parse a data URL to extract mediaType and base64 data.
 * Example: "data:image/png;base64,iVBORw0..." -> { mimeType: "image/png", base64Data: "iVBORw0..." }
 */
function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], base64Data: match[2] }
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
  // Theme context for AI-aware styling (Phase 3: AI Agent Integration)
  themeContext: z.string().optional(),
  // Agent mode for model selection: basic (Haiku) or advanced (Sonnet)
  agentMode: z.enum(['basic', 'advanced']).optional(),
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

function getBuildStatus(): { status: string; ready: boolean; details?: string } {
  if (!FAST_START_MODE) {
    return { status: 'ready', ready: true }
  }
  
  try {
    if (existsSync(BUILD_STATUS_FILE)) {
      const status = readFileSync(BUILD_STATUS_FILE, 'utf-8').trim()
      
      // If build status file says "ready", also verify actual build artifacts exist
      if (status === 'ready') {
        const distDir = join(PROJECT_DIR, 'dist')
        if (!existsSync(distDir)) {
          console.log('[project-runtime] Build status says ready but dist/ missing')
          return { status: 'dist_missing', ready: false, details: 'Build artifacts missing - dist/ not found' }
        }
        
        if (!existsSync(join(distDir, 'index.html'))) {
          // Race condition: entrypoint.sh may have written "ready" before build fully completed.
          // Wait briefly for the file to appear before declaring incomplete.
          const waitStart = Date.now()
          const MAX_WAIT_MS = 3000
          const POLL_INTERVAL_MS = 100
          while (Date.now() - waitStart < MAX_WAIT_MS) {
            Bun.sleepSync(POLL_INTERVAL_MS)
            if (existsSync(join(distDir, 'index.html'))) {
              // File appeared, we're good
              return { status: 'ready', ready: true }
            }
          }
          console.log(`[project-runtime] Build status says ready but dist/index.html missing after ${MAX_WAIT_MS}ms wait`)
          return { status: 'dist_incomplete', ready: false, details: 'Build incomplete - dist/index.html not found' }
        }
      }
      
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
    
    // Auto-start vite watch mode for automatic rebuilds (don't block response)
    // Expo uses Metro bundler, so watch mode doesn't apply
    const isExpo = existsSync(join(PROJECT_DIR, 'app.json')) || existsSync(join(PROJECT_DIR, 'expo.json'))
    
    if (!isExpo && !buildWatchProcess) {
      console.log('[project-runtime] 🔄 Auto-starting Vite watch mode...')
      startViteBuildWatch().catch((err) => {
        console.error('[project-runtime] Failed to auto-start vite watch:', err)
      })
    }
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
  const isInBackoff = devModeFailureCount >= DEV_MODE_MAX_FAILURES && 
    devModeLastFailure && (Date.now() - devModeLastFailure < DEV_MODE_BACKOFF_MS)
  
  return c.json({
    projectId: PROJECT_ID,
    fastStartMode: FAST_START_MODE,
    ...buildStatus,
    uptime: process.uptime(),
    devMode: {
      active: isDevMode,
      starting: devModeStarting,
      failureCount: devModeFailureCount,
      error: devModeError,
      inBackoff: isInBackoff,
    },
    // Build watch state
    buildWatch: {
      active: buildWatchProcess !== null,
      state: buildState,
      building: buildState === 'building',
      startTime: buildStartTime,
      duration: buildDuration,
      lastBuildTime: lastBuildTime,
      error: buildError,
    },
    // Provide a user-friendly message
    message: devModeError && isInBackoff 
      ? `Error: ${devModeError}` 
      : devModeStarting 
        ? 'Starting dev server...' 
        : buildState === 'building'
          ? 'Rebuilding project...'
          : buildStatus.ready 
            ? 'Ready' 
            : 'Initializing...',
  })
})

/**
 * Server-Sent Events endpoint for real-time build state updates.
 * Clients can subscribe to receive instant notifications when builds start/complete.
 */
app.get('/build-events', (c) => {
  // Set SSE headers
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')
  
  let clientController: ReadableStreamDefaultController | null = null
  let isClosed = false
  
  const stream = new ReadableStream({
    start(controller) {
      // Store controller for cancel callback
      clientController = controller
      
      // Add client to subscribers
      buildEventClients.add(controller)
      
      // Send initial state immediately
      const initialState = JSON.stringify({
        state: buildState,
        startTime: buildStartTime,
        duration: buildDuration,
        lastBuildTime: lastBuildTime,
        error: buildError,
        timestamp: Date.now(),
      })
      const encoder = new TextEncoder()
      try {
        controller.enqueue(encoder.encode(`data: ${initialState}\n\n`))
      } catch {
        // Controller may already be closed
        isClosed = true
        buildEventClients.delete(controller)
      }
      
      console.log(`[project-runtime] Build events client connected (total: ${buildEventClients.size})`)
    },
    cancel() {
      isClosed = true
      if (clientController) {
        buildEventClients.delete(clientController)
        clientController = null
        console.log(`[project-runtime] Build events client disconnected (remaining: ${buildEventClients.size})`)
      }
    },
  })
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
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
    
    const { messages, system, themeContext, agentMode } = parsed.data
    
    // Build system prompt with optional theme context and current build status
    // The prompt is defined in system-prompt.ts and can be updated via DSPy export
    const getSystemPrompt = () => {
      // Get current build status context for the agent
      const buildContext = getBuildStatusContext()
      
      if (system) {
        // Custom system prompt provided - append build status and optional theme context
        let prompt = system
        if (buildContext) prompt = `${prompt}\n\n${buildContext}`
        if (themeContext) prompt = `${prompt}\n\n${themeContext}`
        return prompt
      }
      // Use the default system prompt from system-prompt.ts with build status
      return buildSystemPrompt(PROJECT_DIR, themeContext, buildContext)
    }
    
    // Convert to ModelMessage format, handling both string and parts content
    // Preserves image parts for multimodal AI processing
    type ContentPart = { type: 'text'; text: string } | { type: 'image'; image: string; mimeType: string }

    const coreMessages: ModelMessage[] = messages.map((msg) => {
      // If message already has content string, pass through
      if (typeof msg.content === 'string') {
        return { role: msg.role, content: msg.content }
      }

      // If message has parts array (AI SDK v4 UIMessage format), process all part types including images
      if (Array.isArray(msg.parts)) {
        const contentParts: ContentPart[] = []

        for (const part of msg.parts) {
          if (part.type === 'text' && part.text) {
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
        }

        // Return appropriate format based on content
        if (contentParts.length === 1 && contentParts[0].type === 'text') {
          return { role: msg.role, content: contentParts[0].text }
        }
        if (contentParts.length > 0) {
          return { role: msg.role, content: contentParts }
        }
        return { role: msg.role, content: '' }
      }

      // Also handle content array format (alternative message format)
      if (Array.isArray(msg.content)) {
        const contentParts: ContentPart[] = []

        for (const part of msg.content) {
          if (part.type === 'text' && part.text) {
            contentParts.push({ type: 'text', text: part.text })
          } else if (part.type === 'file' && part.mediaType?.startsWith('image/')) {
            const parsed = parseDataUrl(part.url || '')
            if (parsed) {
              contentParts.push({
                type: 'image',
                image: parsed.base64Data,
                mimeType: parsed.mimeType,
              })
            }
          } else if (part.type === 'image' && part.image) {
            // Already in image format, pass through
            contentParts.push({ type: 'image', image: part.image, mimeType: part.mimeType || 'image/png' })
          }
        }

        if (contentParts.length === 1 && contentParts[0].type === 'text') {
          return { role: msg.role, content: contentParts[0].text }
        }
        if (contentParts.length > 0) {
          return { role: msg.role, content: contentParts }
        }
      }

      return { role: msg.role, content: msg.content ?? '' }
    })
    
    // Debug: Log message structure to verify image handling
    const messageStats = coreMessages.map(m => ({
      role: m.role,
      contentType: typeof m.content === 'string' ? 'string' : Array.isArray(m.content) ? `array(${m.content.length})` : typeof m.content,
      hasImages: Array.isArray(m.content) ? m.content.some((p: any) => p.type === 'image') : false,
    }))
    console.log(`[project-runtime] Processing ${messages.length} messages:`, JSON.stringify(messageStats))
    
    // Retry configuration for transient API errors
    const MAX_RETRIES = 3
    const RETRY_DELAY_MS = 2000
    const RETRYABLE_ERRORS = [
      'rate_limit',
      'overloaded',
      'api_error',
      'invalid_api_key', // Sometimes transient
      'connection',
      'timeout',
      'ECONNRESET',
      'ETIMEDOUT',
      '529', // Overloaded
      '503', // Service unavailable
      '502', // Bad gateway
    ]
    
    const isRetryableError = (error: any): boolean => {
      const errorStr = String(error?.message || error || '').toLowerCase()
      return RETRYABLE_ERRORS.some(e => errorStr.includes(e.toLowerCase()))
    }
    
    // Create streaming response using Claude Code with native template tools
    // Theme context (if provided) is appended to the system prompt for AI-aware styling
    // Model selection: agentMode takes precedence, then AGENT_MODEL env var, then default to sonnet
    // - basic mode uses Haiku (faster, cheaper)
    // - advanced mode uses Sonnet (more capable)
    const getModelFromAgentMode = (mode?: 'basic' | 'advanced'): 'haiku' | 'sonnet' | 'opus' => {
      if (mode === 'basic') return 'haiku'
      if (mode === 'advanced') return 'sonnet'
      return (process.env.AGENT_MODEL || 'sonnet') as 'haiku' | 'sonnet' | 'opus'
    }
    const modelName = getModelFromAgentMode(agentMode)
    console.log(`[project-runtime] Using model: ${modelName} (agentMode: ${agentMode || 'default'})`)
    
    let lastError: any = null
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = streamText({
          // perf: Use cached model instance to preserve sessionId across requests.
          // After the first call the model auto-resumes the previous session,
          // avoiding a full CLI cold-start on every message.
          model: getOrCreateModel(modelName) as Parameters<typeof streamText>[0]['model'],
          system: getSystemPrompt(),
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
        // Also appends a custom usage SSE event after the stream finishes
        if (response.body) {
          const originalStream = response.body
          const usagePromise = result.usage
          
          // Create a new stream that wraps the original with keep-alive AND appends usage.
          // IMPORTANT: Uses pull()-based streaming instead of consuming everything in start().
          // The pull() pattern ensures demand-driven data flow — chunks are read from the
          // underlying stream only when the consumer (HTTP response / proxy) requests them.
          // This prevents buffering issues where start() would read the entire stream
          // before the consumer sees any data, which caused follow-up AI messages to
          // appear hung (no text streaming to frontend despite backend processing).
          let keepAliveReader: ReadableStreamDefaultReader<Uint8Array> | null = null
          let streamFinished = false
          let usageAppended = false
          
          const wrappedStream = new ReadableStream<Uint8Array>({
            start() {
              // Initialize the keep-alive wrapped reader. We do this in start() so
              // the keep-alive timer begins immediately (it runs on an interval).
              keepAliveReader = wrapStreamWithKeepalive(originalStream, 15000).getReader()
            },
            
            async pull(controller) {
              if (!keepAliveReader) {
                controller.close()
                return
              }
              
              try {
                const { done, value } = await keepAliveReader.read()
                
                if (done) {
                  // Inner stream finished — append usage data before closing
                  streamFinished = true
                  keepAliveReader.releaseLock()
                  keepAliveReader = null
                  
                  if (!usageAppended) {
                    usageAppended = true
                    try {
                      const usage = await usagePromise
                      console.log('[project-runtime] Usage from streamText:', JSON.stringify(usage))
                      if (usage) {
                        const usageEvent = `data: ${JSON.stringify({ type: 'data-usage', data: { inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, totalTokens: usage.totalTokens || 0 } })}\n\n`
                        controller.enqueue(new TextEncoder().encode(usageEvent))
                      }
                    } catch (err) {
                      console.error('[project-runtime] Failed to get usage:', err)
                    }
                  }
                  
                  // Trigger S3 sync after agent chat completes.
                  // The agent may have written/modified project files via tool calls.
                  // The file watcher's debounce will also catch these, but this explicit
                  // trigger ensures we don't miss anything if the watcher is delayed.
                  if (s3Sync) {
                    s3Sync.triggerSync()
                  }
                  
                  controller.close()
                  return
                }
                
                controller.enqueue(value)
              } catch (err) {
                console.error('[project-runtime] Stream read error:', err)
                keepAliveReader?.releaseLock()
                keepAliveReader = null
                controller.error(err)
              }
            },
            
            cancel() {
              // Clean up when the consumer cancels (e.g., client disconnects)
              streamFinished = true
              if (keepAliveReader) {
                keepAliveReader.cancel().catch(() => {})
                keepAliveReader = null
              }
            },
          })
          
          return new Response(wrappedStream, {
            status: response.status,
            headers: response.headers,
          })
        }
        
        return response
      } catch (error: any) {
        lastError = error
        const errorMsg = error?.message || String(error)
        
        if (isRetryableError(error) && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt
          console.warn(`[project-runtime] Chat API error (attempt ${attempt}/${MAX_RETRIES}): ${errorMsg}`)
          console.warn(`[project-runtime] Retrying in ${delay}ms...`)
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
        
        // Non-retryable or max retries exceeded
        throw error
      }
    }
    
    // Should not reach here, but just in case
    throw lastError
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
    aiProxy: {
      url: process.env.AI_PROXY_URL || null,
      configured: !!process.env.AI_PROXY_TOKEN,
    },
  })
})

// =============================================================================
// AI Proxy Configuration Endpoint
// =============================================================================
// Exposes AI proxy credentials to user-created apps running in this project.
// User apps call this endpoint to get the proxy URL and token without needing
// raw API keys in their environment.

app.get('/ai/config', (c) => {
  const proxyUrl = process.env.AI_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  if (!proxyUrl || !proxyToken) {
    return c.json({
      configured: false,
      message: 'AI proxy not configured for this project runtime.',
    })
  }

  return c.json({
    configured: true,
    proxyUrl,
    proxyToken,
    // OpenAI-compatible base URL that AI SDKs can use directly
    baseUrl: proxyUrl,
    // Models available through the proxy
    modelsUrl: `${proxyUrl}/models`,
    completionsUrl: `${proxyUrl}/chat/completions`,
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

// Port configuration: Vite UI on 3000, Backend API on 3001
const VITE_DEV_PORT = parseInt(process.env.VITE_DEV_PORT || '3000', 10)
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '3001', 10)
const EXPO_SERVER_PORT = parseInt(process.env.EXPO_SERVER_PORT || '8081', 10)

// Track current preview mode and server processes
let isExpo = process.env.IS_EXPO === 'true'
let serverProcess: ReturnType<typeof Bun.spawn> | null = null
let expoServerProcess: ReturnType<typeof Bun.spawn> | null = null

// Dev mode: use vite dev server with HMR instead of production builds
let isDevMode = false
let viteDevProcess: ReturnType<typeof Bun.spawn> | null = null
let expoDevProcess: ReturnType<typeof Bun.spawn> | null = null
let devModeStarting = false  // Track if dev mode is currently being started

// Circuit breaker state for dev mode auto-start
let devModeFailureCount = 0
let devModeLastFailure: number | null = null
let devModeError: string | null = null
const DEV_MODE_MAX_FAILURES = 3
const DEV_MODE_BACKOFF_MS = 60000  // 1 minute backoff after max failures

// Build watch state for automatic rebuilds with vite build --watch
let buildWatchProcess: ReturnType<typeof Bun.spawn> | null = null
let buildState: 'idle' | 'building' | 'success' | 'error' = 'idle'
let buildStartTime: number | null = null
let buildDuration: number | null = null
let lastBuildTime: number | null = null
let buildError: string | null = null

// Build time history for calculating averages (last 10 builds)
const BUILD_HISTORY_MAX = 10
let buildTimeHistory: number[] = []

// Watch process crash recovery
let watchCrashCount = 0
let lastWatchCrashTime: number | null = null
const WATCH_CRASH_COOLDOWN_MS = 5000  // Wait 5s between auto-restarts
const MAX_WATCH_CRASHES = 5  // Max crashes before giving up auto-restart

// =============================================================================
// Enhanced Build Error Context (for agent build recovery)
// =============================================================================

interface BuildErrorContext {
  errorMessage: string
  errorCategory: 'missing_files' | 'typescript_error' | 'dependency_missing' | 'syntax_error' | 'schema_sync' | 'build_tool' | 'unknown'
  rootCause: string
  canSelfFix: boolean
  logFilePath: string
  logExcerpt: string  // Last 30 lines of build log
  detectedIssues: Array<{
    type: string
    file?: string
    line?: number
    suggestion: string
  }>
  recoverySteps: string[]
}

let buildErrorContext: BuildErrorContext | null = null

/**
 * Analyze build error and create rich error context for agent recovery
 */
function analyzeBuildError(errorLine: string): BuildErrorContext {
  const logExcerpt = buildLogLines.slice(-30).join('\n')
  const fullLog = buildLogLines.join('\n')
  
  // Detect error category and extract details
  let category: BuildErrorContext['errorCategory'] = 'unknown'
  let rootCause = errorLine
  let canSelfFix = true
  const detectedIssues: BuildErrorContext['detectedIssues'] = []
  const recoverySteps: string[] = []
  
  // Pattern matching for common error types
  const patterns = {
    missingRoutesDir: /ENOENT.*scandir.*['"](.*routes.*)['"]/i,
    missingFile: /ENOENT.*['"](.*)['"]/i,
    noRouteFiles: /No route files found|no route files/i,
    moduleNotFound: /Module not found|Cannot find module|Can't resolve ['"](.*)['"]/i,
    typescriptError: /TS\d+:|error TS\d+|Type '.*' is not assignable/i,
    syntaxError: /SyntaxError|Unexpected token|Parse error/i,
    prismaError: /PrismaClient|prisma.*generate|@prisma\/client/i,
    buildToolError: /bundle.*size|chunk.*size/i,
    invalidExtension: /Invalid.*extension|\.jsx.*not supported/i,
    reactNotDefined: /React is not defined|'React' is not defined/i,
    importError: /Cannot resolve|wrong.*path|import.*error/i,
  }
  
  // Check for missing routes directory
  if (patterns.missingRoutesDir.test(fullLog) || patterns.noRouteFiles.test(fullLog)) {
    category = 'missing_files'
    const match = fullLog.match(/['"](.*routes.*)['"]/i)
    const routesPath = match ? match[1] : 'src/routes'
    rootCause = `Routes directory or files missing: ${routesPath}`
    detectedIssues.push({
      type: 'missing_routes',
      file: routesPath,
      suggestion: 'Create routes directory and add at least one route file (index.tsx)'
    })
    recoverySteps.push(
      'STEP 1: Read the full build log: `cat .build.log`',
      'STEP 2: Check if routes directory exists: `ls -la src/routes/` or `ls -la src/`',
      'STEP 3: If directory missing, create it: `mkdir -p src/routes`',
      'STEP 4: Create index route file with basic route component',
      'STEP 5: Wait for automatic rebuild and verify success'
    )
  }
  // Check for TypeScript errors
  else if (patterns.typescriptError.test(fullLog) || patterns.reactNotDefined.test(fullLog)) {
    category = 'typescript_error'
    const tsMatch = fullLog.match(/TS(\d+):/i)
    const fileMatch = fullLog.match(/([^\s]+\.tsx?):(\d+)/i)
    rootCause = tsMatch ? `TypeScript error TS${tsMatch[1]}` : 'TypeScript compilation error'
    if (fileMatch) {
      detectedIssues.push({
        type: 'typescript_error',
        file: fileMatch[1],
        line: parseInt(fileMatch[2], 10),
        suggestion: 'Fix the TypeScript error in the indicated file and line'
      })
    }
    if (patterns.reactNotDefined.test(fullLog)) {
      detectedIssues.push({
        type: 'missing_import',
        suggestion: "Add `import React from 'react'` at the top of the component file"
      })
    }
    recoverySteps.push(
      'STEP 1: Read the full build log: `cat .build.log`',
      'STEP 2: Identify the exact file and line with the error',
      'STEP 3: Read the problematic file to understand the context',
      'STEP 4: Fix the TypeScript error (missing import, type mismatch, etc.)',
      'STEP 5: Wait for automatic rebuild and verify success'
    )
  }
  // Check for missing modules/imports
  else if (patterns.moduleNotFound.test(fullLog) || patterns.importError.test(fullLog)) {
    category = 'missing_files'
    const moduleMatch = fullLog.match(/[Cc]an't resolve ['"](.*)['"]/i) || fullLog.match(/Module not found.*['"](.*)['"]/i)
    rootCause = moduleMatch ? `Cannot resolve module: ${moduleMatch[1]}` : 'Module resolution error'
    detectedIssues.push({
      type: 'import_error',
      suggestion: 'Check import path - may be wrong relative depth or missing file'
    })
    recoverySteps.push(
      'STEP 1: Read the full build log: `cat .build.log`',
      'STEP 2: Find the file with the bad import',
      'STEP 3: Check if the imported file exists at that path',
      'STEP 4: Fix the import path (check relative depth: ../ vs ../../)',
      'STEP 5: Wait for automatic rebuild and verify success'
    )
  }
  // Check for schema/prisma sync issues
  else if (patterns.prismaError.test(fullLog) || /schema.*sync|generated.*types.*stale/i.test(fullLog)) {
    category = 'schema_sync'
    rootCause = 'Prisma schema out of sync with generated files'
    detectedIssues.push({
      type: 'schema_sync',
      suggestion: 'Run `bunx shogo generate` to regenerate types from schema.prisma'
    })
    recoverySteps.push(
      'STEP 1: Read the full build log: `cat .build.log`',
      'STEP 2: Check if schema was recently modified: `cat prisma/schema.prisma`',
      'STEP 3: Regenerate all SDK files: `bunx shogo generate`',
      'STEP 4: Wait for automatic rebuild and verify success'
    )
  }
  // Check for syntax errors
  else if (patterns.syntaxError.test(fullLog)) {
    category = 'syntax_error'
    const fileMatch = fullLog.match(/([^\s]+\.[jt]sx?):(\d+)/i)
    rootCause = 'JavaScript/TypeScript syntax error'
    if (fileMatch) {
      detectedIssues.push({
        type: 'syntax_error',
        file: fileMatch[1],
        line: parseInt(fileMatch[2], 10),
        suggestion: 'Fix the syntax error at the indicated location'
      })
    }
    recoverySteps.push(
      'STEP 1: Read the full build log: `cat .build.log`',
      'STEP 2: Identify the file and line with the syntax error',
      'STEP 3: Read the file to see the malformed code',
      'STEP 4: Fix the syntax (missing bracket, quote, semicolon, etc.)',
      'STEP 5: Wait for automatic rebuild and verify success'
    )
  }
  // Check for invalid file extensions
  else if (patterns.invalidExtension.test(fullLog)) {
    category = 'missing_files'
    const fileMatch = fullLog.match(/([^\s]+\.jsx)/i)
    rootCause = 'Invalid file extension (.jsx not supported, use .tsx)'
    if (fileMatch) {
      detectedIssues.push({
        type: 'wrong_extension',
        file: fileMatch[1],
        suggestion: 'Rename file from .jsx to .tsx'
      })
    }
    recoverySteps.push(
      'STEP 1: Read the full build log: `cat .build.log`',
      'STEP 2: Find the file with wrong extension',
      'STEP 3: Rename the file: `mv src/routes/index.jsx src/routes/index.tsx`',
      'STEP 4: Wait for automatic rebuild and verify success'
    )
  }
  // Check for build tool errors (Vite)
  else if (patterns.buildToolError.test(fullLog)) {
    category = 'build_tool'
    rootCause = 'Build tool error (Vite)'
    canSelfFix = false  // These often need user intervention
    detectedIssues.push({
      type: 'build_tool_error',
      suggestion: 'May require dependency update or configuration change'
    })
    recoverySteps.push(
      'STEP 1: Read the full build log: `cat .build.log`',
      'STEP 2: Check for specific Vite error messages',
      'STEP 3: This may require manual investigation - explain the issue to the user'
    )
  }
  // Unknown error - still provide recovery steps
  else {
    category = 'unknown'
    rootCause = errorLine || 'Unknown build error'
    recoverySteps.push(
      'STEP 1: Read the FULL build log first: `cat .build.log`',
      'STEP 2: Search for "error" in the log to find the root cause',
      'STEP 3: Identify the file(s) involved',
      'STEP 4: Read the problematic file(s) to understand context',
      'STEP 5: Apply appropriate fix based on error type',
      'STEP 6: Wait for automatic rebuild and verify success'
    )
  }
  
  return {
    errorMessage: errorLine,
    errorCategory: category,
    rootCause,
    canSelfFix,
    logFilePath: BUILD_LOG_PATH,
    logExcerpt,
    detectedIssues,
    recoverySteps
  }
}

function recordBuildTime(durationMs: number) {
  buildTimeHistory.push(durationMs)
  if (buildTimeHistory.length > BUILD_HISTORY_MAX) {
    buildTimeHistory = buildTimeHistory.slice(-BUILD_HISTORY_MAX)
  }
}

function getAverageBuildTime(): number | null {
  if (buildTimeHistory.length === 0) return null
  const sum = buildTimeHistory.reduce((a, b) => a + b, 0)
  return Math.round(sum / buildTimeHistory.length)
}

// Build log - circular buffer of recent build output (last 500 lines)
const BUILD_LOG_MAX_LINES = 500
let buildLogLines: string[] = []
const BUILD_LOG_PATH = join(PROJECT_DIR, '.build.log')

function appendToBuildLog(line: string) {
  const timestamp = new Date().toISOString().slice(11, 19) // HH:MM:SS
  const logLine = `[${timestamp}] ${line}`
  buildLogLines.push(logLine)
  if (buildLogLines.length > BUILD_LOG_MAX_LINES) {
    buildLogLines = buildLogLines.slice(-BUILD_LOG_MAX_LINES)
  }
  // Also write to file for agent access
  try {
    writeFileSync(BUILD_LOG_PATH, buildLogLines.join('\n'))
  } catch (e) {
    // Ignore write errors
  }
}

// Console log - captures stdout/stderr from the running application server
const CONSOLE_LOG_MAX_LINES = 500
let consoleLogLines: string[] = []
const CONSOLE_LOG_PATH = join(PROJECT_DIR, '.console.log')

function appendToConsoleLog(line: string, stream: 'stdout' | 'stderr' = 'stdout') {
  const timestamp = new Date().toISOString().slice(11, 19) // HH:MM:SS
  const prefix = stream === 'stderr' ? '[err]' : '[out]'
  const logLine = `[${timestamp}] ${prefix} ${line}`
  consoleLogLines.push(logLine)
  if (consoleLogLines.length > CONSOLE_LOG_MAX_LINES) {
    consoleLogLines = consoleLogLines.slice(-CONSOLE_LOG_MAX_LINES)
  }
  // Also write to file for agent access
  try {
    writeFileSync(CONSOLE_LOG_PATH, consoleLogLines.join('\n'))
  } catch (e) {
    // Ignore write errors
  }
}

/**
 * Stream process output to console log file.
 * Captures stdout and stderr from spawned server processes.
 */
function streamProcessOutput(proc: ReturnType<typeof Bun.spawn>, name: string) {
  // Stream stdout
  if (proc.stdout && typeof proc.stdout !== 'number') {
    ;(async () => {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const output = decoder.decode(value)
          for (const line of output.split('\n')) {
            if (line.trim()) {
              console.log(`[${name}] ${line}`)
              appendToConsoleLog(line, 'stdout')
            }
          }
        }
      } catch (e) {
        // Process ended
      }
    })()
  }
  
  // Stream stderr
  if (proc.stderr && typeof proc.stderr !== 'number') {
    ;(async () => {
      const reader = proc.stderr.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const output = decoder.decode(value)
          for (const line of output.split('\n')) {
            if (line.trim()) {
              console.error(`[${name}:error] ${line}`)
              appendToConsoleLog(line, 'stderr')
            }
          }
        }
      } catch (e) {
        // Process ended
      }
    })()
  }
}

// Browser console log - captures console.log/error/warn from client-side code
const BROWSER_LOG_MAX_LINES = 500
let browserLogLines: string[] = []
const BROWSER_LOG_PATH = join(PROJECT_DIR, '.browser.log')

function appendToBrowserLog(level: string, message: string) {
  const timestamp = new Date().toISOString().slice(11, 19) // HH:MM:SS
  const levelPrefix = level === 'error' ? '[err]' : level === 'warn' ? '[warn]' : '[log]'
  const logLine = `[${timestamp}] ${levelPrefix} ${message}`
  browserLogLines.push(logLine)
  if (browserLogLines.length > BROWSER_LOG_MAX_LINES) {
    browserLogLines = browserLogLines.slice(-BROWSER_LOG_MAX_LINES)
  }
  // Also write to file for agent access
  try {
    writeFileSync(BROWSER_LOG_PATH, browserLogLines.join('\n'))
  } catch (e) {
    // Ignore write errors
  }
}

/**
 * JavaScript snippet to inject into HTML pages to capture browser console logs.
 * Sends logs to /__console endpoint for server-side storage.
 */
const BROWSER_CONSOLE_CAPTURE_SCRIPT = `
<script>
(function() {
  if (window.__shogoBrowserLoggerInstalled) return;
  window.__shogoBrowserLoggerInstalled = true;
  
  const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console)
  };
  
  function sendLog(level, args) {
    try {
      const message = args.map(arg => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'object') {
          try { return JSON.stringify(arg); } catch { return String(arg); }
        }
        return String(arg);
      }).join(' ');
      
      fetch('/__console', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, message })
      }).catch(() => {});
    } catch (e) {}
  }
  
  console.log = function(...args) {
    originalConsole.log(...args);
    sendLog('log', args);
  };
  
  console.error = function(...args) {
    originalConsole.error(...args);
    sendLog('error', args);
  };
  
  console.warn = function(...args) {
    originalConsole.warn(...args);
    sendLog('warn', args);
  };
  
  // Capture unhandled errors
  window.addEventListener('error', function(event) {
    sendLog('error', ['Uncaught Error: ' + event.message + ' at ' + event.filename + ':' + event.lineno]);
  });
  
  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', function(event) {
    sendLog('error', ['Unhandled Promise Rejection: ' + (event.reason?.stack || event.reason?.message || event.reason)]);
  });
})();
</script>
`;

/**
 * Get current build status context for inclusion in agent system prompt.
 * Returns a formatted string describing the build state.
 * 
 * When there's a build error, this includes:
 * - Rich error context with category and root cause
 * - Explicit step-by-step recovery instructions
 * - Last 30 lines of build log
 * - Detected issues with suggestions
 */
export function getBuildStatusContext(): string {
  const now = Date.now()
  let status = ''
  const avgBuildTime = getAverageBuildTime()
  const avgStr = avgBuildTime ? `${(avgBuildTime / 1000).toFixed(1)}s` : 'unknown'
  
  if (buildState === 'building') {
    const elapsed = buildStartTime ? Math.round((now - buildStartTime) / 1000) : 0
    status = `⏳ BUILD IN PROGRESS (${elapsed}s elapsed, avg build time: ${avgStr}) - Wait for completion before testing changes`
  } else if (buildState === 'error' && buildError) {
    // Use rich error context if available
    if (buildErrorContext) {
      status = formatBuildErrorWithRecovery(buildErrorContext)
    } else {
      status = `❌ BUILD ERROR: ${buildError}\nFix the error and save the file - the build will retry automatically.`
    }
  } else if (buildState === 'success' || buildState === 'idle') {
    if (lastBuildTime) {
      const ago = Math.round((now - lastBuildTime) / 1000)
      const duration = buildDuration ? `${buildDuration}ms` : 'unknown'
      status = `✅ BUILD READY (last build: ${ago}s ago, took ${duration})`
    } else {
      status = '✅ BUILD READY'
    }
  }
  
  // Add average build time info if we have history
  const avgInfo = avgBuildTime 
    ? `\nAverage build time: ${avgStr} (based on last ${buildTimeHistory.length} builds)`
    : ''
  
  return `## Current Build Status

${status}${avgInfo}

**Log files available:**
- \`cat .build.log\` - Build output (compilation, bundling)
- \`cat .console.log\` - Server console output (API handlers, server-side logs)
- \`cat .browser.log\` - Browser console output (client-side logs, React errors, unhandled exceptions)
- \`curl -s http://localhost:${PORT}/preview/status | jq .buildWatch\` - Build status as JSON`
}

/**
 * Format build error with context for the agent.
 */
function formatBuildErrorWithRecovery(ctx: BuildErrorContext): string {
  return `❌ BUILD ERROR: ${ctx.rootCause}

**Error Category:** ${ctx.errorCategory}

Read the full build log for details: \`cat .build.log\`

**Log Excerpt (Last 30 Lines):**
\`\`\`
${ctx.logExcerpt}
\`\`\``
}

// SSE clients listening for build events
const buildEventClients = new Set<ReadableStreamDefaultController>()

/**
 * Check if a TCP port is accepting connections.
 * Uses Bun's native TCP socket support for reliability.
 */
async function checkTcpPort(host: string, port: number, timeoutMs: number = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false
    const resolveOnce = (value: boolean) => {
      if (!resolved) {
        resolved = true
        resolve(value)
      }
    }
    
    Bun.connect({
      hostname: host,
      port: port,
      socket: {
        open(socket) {
          socket.end()
          resolveOnce(true)
        },
        data() {},
        close() {},
        error() {
          resolveOnce(false)
        },
        connectError() {
          resolveOnce(false)
        },
      },
    }).catch(() => resolveOnce(false))
    
    // Timeout fallback
    setTimeout(() => resolveOnce(false), timeoutMs)
  })
}

/**
 * Wait for PostgreSQL to be ready to accept connections.
 * Uses direct TCP socket connection for reliability - no external tools needed.
 * Supports both local sidecar (localhost) and remote shared cluster (CloudNativePG).
 * Parses DATABASE_URL to determine the host and port.
 * 
 * @param timeoutMs - Maximum time to wait (default 30s)
 * @returns true if postgres is ready, false if timeout
 */
async function waitForPostgresReady(timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 500
  
  // Parse host and port from DATABASE_URL, fallback to localhost:5432
  let pgHost = 'localhost'
  let pgPort = 5432
  const dbUrl = process.env.DATABASE_URL
  if (dbUrl) {
    try {
      const url = new URL(dbUrl)
      pgHost = url.hostname
      pgPort = parseInt(url.port, 10) || 5432
    } catch {
      // Invalid URL, use defaults
    }
  }
  
  console.log(`[project-runtime] Waiting for PostgreSQL at ${pgHost}:${pgPort}...`)
  
  while (Date.now() - startTime < timeoutMs) {
    // Direct TCP connection check - most reliable method
    const isReady = await checkTcpPort(pgHost, pgPort, 1000)
    if (isReady) {
      const elapsed = Date.now() - startTime
      console.log(`[project-runtime] PostgreSQL ready after ${elapsed}ms (TCP check on ${pgHost}:${pgPort})`)
      return true
    }
    
    await new Promise(resolve => setTimeout(resolve, checkInterval))
  }
  
  console.error(`[project-runtime] PostgreSQL not ready after ${timeoutMs}ms at ${pgHost}:${pgPort}`)
  return false
}

/**
 * Parse Vite stdout to detect rebuild events
 */
function parseViteBuildOutput(line: string): 'start' | 'success' | 'error' | null {
  // Vite build start: "vite v5.x.x building for production..." or "building..."
  if (line.includes('building for production') || line.includes('building...')) {
    return 'start'
  }
  // Vite build success: "✓ built in XXXms" or "built in"
  if (line.includes('✓ built in') || line.match(/built in \d+/)) {
    return 'success'
  }
  // Vite build error: typically starts with "error" or "failed"
  if (line.toLowerCase().includes('error') || line.toLowerCase().includes('failed')) {
    return 'error'
  }
  return null
}

/**
 * Notify all SSE clients about build state change
 */
function notifyBuildStateChange() {
  const payload = JSON.stringify({
    state: buildState,
    startTime: buildStartTime,
    duration: buildDuration,
    lastBuildTime: lastBuildTime,
    error: buildError,
    // Include error context for rich error display
    errorContext: buildErrorContext ? {
      category: buildErrorContext.errorCategory,
      rootCause: buildErrorContext.rootCause,
      canAutoRecover: buildErrorContext.canSelfFix,
      suggestions: buildErrorContext.detectedIssues?.map(i => i.suggestion) || [],
    } : null,
    // Include last 10 lines of build log for quick preview
    logPreview: buildLogLines.slice(-10).join('\n'),
    // Include crash recovery info
    watchCrashCount,
    canAutoRestart: watchCrashCount <= MAX_WATCH_CRASHES,
    timestamp: Date.now(),
  })
  
  const encoder = new TextEncoder()
  const message = encoder.encode(`data: ${payload}\n\n`)
  
  // Notify all connected clients - collect dead controllers to avoid modifying Set during iteration
  const deadControllers: ReadableStreamDefaultController[] = []
  for (const controller of buildEventClients) {
    try {
      controller.enqueue(message)
    } catch (e) {
      // Client disconnected
      deadControllers.push(controller)
    }
  }
  // Clean up dead controllers after iteration
  for (const dead of deadControllers) {
    buildEventClients.delete(dead)
  }
  
  if (buildEventClients.size > 0) {
    console.log(`[project-runtime] 📡 Notified ${buildEventClients.size} client(s) of build state: ${buildState}`)
  }
}

/**
 * Start Vite in watch mode with rebuild detection.
 * Monitors stdout for rebuild events and notifies SSE clients.
 * Automatically recovers from crashes (like the Object.entries bug).
 */
async function startViteBuildWatch(): Promise<void> {
  if (buildWatchProcess) {
    console.log('[project-runtime] Vite watch already running')
    return
  }
  
  console.log('[project-runtime] 🔄 Starting Vite build watch...')
  
  buildWatchProcess = Bun.spawn(['bun', '--bun', 'vite', 'build', '--watch'], {
    cwd: PROJECT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  
  const currentProcess = buildWatchProcess
  
  // Monitor process exit for auto-recovery
  currentProcess.exited.then((exitCode) => {
    // Only handle if this is still the current process
    if (buildWatchProcess !== currentProcess) return
    
    console.log(`[project-runtime] ⚠️ Vite watch process exited with code ${exitCode}`)
    buildWatchProcess = null
    
    // Handle crash recovery
    const now = Date.now()
    if (lastWatchCrashTime && now - lastWatchCrashTime > 60000) {
      // Reset crash count if more than 1 minute since last crash
      watchCrashCount = 0
    }
    
    lastWatchCrashTime = now
    watchCrashCount++
    
    // Check if this was likely a known Object.entries crash
    const isKnownCrash = buildError?.includes('Object.entries') || 
                       buildLogLines.some(l => l.includes('Object.entries'))
    
    if (isKnownCrash) {
      console.log('[project-runtime] 🔧 Detected Object.entries crash - will auto-recover')
      appendToBuildLog('⚠️ Watch process crashed (known issue)')
    }
    
    // Notify frontend of crash
    buildState = 'error'
    buildError = buildError || `Watch process crashed (exit code ${exitCode})`
    buildErrorContext = {
      errorMessage: buildError,
      errorCategory: isKnownCrash ? 'build_tool' : 'unknown',
      rootCause: isKnownCrash 
        ? 'Vite watch mode crash (Object.entries on null)'
        : 'Watch process exited unexpectedly',
      canSelfFix: true,
      logFilePath: '.build.log',
      logExcerpt: buildLogLines.slice(-30).join('\n'),
      detectedIssues: isKnownCrash ? [{
        type: 'vite_watch_crash',
        suggestion: 'This is a known Vite watch mode bug. Auto-recovery in progress.'
      }] : [],
      recoverySteps: ['Automatic restart in progress...']
    }
    notifyBuildStateChange()
    
    // Auto-restart if under crash limit
    if (watchCrashCount <= MAX_WATCH_CRASHES) {
      const delay = WATCH_CRASH_COOLDOWN_MS * watchCrashCount  // Exponential backoff
      console.log(`[project-runtime] 🔄 Auto-restarting watch in ${delay}ms (crash ${watchCrashCount}/${MAX_WATCH_CRASHES})`)
      appendToBuildLog(`🔄 Auto-restarting watch in ${delay/1000}s...`)
      
      setTimeout(() => {
        if (!buildWatchProcess) {
          console.log('[project-runtime] 🔄 Attempting watch process recovery...')
          startViteBuildWatch()
        }
      }, delay)
    } else {
      console.error(`[project-runtime] ❌ Watch process crashed ${watchCrashCount} times - giving up auto-restart`)
      appendToBuildLog(`❌ Watch process crashed too many times. Use "Rebuild" button to restart.`)
      buildError = 'Watch process crashed repeatedly. Use the Rebuild button to manually restart.'
      notifyBuildStateChange()
    }
  })
  
  // Stream stdout and detect rebuild events
  ;(async () => {
    if (!currentProcess.stdout) return
    const stdout = currentProcess.stdout
    if (typeof stdout === 'number') return
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    
    while (buildWatchProcess === currentProcess) {
      try {
        const { done, value } = await reader.read()
        if (done) break
        
        const output = decoder.decode(value)
        const lines = output.split('\n')
        
        for (const line of lines) {
          // Log to console for debugging
          if (line.trim()) {
            console.log(`[vite] ${line}`)
            appendToBuildLog(line)
          }
          
          // Parse for events
          const event = parseViteBuildOutput(line)
          if (event === 'start') {
            buildState = 'building'
            buildStartTime = Date.now()
            buildError = null
            buildErrorContext = null  // Clear error context on new build
            appendToBuildLog('🔨 Build started...')
            console.log('[project-runtime] 🔨 Vite rebuild started')
            notifyBuildStateChange()
          } else if (event === 'success') {
            buildState = 'success'
            // If we missed the 'start' event (race condition during startup), 
            // use the watch start time or estimate duration from Vite's own output
            if (!buildStartTime) {
              buildStartTime = Date.now() - 5000 // Estimate 5s if we missed the start
            }
            buildDuration = Date.now() - buildStartTime
            lastBuildTime = Date.now()
            if (buildDuration) recordBuildTime(buildDuration)
            appendToBuildLog(`✅ Build complete (${buildDuration}ms)`)
            console.log(`[project-runtime] ✅ Vite rebuild complete (${buildDuration}ms)`)
            // Reset crash count on successful build
            watchCrashCount = 0
            notifyBuildStateChange()
            
            // Restart the backend API server after each successful rebuild.
            // This ensures any changes to generated routes (from `shogo generate`)
            // or server.tsx are picked up immediately. The overhead is minimal
            // (~500ms to restart a Bun process) vs the UX cost of stale API routes.
            if (serverProcess) {
              const serverTsxPath = join(PROJECT_DIR, 'server.tsx')
              const serverTsPath = join(PROJECT_DIR, 'server.ts')
              const serverPath = existsSync(serverTsxPath) ? serverTsxPath : (existsSync(serverTsPath) ? serverTsPath : null)
              if (serverPath) {
                console.log('[project-runtime] 🔄 Restarting backend API server after rebuild...')
                serverProcess.kill()
                serverProcess = null
                serverProcess = Bun.spawn(['bun', 'run', serverPath], {
                  cwd: PROJECT_DIR,
                  env: { ...process.env, PORT: String(SERVER_PORT) },
                  stdout: 'pipe',
                  stderr: 'pipe',
                })
                streamProcessOutput(serverProcess, 'api-server')
                appendToBuildLog('🔄 Backend API server restarted')
              }
            }
            
            // Return to idle after 1s
            setTimeout(() => {
              if (buildState === 'success') {
                buildState = 'idle'
                notifyBuildStateChange()
              }
            }, 1000)
          } else if (event === 'error') {
            buildState = 'error'
            buildError = line
            buildErrorContext = analyzeBuildError(line)  // Create rich error context
            appendToBuildLog(`❌ Build error: ${line}`)
            console.error('[project-runtime] ❌ Vite rebuild error:', line)
            console.log('[project-runtime] Error context:', JSON.stringify(buildErrorContext, null, 2))
            notifyBuildStateChange()
          }
        }
      } catch (e) {
        console.error('[project-runtime] Error reading Vite output:', e)
        break
      }
    }
  })()
  
  // Also stream stderr - but only treat actual errors as build failures
  // Vite commonly outputs warnings and informational messages to stderr
  ;(async () => {
    if (!currentProcess.stderr) return
    const stderr = currentProcess.stderr
    if (typeof stderr === 'number') return
    const reader = stderr.getReader()
    const decoder = new TextDecoder()
    
    while (buildWatchProcess === currentProcess) {
      try {
        const { done, value } = await reader.read()
        if (done) break
        const output = decoder.decode(value)
        if (output.trim()) {
          console.error(`[vite:error] ${output}`)
          appendToBuildLog(`[error] ${output}`)
          
          // Only treat stderr as a build error if it contains actual error indicators
          // AND we're currently building. Vite outputs warnings/deprecations to stderr
          // that shouldn't be treated as build failures.
          const isActualError = output.includes('Error:') || 
                               output.includes('error:') ||
                               output.includes('ENOENT') ||
                               output.includes('SIGTERM') ||
                               output.includes('Failed to')
          if (buildState === 'building' && isActualError) {
            buildState = 'error'
            buildError = output
            buildErrorContext = analyzeBuildError(output)
            notifyBuildStateChange()
          }
        }
      } catch (e) {
        break
      }
    }
  })()
  
  console.log('[project-runtime] ✅ Vite watch started')
}

/**
 * Stop Vite watch process
 */
function stopViteBuildWatch(): void {
  if (buildWatchProcess) {
    console.log('[project-runtime] Stopping Vite build watch...')
    buildWatchProcess.kill()
    buildWatchProcess = null
    buildState = 'idle'
    notifyBuildStateChange()
  }
}

/**
 * Pause/resume watcher API endpoints.
 * Used by `bunx shogo generate` (scripts/generate.ts) to prevent the watcher
 * from crashing due to rapid file writes during code generation.
 * 
 * Flow: pause → write generated files → resume (triggers fresh build + restart watch)
 */
let watcherPausedForGenerate = false
let watcherPauseTimeout: ReturnType<typeof setTimeout> | null = null

app.post('/preview/watch/pause', async (c) => {
  if (buildWatchProcess) {
    console.log('[project-runtime] ⏸️  Pausing watcher for code generation...')
    stopViteBuildWatch()
    watcherPausedForGenerate = true
    
    // Safety: auto-resume after 60s in case generate crashes without resuming
    if (watcherPauseTimeout) clearTimeout(watcherPauseTimeout)
    watcherPauseTimeout = setTimeout(() => {
      if (watcherPausedForGenerate) {
        console.log('[project-runtime] ⚠️ Watcher pause timeout - auto-resuming')
        watcherPausedForGenerate = false
        startViteBuildWatch()
      }
    }, 60000)
    
    return c.json({ paused: true })
  }
  return c.json({ paused: false, message: 'No watcher running' })
})

app.post('/preview/watch/resume', async (c) => {
  if (watcherPauseTimeout) {
    clearTimeout(watcherPauseTimeout)
    watcherPauseTimeout = null
  }
  watcherPausedForGenerate = false
  
  // Reset crash count since this is a controlled restart
  watchCrashCount = 0
  lastWatchCrashTime = null
  
  console.log('[project-runtime] ▶️  Resuming watcher after code generation...')
  
  // Run a fresh build first, then start watch mode
  try {
    console.log('[project-runtime] 🔨 Running fresh build after generation...')
    appendToBuildLog('🔨 Building after code generation...')
    buildState = 'building'
    buildStartTime = Date.now()
    notifyBuildStateChange()
    
    const buildProc = Bun.spawnSync(['bun', '--bun', 'vite', 'build'], {
      cwd: PROJECT_DIR,
      env: process.env,
    })
    
    const stdout = buildProc.stdout?.toString() || ''
    const stderr = buildProc.stderr?.toString() || ''
    if (stdout.trim()) appendToBuildLog(stdout)
    if (stderr.trim()) appendToBuildLog(`[error] ${stderr}`)
    
    const durationMs = Date.now() - (buildStartTime || Date.now())
    
    if (buildProc.exitCode === 0) {
      buildState = 'success'
      buildDuration = durationMs
      lastBuildTime = Date.now()
      recordBuildTime(durationMs)
      appendToBuildLog(`✅ Build complete (${durationMs}ms)`)
      console.log(`[project-runtime] ✅ Post-generate build complete (${durationMs}ms)`)
    } else {
      buildState = 'error'
      buildError = stderr || 'Build failed'
      buildErrorContext = analyzeBuildError(buildError)
      appendToBuildLog(`❌ Build failed: ${stderr}`)
      console.error(`[project-runtime] ❌ Post-generate build failed:`, stderr)
    }
    notifyBuildStateChange()
    
    // Restart the backend server to pick up new generated routes
    // This must always restart (not just when serverProcess exists) because
    // generation may have changed models/routes, and the server needs fresh imports.
    const serverTsxPath = join(PROJECT_DIR, 'server.tsx')
    const serverTsPath = join(PROJECT_DIR, 'server.ts')
    const serverPath = existsSync(serverTsxPath) ? serverTsxPath : (existsSync(serverTsPath) ? serverTsPath : null)
    
    if (serverPath && !isExpo) {
      console.log('[project-runtime] 🔄 Restarting backend API server...')
      if (serverProcess) {
        serverProcess.kill()
        serverProcess = null
      }
      serverProcess = Bun.spawn(['bun', 'run', serverPath], {
        cwd: PROJECT_DIR,
        env: { ...process.env, PORT: String(SERVER_PORT) },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      streamProcessOutput(serverProcess, 'api-server')
      
      // Wait for server to be ready (critical: detect startup crashes early)
      let serverReady = false
      for (let attempt = 1; attempt <= 10 && !serverReady; attempt++) {
        try {
          const healthCheck = await fetch(`http://localhost:${SERVER_PORT}/health`, {
            signal: AbortSignal.timeout(500),
          })
          if (healthCheck.ok || healthCheck.status < 500) {
            serverReady = true
            console.log(`[project-runtime] ✅ Backend API server ready after ${attempt} attempt(s)`)
            appendToBuildLog(`✅ Backend API server ready`)
          }
        } catch (e) {
          await new Promise(resolve => setTimeout(resolve, Math.min(100 * attempt, 500)))
        }
      }
      
      if (!serverReady) {
        console.warn('[project-runtime] ⚠️ Backend API server may still be starting...')
        appendToBuildLog('⚠️ Backend API server may still be starting after generation')
      }
    }
    
    // Restart watch mode
    await startViteBuildWatch()
    
    // Trigger S3 sync
    if (s3Sync) {
      s3Sync.triggerSync()
    }
    
    return c.json({ 
      resumed: true, 
      buildSuccess: buildProc.exitCode === 0,
      durationMs,
    })
  } catch (err: any) {
    console.error('[project-runtime] Error resuming watcher:', err)
    // Still try to restart watch mode even if build failed
    await startViteBuildWatch()
    return c.json({ resumed: true, error: err.message }, 500)
  }
})

/**
 * Restart the preview server after template changes.
 * This will:
 * 1. Kill any existing server processes
 * 2. Install dependencies
 * 3. Wait for PostgreSQL to be ready (if prisma is present)
 * 4. Run prisma generate/push if needed
 * 5. Build with Vite
 * 6. Start the Hono server (for Expo) or serve static files (plain Vite)
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
    // 1. Kill existing servers (Hono, Vite dev, Expo if running)
    if (serverProcess) {
      console.log('[project-runtime] Stopping existing backend server...')
      serverProcess.kill()
      serverProcess = null
    }
    if (expoServerProcess) {
      console.log('[project-runtime] Stopping existing Expo server...')
      expoServerProcess.kill()
      expoServerProcess = null
    }
    if (viteDevProcess) {
      // Note: Killing vite will cause exit code 143 (SIGTERM) - this is expected
      console.log('[project-runtime] Stopping existing Vite dev server (exit code 143 is expected)...')
      viteDevProcess.kill()
      viteDevProcess = null
      isDevMode = false
      devModeStarting = false
    }
    if (expoDevProcess) {
      console.log('[project-runtime] Stopping existing Expo dev server...')
      expoDevProcess.kill()
      expoDevProcess = null
    }
    // Stop build watch process if running
    stopViteBuildWatch()
    markStep('killExistingServer')
    
    // 2. Check project type
    const packageJsonPath = join(PROJECT_DIR, 'package.json')
    if (!existsSync(packageJsonPath)) {
      const totalMs = Math.round(performance.now() - startTime)
      return c.json({ success: false, error: 'No package.json found', timings: { steps: timings, totalMs } }, 400)
    }
    
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies }
    isExpo = !!deps['expo']
    const hasPrisma = !!deps['@prisma/client'] || !!deps['prisma']
    markStep('parsePackageJson')

    const projectType = isExpo ? 'Expo (React Native)' : 'Vite + Hono'
    console.log(`[project-runtime] Project type: ${projectType}`)
    
    // 3. Install dependencies (skip if node_modules was copied from pre-installed template)
    const nodeModulesPath = join(PROJECT_DIR, 'node_modules')
    const nodeModulesExists = existsSync(nodeModulesPath)
    
    // Check if node_modules appears complete (has key packages)
    const hasReact = existsSync(join(nodeModulesPath, 'react'))
    const hasVite = existsSync(join(nodeModulesPath, 'vite'))
    const nodeModulesComplete = nodeModulesExists && hasReact && hasVite
    
    // Check if package.json has overrides - if so, we MUST run bun install to apply them
    // This is critical for templates using rolldown-vite via "overrides": { "vite": "npm:rolldown-vite@latest" }
    const hasOverrides = !!(packageJson.overrides || packageJson.resolutions)
    if (hasOverrides) {
      console.log('[project-runtime] Package has overrides/resolutions - will run bun install to apply them')
    }
    
    if (nodeModulesComplete && !hasOverrides) {
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
        const prismaGenProc = Bun.spawn(['bun', '--bun', 'x', 'prisma', 'generate'], {
          cwd: PROJECT_DIR,
          stdout: 'inherit',
          stderr: 'inherit',
        })
        await prismaGenProc.exited
        markStep('prismaGenerate')
        
        if (prismaGenProc.exitCode !== 0) {
          console.error('[project-runtime] ❌ prisma generate failed with exit code:', prismaGenProc.exitCode)
          // Track failure for circuit breaker (shared with auto-start)
          devModeFailureCount++
          devModeLastFailure = Date.now()
          devModeError = `prisma generate failed with exit code ${prismaGenProc.exitCode}`
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
      const prismaPushProc = Bun.spawn(['bun', '--bun', 'x', 'prisma', 'db', 'push', '--accept-data-loss'], {
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
        // Track failure for circuit breaker (shared with auto-start)
        devModeFailureCount++
        devModeLastFailure = Date.now()
        devModeError = `prisma db push failed with exit code ${prismaPushProc.exitCode}`
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
    
    const viteDistPath = join(PROJECT_DIR, 'dist', 'index.html')
    const expoDistPath = join(PROJECT_DIR, 'dist', 'index.html')
    const expoServerPath = join(PROJECT_DIR, 'server.ts')
    const viteDistExists = existsSync(viteDistPath)
    const expoDistExists = existsSync(expoDistPath) && existsSync(expoServerPath) && isExpo
    const buildExists = isExpo ? expoDistExists : viteDistExists
    
    // Check if source files have been modified since the last build
    let sourceFilesModified = false
    if (buildExists && !forceRebuild) {
      const buildPath = viteDistPath
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
      console.log(`[project-runtime] 🔨 ${isExpo ? 'EXPO' : 'VITE'} BUILD STARTING...`)
      console.log('[project-runtime] ════════════════════════════════════════')
      const buildStartTime = performance.now()

      let buildProc: ReturnType<typeof Bun.spawn>
      if (isExpo) {
        // For Expo: export web build to dist/
        buildProc = Bun.spawn(['bunx', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist'], {
          cwd: PROJECT_DIR,
          stdout: 'inherit',
          stderr: 'inherit',
        })
      } else {
        buildProc = Bun.spawn(['bun', '--bun', 'vite', 'build'], {
          cwd: PROJECT_DIR,
          stdout: 'inherit',
          stderr: 'inherit',
        })
      }
      await buildProc.exited
      const buildDuration = Math.round(performance.now() - buildStartTime)
      console.log('[project-runtime] ════════════════════════════════════════')
      console.log(`[project-runtime] ✅ ${isExpo ? 'EXPO' : 'VITE'} BUILD COMPLETED: ${buildDuration}ms (${(buildDuration / 1000).toFixed(2)}s)`)
      console.log('[project-runtime] ════════════════════════════════════════')
      markStep(isExpo ? 'expoBuild' : 'viteBuild')
      
      if (buildProc.exitCode !== 0) {
        console.error('[project-runtime] Build failed')
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ success: false, error: 'Build failed', timings: { steps: timings, totalMs } }, 500)
      }
    }
    
    // After initial build completes, start watch mode for future automatic rebuilds
    // Expo uses Metro bundler, so watch mode doesn't apply
    if (!isExpo) {
      console.log('[project-runtime] 🔄 Starting Vite watch mode for automatic rebuilds...')
      await startViteBuildWatch()
      markStep('startViteBuildWatch')
    }
    
    // 6. Start Hono/API server if server.ts or server.tsx exists
    // For Expo: required (serves both API routes and static files)
    // For plain Vite: optional (serves API routes like /api/* if the project has a backend)
    const serverTsPath = join(PROJECT_DIR, 'server.ts')
    const serverTsxPath = join(PROJECT_DIR, 'server.tsx')
    const serverPath = existsSync(serverTsxPath) ? serverTsxPath : serverTsPath
    const hasServerFile = existsSync(serverPath)
    
    if (isExpo) {
      if (!hasServerFile) {
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ success: false, error: 'Expo server.ts not found', timings: { steps: timings, totalMs } }, 500)
      }

      console.log(`[project-runtime] ⏱️  Starting Expo Hono server on port ${EXPO_SERVER_PORT}...`)
      appendToConsoleLog(`--- Expo server starting on port ${EXPO_SERVER_PORT} ---`, 'stdout')
      expoServerProcess = Bun.spawn(['bun', 'run', serverPath], {
        cwd: PROJECT_DIR,
        env: { ...process.env, PORT: String(EXPO_SERVER_PORT) },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      streamProcessOutput(expoServerProcess, 'expo')

      // Wait for server to be ready with exponential backoff
      let serverReady = false
      const maxAttempts = 10
      const baseDelayMs = 100

      for (let attempt = 1; attempt <= maxAttempts && !serverReady; attempt++) {
        try {
          const healthCheck = await fetch(`http://localhost:${EXPO_SERVER_PORT}/`, {
            signal: AbortSignal.timeout(500),
          })
          if (healthCheck.ok || healthCheck.status < 500) {
            serverReady = true
            console.log(`[project-runtime] ⏱️  Expo Hono server ready after ${attempt} attempt(s)`)
          }
        } catch (e) {
          const delay = Math.min(baseDelayMs * attempt, 500)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
      markStep('startExpoServer')

      if (!serverReady) {
        console.warn('[project-runtime] Expo Hono server may still be starting after health checks...')
      }
    } else if (hasServerFile) {
      // Plain Vite project with server.ts — start it for API route handling
      // This allows projects with a Hono backend (e.g., /api/* routes) to work correctly.
      // Without this, /api/* requests fall through to static file serving and return HTML.
      console.log(`[project-runtime] ⏱️  Starting project API server on port ${SERVER_PORT}...`)
      appendToConsoleLog(`--- Project API server starting on port ${SERVER_PORT} ---`, 'stdout')
      
      // Kill existing server process if any
      if (serverProcess) {
        serverProcess.kill()
        serverProcess = null
      }
      
      serverProcess = Bun.spawn(['bun', 'run', serverPath], {
        cwd: PROJECT_DIR,
        env: { ...process.env, PORT: String(SERVER_PORT) },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      streamProcessOutput(serverProcess, 'api-server')

      // Wait for server to be ready with exponential backoff
      let serverReady = false
      const maxAttempts = 10
      const baseDelayMs = 100

      for (let attempt = 1; attempt <= maxAttempts && !serverReady; attempt++) {
        try {
          const healthCheck = await fetch(`http://localhost:${SERVER_PORT}/`, {
            signal: AbortSignal.timeout(500),
          })
          if (healthCheck.ok || healthCheck.status < 500) {
            serverReady = true
            console.log(`[project-runtime] ⏱️  Project API server ready after ${attempt} attempt(s)`)
          }
        } catch (e) {
          const delay = Math.min(baseDelayMs * attempt, 500)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
      markStep('startProjectApiServer')

      if (!serverReady) {
        console.warn('[project-runtime] Project API server may still be starting after health checks...')
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

    const mode = isExpo ? 'expo' : (serverProcess ? 'static+api' : 'static')
    const port = isExpo ? EXPO_SERVER_PORT : (serverProcess ? SERVER_PORT : null)

    return c.json({
      success: true,
      mode,
      port,
      timings: { steps: timings, totalMs },
    })
  } catch (error: any) {
    const totalMs = Math.round(performance.now() - startTime)
    console.error(`[project-runtime] ⏱️  Preview restart error after ${totalMs}ms:`, error)
    return c.json({ success: false, error: error.message, timings: { steps: timings, totalMs } }, 500)
  }
})

/**
 * Manual rebuild endpoint - triggers a fresh vite build and restarts watch mode.
 * Use this when:
 * - Watch mode has crashed and auto-recovery failed
 * - User wants to force a full rebuild
 * - Build is in an error state and user wants to retry
 */
app.post('/preview/rebuild', async (c) => {
  const startTime = performance.now()
  
  console.log('[project-runtime] 🔨 Manual rebuild triggered')
  appendToBuildLog('🔨 Manual rebuild triggered by user')
  
  try {
    // 1. Stop existing watch process
    stopViteBuildWatch()
    
    // Reset crash counter for manual rebuilds
    watchCrashCount = 0
    lastWatchCrashTime = null
    
    // 2. Clear error state and set to building
    buildState = 'building'
    buildStartTime = Date.now()
    buildError = null
    buildErrorContext = null
    notifyBuildStateChange()
    
    // 3. Run a fresh vite build
    console.log('[project-runtime] 🔨 Running fresh vite build...')
    appendToBuildLog('🔨 Running fresh vite build...')
    
    const buildProc = Bun.spawnSync(['bun', '--bun', 'vite', 'build'], {
      cwd: PROJECT_DIR,
      env: process.env,
    })
    
    const stdout = buildProc.stdout?.toString() || ''
    const stderr = buildProc.stderr?.toString() || ''
    
    // Log output
    if (stdout.trim()) {
      appendToBuildLog(stdout)
      console.log(`[vite] ${stdout}`)
    }
    if (stderr.trim()) {
      appendToBuildLog(`[error] ${stderr}`)
      console.error(`[vite:error] ${stderr}`)
    }
    
    const durationMs = Math.round(performance.now() - startTime)
    
    if (buildProc.exitCode !== 0) {
      buildState = 'error'
      buildError = stderr || 'Build failed with exit code ' + buildProc.exitCode
      buildErrorContext = analyzeBuildError(buildError)
      buildDuration = durationMs
      appendToBuildLog(`❌ Build failed (${durationMs}ms)`)
      notifyBuildStateChange()
      
      return c.json({
        success: false,
        error: buildError,
        buildLog: buildLogLines.slice(-50).join('\n'),
        durationMs,
      }, 500)
    }
    
    // 4. Build succeeded - update state
    buildState = 'success'
    buildDuration = durationMs
    lastBuildTime = Date.now()
    recordBuildTime(durationMs)
    appendToBuildLog(`✅ Build complete (${durationMs}ms)`)
    console.log(`[project-runtime] ✅ Manual rebuild complete (${durationMs}ms)`)
    notifyBuildStateChange()
    
    // 4a. Update BUILD_STATUS_FILE so readiness probe reflects the successful build
    // (getBuildStatus reads from this file, not the in-memory buildState)
    if (FAST_START_MODE) {
      try {
        writeFileSync(BUILD_STATUS_FILE, 'ready')
        console.log(`[project-runtime] ✅ Build status file updated to 'ready'`)
      } catch (e) {
        console.warn(`[project-runtime] ⚠️ Failed to update build status file:`, e)
      }
    }
    
    // 4b. Restart the backend server process if server.tsx exists
    // This is critical: when the AI modifies server.tsx or generates new API routes,
    // the old serverProcess is stale and must be restarted to pick up changes.
    const serverTsxPath = join(PROJECT_DIR, 'server.tsx')
    const serverTsPath = join(PROJECT_DIR, 'server.ts')
    const rebuildServerPath = existsSync(serverTsxPath) ? serverTsxPath : (existsSync(serverTsPath) ? serverTsPath : null)
    
    if (rebuildServerPath && !isExpo) {
      console.log(`[project-runtime] 🔄 Restarting backend API server (${rebuildServerPath})...`)
      appendToBuildLog('🔄 Restarting backend API server...')
      
      if (serverProcess) {
        serverProcess.kill()
        serverProcess = null
      }
      
      serverProcess = Bun.spawn(['bun', 'run', rebuildServerPath], {
        cwd: PROJECT_DIR,
        env: { ...process.env, PORT: String(SERVER_PORT) },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      streamProcessOutput(serverProcess, 'api-server')
      
      // Wait for server to be ready
      let serverReady = false
      for (let attempt = 1; attempt <= 10 && !serverReady; attempt++) {
        try {
          const healthCheck = await fetch(`http://localhost:${SERVER_PORT}/health`, {
            signal: AbortSignal.timeout(500),
          })
          if (healthCheck.ok || healthCheck.status < 500) {
            serverReady = true
            console.log(`[project-runtime] ✅ Backend API server ready after ${attempt} attempt(s)`)
            appendToBuildLog(`✅ Backend API server ready`)
          }
        } catch (e) {
          await new Promise(resolve => setTimeout(resolve, Math.min(100 * attempt, 500)))
        }
      }
      
      if (!serverReady) {
        console.warn('[project-runtime] ⚠️ Backend API server may still be starting...')
        appendToBuildLog('⚠️ Backend API server may still be starting...')
      }
    }
    
    // 5. Restart watch mode for future changes
    console.log('[project-runtime] 🔄 Restarting watch mode...')
    await startViteBuildWatch()
    
    // 6. Trigger S3 sync to persist the build output
    if (s3Sync) {
      console.log('[project-runtime] 📦 Triggering S3 sync after rebuild')
      s3Sync.triggerSync()
    }
    
    // Return to idle after short delay
    setTimeout(() => {
      if (buildState === 'success') {
        buildState = 'idle'
        notifyBuildStateChange()
      }
    }, 1000)
    
    return c.json({
      success: true,
      buildLog: buildLogLines.slice(-50).join('\n'),
      durationMs,
    })
  } catch (error: any) {
    const durationMs = Math.round(performance.now() - startTime)
    console.error('[project-runtime] ❌ Manual rebuild error:', error)
    
    buildState = 'error'
    buildError = error.message || 'Rebuild failed'
    appendToBuildLog(`❌ Rebuild error: ${buildError}`)
    notifyBuildStateChange()
    
    return c.json({
      success: false,
      error: error.message,
      buildLog: buildLogLines.slice(-50).join('\n'),
      durationMs,
    }, 500)
  }
})

/**
 * Get the current build log (last N lines)
 */
app.get('/build-log', (c) => {
  const lines = parseInt(c.req.query('lines') || '100', 10)
  return c.json({
    log: buildLogLines.slice(-lines).join('\n'),
    totalLines: buildLogLines.length,
    state: buildState,
    error: buildError,
    errorContext: buildErrorContext,
  })
})

/**
 * Start Vite Dev Server with HMR
 * 
 * This provides instant updates via Hot Module Replacement instead of rebuilding.
 * Much faster for iterative development:
 * - First start: ~1-2s
 * - Subsequent updates: instant (HMR)
 * 
 * Steps:
 * 1. Kill any existing build/vite processes
 * 2. Check project type
 * 3. Install dependencies if needed
 * 4. Run prisma generate/push if needed
 * 5. Start vite dev server
 */
app.post('/preview/dev', async (c) => {
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
  
  console.log(`[project-runtime] ⏱️  Starting dev mode for project ${PROJECT_ID}...`)
  devModeStarting = true
  
  try {
    // 1. Kill existing processes
    if (serverProcess) {
      console.log('[project-runtime] Stopping existing backend server...')
      serverProcess.kill()
      serverProcess = null
    }
    if (expoServerProcess) {
      console.log('[project-runtime] Stopping existing Expo server...')
      expoServerProcess.kill()
      expoServerProcess = null
    }
    if (viteDevProcess) {
      // Note: Killing vite will cause exit code 143 (SIGTERM) - this is expected
      console.log('[project-runtime] Stopping existing Vite dev server (exit code 143 is expected)...')
      viteDevProcess.kill()
      viteDevProcess = null
    }
    if (expoDevProcess) {
      console.log('[project-runtime] Stopping existing Expo dev server...')
      expoDevProcess.kill()
      expoDevProcess = null
    }
    markStep('killExistingServers')
    
    // 2. Check project type
    const packageJsonPath = join(PROJECT_DIR, 'package.json')
    if (!existsSync(packageJsonPath)) {
      devModeStarting = false  // Reset flag on failure
      const totalMs = Math.round(performance.now() - startTime)
      return c.json({ success: false, error: 'No package.json found', timings: { steps: timings, totalMs } }, 400)
    }
    
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies }
    // Use local variables first, only update globals after successful start
    const detectedExpo = !!deps['expo']
    const hasPrisma = !!deps['@prisma/client'] || !!deps['prisma']
    markStep('parsePackageJson')

    const projectType = detectedExpo ? 'Expo (React Native)' : 'Vite + Hono'
    console.log(`[project-runtime] Project type: ${projectType}`)
    
    // 3. Install dependencies (skip if node_modules was copied from pre-installed template)
    const nodeModulesPath = join(PROJECT_DIR, 'node_modules')
    const nodeModulesExists = existsSync(nodeModulesPath)
    const hasReact = existsSync(join(nodeModulesPath, 'react'))
    const hasVite = existsSync(join(nodeModulesPath, 'vite'))
    const nodeModulesComplete = nodeModulesExists && hasReact && hasVite
    
    // Check if package.json has overrides - if so, we MUST run bun install to apply them
    // This is critical for templates using rolldown-vite via "overrides": { "vite": "npm:rolldown-vite@latest" }
    const hasOverrides = !!(packageJson.overrides || packageJson.resolutions)
    if (hasOverrides) {
      console.log('[project-runtime] Package has overrides/resolutions - will run bun install to apply them')
    }
    
    if (nodeModulesComplete && !hasOverrides) {
      console.log('[project-runtime] ⚡ node_modules already exists - skipping bun install')
      markStep('bunInstall (skipped)')
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
        devModeStarting = false  // Reset flag on failure
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ success: false, error: 'Dependency installation failed', timings: { steps: timings, totalMs } }, 500)
      }
    }
    
    // 4. Run prisma generate and db push if prisma is present
    if (hasPrisma) {
      const postgresReady = await waitForPostgresReady(30000)
      markStep('waitForPostgres')
      
      if (!postgresReady) {
        devModeStarting = false  // Reset flag on failure
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ 
          success: false, 
          error: 'PostgreSQL database not ready',
          timings: { steps: timings, totalMs } 
        }, 503)
      }
      
      const prismaClientExists = existsSync(join(PROJECT_DIR, 'node_modules', '.prisma', 'client', 'index.js'))
      
      if (prismaClientExists) {
        console.log('[project-runtime] ⚡ Prisma client already exists - skipping prisma generate')
        markStep('prismaGenerate (skipped)')
      } else {
        console.log('[project-runtime] ⏱️  Running prisma generate...')
        const prismaGenProc = Bun.spawn(['bun', '--bun', 'x', 'prisma', 'generate'], {
          cwd: PROJECT_DIR,
          stdout: 'inherit',
          stderr: 'inherit',
        })
        await prismaGenProc.exited
        markStep('prismaGenerate')
        
        if (prismaGenProc.exitCode !== 0) {
          devModeStarting = false  // Reset flag on failure
          const totalMs = Math.round(performance.now() - startTime)
          return c.json({ 
            success: false, 
            error: `prisma generate failed`,
            timings: { steps: timings, totalMs } 
          }, 500)
        }
      }
      
      console.log('[project-runtime] ⏱️  Running prisma db push...')
      const prismaPushProc = Bun.spawn(['bun', '--bun', 'x', 'prisma', 'db', 'push', '--accept-data-loss'], {
        cwd: PROJECT_DIR,
        stdout: 'inherit',
        stderr: 'inherit',
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      })
      await prismaPushProc.exited
      markStep('prismaDbPush')
      
      if (prismaPushProc.exitCode !== 0) {
        devModeStarting = false  // Reset flag on failure
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ 
          success: false, 
          error: `prisma db push failed`,
          timings: { steps: timings, totalMs } 
        }, 500)
      }
    }
    
    // 5. Start dev server (Expo Metro or Vite) with HMR
    const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST
    let serverPort: number
    let serverReady = false
    const maxAttempts = 20
    const baseDelayMs = 200

    if (detectedExpo) {
      // For Expo: run the Hono server directly (it serves dist/ or can proxy to Metro)
      // For now, use production build + Hono server for simpler dev experience
      console.log('[project-runtime] ════════════════════════════════════════')
      console.log(`[project-runtime] 🚀 STARTING EXPO SERVER ON PORT ${EXPO_SERVER_PORT}...`)
      console.log('[project-runtime] ════════════════════════════════════════')

      const serverPath = join(PROJECT_DIR, 'server.ts')
      if (!existsSync(serverPath)) {
        devModeStarting = false  // Reset flag on failure
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ success: false, error: 'Expo server.ts not found', timings: { steps: timings, totalMs } }, 500)
      }

      // First build the Expo web app
      console.log('[project-runtime] Building Expo web app...')
      const buildProc = Bun.spawn(['bunx', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist'], {
        cwd: PROJECT_DIR,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await buildProc.exited

      if (buildProc.exitCode !== 0) {
        devModeStarting = false  // Reset flag on failure
        const totalMs = Math.round(performance.now() - startTime)
        return c.json({ success: false, error: 'Expo build failed', timings: { steps: timings, totalMs } }, 500)
      }
      markStep('expoBuild')

      // Start the Hono server
      appendToConsoleLog(`--- Expo server starting on port ${EXPO_SERVER_PORT} ---`, 'stdout')
      expoServerProcess = Bun.spawn(['bun', 'run', serverPath], {
        cwd: PROJECT_DIR,
        env: { ...process.env, PORT: String(EXPO_SERVER_PORT) },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      streamProcessOutput(expoServerProcess, 'expo')
      serverPort = EXPO_SERVER_PORT

      for (let attempt = 1; attempt <= maxAttempts && !serverReady; attempt++) {
        try {
          const healthCheck = await fetch(`http://localhost:${EXPO_SERVER_PORT}/`, {
            signal: AbortSignal.timeout(500),
          })
          if (healthCheck.ok || healthCheck.status < 500) {
            serverReady = true
            console.log(`[project-runtime] ✅ Expo Hono server ready after ${attempt} attempt(s)`)
          }
        } catch (e) {
          const delay = Math.min(baseDelayMs * attempt, 500)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
      markStep('startExpoServer')
    } else {
      console.log('[project-runtime] ════════════════════════════════════════')
      console.log(`[project-runtime] 🚀 STARTING VITE DEV SERVER ON PORT ${VITE_DEV_PORT}...`)
      console.log('[project-runtime] ════════════════════════════════════════')

      // Start vite dev server - served directly on subdomain for proper HMR
      // In Kubernetes (staging/prod), set SHOGO_RUNTIME to use wss:// on port 443 for HMR
      // Locally, let Vite auto-detect the WebSocket settings
      appendToConsoleLog(`--- Vite dev server starting on port ${VITE_DEV_PORT} ---`, 'stdout')
      viteDevProcess = Bun.spawn(['bun', '--bun', 'vite', 'dev', '--port', String(VITE_DEV_PORT), '--host', '0.0.0.0'], {
        cwd: PROJECT_DIR,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          PORT: String(VITE_DEV_PORT),
          ...(isKubernetes && { SHOGO_RUNTIME: 'true' }),  // Signal to vite config to use production HMR settings
        },
      })
      streamProcessOutput(viteDevProcess, 'vite')
      serverPort = VITE_DEV_PORT

      // Wait for Vite dev server to be ready
      for (let attempt = 1; attempt <= maxAttempts && !serverReady; attempt++) {
        try {
          const healthCheck = await fetch(`http://localhost:${VITE_DEV_PORT}/`, {
            signal: AbortSignal.timeout(500),
          })
          if (healthCheck.ok || healthCheck.status < 500) {
            serverReady = true
            console.log(`[project-runtime] ✅ Vite dev server ready after ${attempt} attempt(s)`)
          }
        } catch (e) {
          const delay = Math.min(baseDelayMs * attempt, 500)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
      markStep('startViteDevServer')
    }

    if (!serverReady) {
      console.warn(`[project-runtime] ⚠️  ${detectedExpo ? 'Expo' : 'Vite'} dev server may still be starting...`)
    }

    // Only update globals after successful start
    // This prevents state inconsistency when dev mode fails to start
    isExpo = detectedExpo
    isDevMode = true
    devModeStarting = false

    const totalMs = Math.round(performance.now() - startTime)
    console.log('[project-runtime] ════════════════════════════════════════')
    console.log(`[project-runtime] 🎉 DEV MODE STARTED: ${totalMs}ms (${(totalMs / 1000).toFixed(2)}s)`)
    console.log('[project-runtime] ════════════════════════════════════════')
    console.log('[project-runtime] ⏱️  Timing breakdown:')
    for (const { step, durationMs } of timings) {
      console.log(`[project-runtime]    • ${step}: ${durationMs}ms`)
    }
    console.log('[project-runtime] ════════════════════════════════════════')
    if (!detectedExpo) {
      console.log('[project-runtime] 🔥 HMR is now active - changes will update instantly!')
    }

    return c.json({
      success: true,
      mode: detectedExpo ? 'expo' : 'dev',
      port: serverPort,
      hmr: !detectedExpo,
      timings: { steps: timings, totalMs },
    })
  } catch (error: any) {
    devModeStarting = false
    const totalMs = Math.round(performance.now() - startTime)
    console.error(`[project-runtime] ⏱️  Dev mode error after ${totalMs}ms:`, error)
    return c.json({ success: false, error: error.message, timings: { steps: timings, totalMs } }, 500)
  }
})

/**
 * Stop dev mode and switch back to production build mode
 * Note: When the vite process is killed, it may log "exited with code 143" (SIGTERM).
 * This is expected behavior during restart/stop and not an error.
 */
app.post('/preview/dev/stop', async (c) => {
  if (viteDevProcess) {
    console.log('[project-runtime] Stopping Vite dev server (SIGTERM exit is expected)...')
    viteDevProcess.kill()
    viteDevProcess = null
    isDevMode = false
    return c.json({ success: true, message: 'Dev mode stopped' })
  }
  if (expoDevProcess) {
    console.log('[project-runtime] Stopping Expo dev server...')
    expoDevProcess.kill()
    expoDevProcess = null
    isDevMode = false
    return c.json({ success: true, message: 'Expo dev mode stopped' })
  }
  if (expoServerProcess) {
    console.log('[project-runtime] Stopping Expo Hono server...')
    expoServerProcess.kill()
    expoServerProcess = null
    isDevMode = false
    return c.json({ success: true, message: 'Expo server stopped' })
  }
  return c.json({ success: true, message: 'Dev mode was not running' })
})

/**
 * Endpoint to receive browser console logs from injected client script.
 * Stores logs in .browser.log for agent access.
 */
app.post('/__console', async (c) => {
  try {
    const body = await c.req.json()
    const { level, message } = body
    if (level && message) {
      appendToBrowserLog(level, message)
    }
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false }, 400)
  }
})

const previewMode = isExpo ? 'Expo (Hono server)' : 'Static files'
console.log(`[project-runtime] Preview mode: ${previewMode}`)

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

  // Rewrite Vite dev server paths (/@vite, /@react-refresh, /@id, /node_modules)
  html = html.replace(/<link([^>]*)\s+href="\/@([^"]+)"([^>]*)>/gi,
    `<link$1 href="${basePath}@$2"$3>`)

  // Rewrite Expo paths (/_expo/static/js/...)
  html = html.replace(/<link([^>]*)\s+href="\/_expo\/([^"]+)"([^>]*)>/gi,
    `<link$1 href="${basePath}_expo/$2"$3>`)

  // Rewrite absolute paths in script tags
  html = html.replace(/<script([^>]*)\s+src="\/assets\/([^"]+)"([^>]*)>/gi,
    `<script$1 src="${basePath}assets/$2"$3>`)
  html = html.replace(/<script([^>]*)\s+src="\/src\/([^"]+)"([^>]*)>/gi,
    `<script$1 src="${basePath}src/$2"$3>`)

  // Rewrite Vite dev server script paths
  html = html.replace(/<script([^>]*)\s+src="\/@([^"]+)"([^>]*)>/gi,
    `<script$1 src="${basePath}@$2"$3>`)

  // Rewrite Expo script paths (/_expo/static/js/...)
  html = html.replace(/<script([^>]*)\s+src="\/_expo\/([^"]+)"([^>]*)>/gi,
    `<script$1 src="${basePath}_expo/$2"$3>`)
  
  // Rewrite inline script imports for Vite dev paths
  html = html.replace(/from\s+["']\/@([^"']+)["']/gi, `from "${basePath}@$1"`)
  html = html.replace(/import\s*\(\s*["']\/@([^"']+)["']\s*\)/gi, `import("${basePath}@$1")`)
  
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
  
  // Helper to check if URL needs rewriting
  function needsRewrite(url) {
    return url.startsWith('/assets/') || url.startsWith('/src/') ||
           url.startsWith('/@') || url.startsWith('/node_modules/') ||
           url.startsWith('/_expo/');
  }
  
  // Store original fetch
  var originalFetch = window.fetch;
  window.fetch = function(url, options) {
    if (typeof url === 'string') {
      // Rewrite absolute paths to use proxy base
      if (needsRewrite(url)) {
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
      if (needsRewrite(url)) {
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
  
  // Inject browser console capture script (before </head> to ensure it runs early)
  if (html.includes('</head>')) {
    html = html.replace('</head>', `${BROWSER_CONSOLE_CAPTURE_SCRIPT}</head>`)
  } else if (html.includes('</body>')) {
    // Fallback: inject before </body> if no </head>
    html = html.replace('</body>', `${BROWSER_CONSOLE_CAPTURE_SCRIPT}</body>`)
  }
  
  return html
}

/**
 * Preview handler - serves static files from dist/.
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
  
  // Expo: proxy to the Expo Hono server (serves both API routes and static files)
  if (isExpo && expoServerProcess) {
    const targetUrl = `http://localhost:${EXPO_SERVER_PORT}${relativePath}`
    console.log(`[project-runtime] Proxying preview to Expo Hono server: ${targetUrl}`)

    try {
      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers: {
          'Host': `localhost:${EXPO_SERVER_PORT}`,
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
      if (contentType.includes('javascript') || contentType.includes('application/javascript')) {
        let js = new TextDecoder().decode(body)
        js = js.replace(/import\(["']\/assets\//g, `import("${externalBasePath}assets/`)
        js = js.replace(/import\(["']\/src\//g, `import("${externalBasePath}src/`)
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
      console.error('[project-runtime] Expo proxy error:', error)
      return c.html(`
        <html>
          <body style="font-family: system-ui; padding: 2rem;">
            <h1>Preview Loading...</h1>
            <p>The Expo server is starting up. Please wait a moment and refresh.</p>
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
 * Check if request is for subdomain preview or published app access.
 * Returns true for:
 * - Preview subdomains (preview--{projectId}.staging.shogo.ai)
 * - Preview token in query string (__preview_token=...)
 * - Published app domains (*.shogo.one)
 */
function isSubdomainPreviewRequest(c: any): boolean {
  const token = c.req.query('__preview_token')
  const host = c.req.header('host') || ''
  const isPreviewSubdomain = host.startsWith('preview--')
  const isPublishedDomain = host.endsWith('.shogo.one')
  return !!(token || isPreviewSubdomain || isPublishedDomain)
}

/**
 * Handle internal /files API requests.
 * This is called from the catch-all for non-subdomain requests.
 */
function handleFilesRequest(c: any): Response | null {
  const path = c.req.path
  
  // GET /files - list all files
  if (path === '/files' && c.req.method === 'GET') {
    try {
      const files: Array<{ path: string; size: number; isDirectory: boolean }> = []
      
      function listRecursive(dir: string, prefix: string = '') {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.output'].includes(entry.name)) continue
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
      return c.json({ error: { code: 'files_error', message: error.message || 'Failed to list files' } }, 500)
    }
  }
  
  // GET /files/* - get specific file content
  if (path.startsWith('/files/') && c.req.method === 'GET') {
    try {
      const filePath = path.replace('/files/', '')
      const absolutePath = isAbsolute(filePath) ? filePath : resolve(PROJECT_DIR, filePath)
      const relativePath = relative(PROJECT_DIR, absolutePath)
      
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        return c.json({ error: { code: 'invalid_path', message: 'Path is outside project directory' } }, 400)
      }
      
      if (!existsSync(absolutePath)) {
        return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)
      }
      
      // Check if path is a directory - cannot read directories as files
      const stats = statSync(absolutePath)
      if (stats.isDirectory()) {
        return c.json({ error: { code: 'is_directory', message: 'Cannot read directory as file' } }, 400)
      }
      
      const content = readFileSync(absolutePath, 'utf-8')
      return c.json({ path: filePath, content })
    } catch (error: any) {
      console.error('[project-runtime] File read error:', error)
      return c.json({ error: { code: 'file_error', message: error.message || 'Failed to read file' } }, 500)
    }
  }
  
  return null // Not a files request
}

/**
 * Subdomain preview catch-all handler.
 * 
 * Handles two types of requests:
 * 1. Subdomain preview requests (with __preview_token or preview-- host)
 * 2. Internal API requests (/files, /terminal/*, etc.) from the API server
 * 
 * IMPORTANT: This catch-all is defined BEFORE specific API routes (/terminal/*, /tests/*, /database/*)
 * because Hono needs to handle subdomain preview at root level. We explicitly skip known API paths
 * here so they can be handled by their specific route handlers defined later in this file.
 */
app.all('/*', async (c, next) => {
  const path = c.req.path
  
  // Handle internal API requests (from API server, not subdomain)
  // These come without __preview_token and without preview-- host
  if (!isSubdomainPreviewRequest(c)) {
    // Check if this is a /files request
    const filesResponse = handleFilesRequest(c)
    if (filesResponse) return filesResponse
    
    // FIXED: Skip known API paths - let them fall through to specific route handlers
    // These routes are defined after this catch-all but need to be handled by their specific handlers
    const apiPaths = [
      '/terminal/',
      '/tests/',
      '/database/',
      '/api/',
      '/lsp',
    ]
    
    if (apiPaths.some(p => path.startsWith(p))) {
      // Call next() to let Hono continue to the specific route handlers
      return next()
    }
    
    // For truly unknown paths, return 404
    return c.notFound()
  }
  
  const token = c.req.query('__preview_token')
  
  // Validate token if present (subdomain access requires valid token)
  if (token) {
    const payload = await validateSubdomainAccess(token)
    if (!payload) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired preview token' } }, 401)
    }
  }
  
  // === Subdomain access: serve app directly at root ===
  let relativePath = c.req.path || '/'
  
  // Normalize path - strip /api/projects/.../preview/ prefix if present
  // This happens when requests are proxied through the API server
  // Without this, Vite dev server receives wrong paths like /api/projects/.../preview/node_modules/...
  const previewPathMatch = relativePath.match(/\/api\/projects\/[^/]+\/preview(.*)/)
  if (previewPathMatch) {
    relativePath = previewPathMatch[1] || '/'
  }
  
  // Pass through internal runtime endpoints to their dedicated route handlers.
  // Without this, subdomain requests to /build-events (SSE), /build-status, etc.
  // would fall through to static file serving and return HTML instead of the SSE stream.
  // This is critical for the preview auto-refresh mechanism (SSE build events).
  const runtimeInternalPaths = [
    '/build-events',
    '/build-status',
    '/preview/restart',
    '/preview/rebuild',
    '/preview/status',
    '/console-log',
  ]
  
  if (runtimeInternalPaths.some(p => relativePath === p || relativePath.startsWith(p + '/'))) {
    console.log(`[project-runtime] Subdomain: passing through internal endpoint ${relativePath}`)
    return next()
  }
  
  // Proxy /api/* requests to the project's backend server.
  // For Expo: handled below via the Expo server proxy.
  // For plain Vite: proxy to the project's Hono server started from server.ts.
  // IMPORTANT: /api/* must NEVER fall through to static file serving (which returns HTML).
  // If the backend is not running, return a proper JSON error.
  if (!isExpo && relativePath.startsWith('/api/')) {
    if (!serverProcess) {
      // Backend is not running — could be crashing or not started yet.
      // Return a proper JSON error instead of falling through to serve HTML from dist/
      console.error(`[project-runtime] Subdomain: /api/ request but backend server is not running (path: ${relativePath})`)
      return c.json({
        error: { 
          code: 'backend_unavailable', 
          message: 'Backend API server is not running. It may be starting up or experiencing errors. Please try again in a few seconds.' 
        }
      }, 503)
    }
    const targetUrl = `http://localhost:${SERVER_PORT}${relativePath}`
    const method = c.req.method
    console.log(`[project-runtime] Subdomain: proxying ${method} ${relativePath} to project API server at ${targetUrl}`)
    
    try {
      // Build headers for the proxy request
      const proxyHeaders: Record<string, string> = {
        'Host': `localhost:${SERVER_PORT}`,
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
      
      // Forward Authorization header
      const authHeader = c.req.header('Authorization')
      if (authHeader) {
        proxyHeaders['Authorization'] = authHeader
      }
      
      // Build fetch options — read body once before any retry loop
      const fetchOptions: RequestInit = {
        method,
        headers: proxyHeaders,
      }
      
      // Forward request body for POST/PUT/PATCH
      let bodyBuffer: ArrayBuffer | null = null
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          bodyBuffer = await c.req.arrayBuffer()
          if (bodyBuffer.byteLength > 0) {
            fetchOptions.body = bodyBuffer
          }
        } catch {
          // No body or couldn't read body - that's ok
        }
      }
      
      // Retry logic: the backend server may have just been auto-started and not listening yet.
      // Retry up to 5 times with 1s delay to give it time to start.
      let response: Response | null = null
      let lastError: Error | null = null
      const MAX_PROXY_RETRIES = 5
      for (let attempt = 1; attempt <= MAX_PROXY_RETRIES; attempt++) {
        try {
          // Re-attach body for retries (ArrayBuffer can only be consumed once)
          const retryOptions = { ...fetchOptions }
          if (bodyBuffer && bodyBuffer.byteLength > 0) {
            retryOptions.body = bodyBuffer.slice(0) // clone for retry
          }
          response = await fetch(targetUrl, retryOptions)
          break // Success
        } catch (err: any) {
          lastError = err
          if (attempt < MAX_PROXY_RETRIES && (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED') || err.message?.includes('Failed to connect'))) {
            console.log(`[project-runtime] API proxy attempt ${attempt}/${MAX_PROXY_RETRIES} failed (server starting?), retrying in 1s...`)
            await new Promise(resolve => setTimeout(resolve, 1000))
          } else {
            throw err
          }
        }
      }
      
      if (!response) {
        throw lastError || new Error('API proxy failed after retries')
      }
      
      const responseContentType = response.headers.get('Content-Type') || 'application/json'
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
      
      return new Response(body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[project-runtime] Subdomain API proxy error:', error)
      return c.json({
        error: { code: 'api_proxy_error', message: `Failed to proxy to project API server: ${error.message}` }
      }, 502)
    }
  }
  
  // Check if dev mode has failed too many times (circuit breaker)
  const isInBackoff = devModeFailureCount >= DEV_MODE_MAX_FAILURES && 
    devModeLastFailure && (Date.now() - devModeLastFailure < DEV_MODE_BACKOFF_MS)
  
  // Show error page if dev mode has repeatedly failed
  if (devModeError && isInBackoff) {
    const retryInSeconds = Math.ceil((DEV_MODE_BACKOFF_MS - (Date.now() - (devModeLastFailure || 0))) / 1000)
    return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dev Server Error</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    .container { text-align: center; padding: 2rem; max-width: 500px; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { opacity: 0.9; font-size: 0.95rem; margin-bottom: 1rem; }
    .error-box { 
      background: rgba(0,0,0,0.2); 
      padding: 1rem; 
      border-radius: 8px; 
      font-family: monospace; 
      font-size: 0.85rem; 
      text-align: left;
      margin-bottom: 1rem;
      word-break: break-word;
    }
    .retry-info { opacity: 0.8; font-size: 0.85rem; }
    .btn {
      display: inline-block;
      margin-top: 1rem;
      padding: 0.75rem 1.5rem;
      background: rgba(255,255,255,0.2);
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 0.9rem;
      cursor: pointer;
      text-decoration: none;
    }
    .btn:hover { background: rgba(255,255,255,0.3); }
  </style>
  <script>
    let retrySeconds = ${retryInSeconds};
    const updateTimer = () => {
      const el = document.getElementById('timer');
      if (el) el.textContent = retrySeconds + 's';
      if (retrySeconds <= 0) location.reload();
      retrySeconds--;
    };
    setInterval(updateTimer, 1000);
    updateTimer();
  </script>
</head>
<body>
  <div class="container">
    <div class="icon">⚠️</div>
    <h1>Dev Server Failed to Start</h1>
    <p>The development server encountered an error after multiple attempts.</p>
    <div class="error-box">${devModeError}</div>
    <p class="retry-info">Auto-retry in <span id="timer">${retryInSeconds}s</span></p>
    <a href="/" class="btn" onclick="location.reload(); return false;">Retry Now</a>
  </div>
</body>
</html>
    `, 503)
  }
  
  // Reset circuit breaker if backoff period has passed
  if (!isInBackoff && devModeFailureCount >= DEV_MODE_MAX_FAILURES) {
    console.log('[project-runtime] Circuit breaker reset - backoff period passed')
    devModeFailureCount = 0
    devModeError = null
  }
  
  // Check if dist/ exists (build mode for plain Vite)
  const DIST_DIR = join(PROJECT_DIR, 'dist')
  const distExists = existsSync(DIST_DIR)
  
  // Auto-start build mode if nothing is running AND dist/ doesn't exist yet
  // Use build+restart approach instead of dev mode for reliability and simplicity
  // This avoids HMR complexity and provides consistent preview updates
  // For plain Vite: only auto-start if dist/ doesn't exist (prevents redundant builds)
  // For Expo: always auto-start if process isn't running
  const needsAutoStart = !serverProcess && !expoServerProcess && !devModeStarting && !isInBackoff && !distExists
  
  // Also check: dist/ exists but the backend server isn't running and a server.tsx exists.
  // This happens on cold starts from S3 restore (bg-init builds dist/ but doesn't start the backend).
  // For published domains (*.shogo.one), we need the backend server for /api/* routes.
  const serverTsxExists = existsSync(join(PROJECT_DIR, 'server.tsx')) || existsSync(join(PROJECT_DIR, 'server.ts'))
  const needsBackendStart = !serverProcess && !isExpo && !devModeStarting && !isInBackoff && distExists && serverTsxExists
  
  if (needsAutoStart) {
    console.log('[project-runtime] Auto-starting build mode on first subdomain request...')
    devModeStarting = true
    
    // Start build mode in background (don't await - we'll show loading page)
    fetch(`http://localhost:${PORT}/preview/restart`, { method: 'POST' })
      .then(async (res) => {
        if (res.ok) {
          console.log('[project-runtime] Build mode auto-started successfully')
          // Reset failure tracking on success
          devModeFailureCount = 0
          devModeError = null
        } else {
          const errorText = await res.text()
          console.error('[project-runtime] Build mode auto-start failed:', errorText)
          devModeFailureCount++
          devModeLastFailure = Date.now()
          try {
            const errorJson = JSON.parse(errorText)
            devModeError = errorJson.error || 'Unknown error'
          } catch {
            devModeError = errorText.substring(0, 200)
          }
        }
        devModeStarting = false
      })
      .catch((err) => {
        console.error('[project-runtime] Build mode auto-start error:', err)
        devModeFailureCount++
        devModeLastFailure = Date.now()
        devModeError = err.message || 'Connection error'
        devModeStarting = false
      })
  } else if (needsBackendStart) {
    // dist/ exists (from S3 restore / bg-init build) but backend server isn't running.
    // Start ONLY the backend server (no rebuild needed) so /api/* routes work.
    console.log('[project-runtime] 🔄 Auto-starting backend API server (dist/ exists, server not running)...')
    const serverTsxPath = join(PROJECT_DIR, 'server.tsx')
    const serverTsPath = join(PROJECT_DIR, 'server.ts')
    const serverPath = existsSync(serverTsxPath) ? serverTsxPath : serverTsPath
    
    serverProcess = Bun.spawn(['bun', 'run', serverPath], {
      cwd: PROJECT_DIR,
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    streamProcessOutput(serverProcess, 'api-server')
    console.log(`[project-runtime] Backend API server started (PID: ${serverProcess.pid}, port: ${SERVER_PORT})`)
    
    // Monitor for crashes — reset serverProcess to null so next request can retry
    const proc = serverProcess
    proc.exited.then((exitCode) => {
      if (serverProcess === proc) {
        console.error(`[project-runtime] ⚠️ Backend API server exited with code ${exitCode}`)
        serverProcess = null
      }
    })
  }
  
  // Show loading page while build is starting
  // For plain Vite: only show loading if dist/ doesn't exist yet
  // For Expo: show loading if respective process isn't running
  const needsProcess = existsSync(join(PROJECT_DIR, 'app.json')) // Expo
  
  if (devModeStarting || (!distExists && !serverProcess && !expoServerProcess && !isInBackoff)) {
    return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Building Preview...</title>
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
    .attempt { margin-top: 0.5rem; opacity: 0.7; font-size: 0.75rem; }
  </style>
  <script>
    let attempts = 0;
    const maxAttempts = 60; // 60 seconds max
    setInterval(async () => {
      attempts++;
      try {
        const res = await fetch('/build-status');
        const data = await res.json();
        document.querySelector('.status').textContent = data.message || 'Building...';
        if (data.ready) location.reload();
        if (data.error) location.reload(); // Reload to show error page
      } catch {}
      document.querySelector('.attempt').textContent = 'Attempt ' + attempts + '/' + maxAttempts;
      if (attempts >= maxAttempts) location.reload(); // Force reload to check for error state
    }, 1000);
  </script>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h1>Building Your Preview</h1>
    <p>Compiling your project... This takes 5-10 seconds.</p>
    <div class="status">Initializing...</div>
    <div class="attempt">Starting...</div>
  </div>
</body>
</html>
    `, 200)
  }
  
  // In fast start mode, show loading page if build not ready (for production mode fallback)
  if (FAST_START_MODE && !isDevMode) {
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
  
  // Expo: proxy to the Expo Hono server (serves both API routes and static files)
  if (isExpo && expoServerProcess) {
    const targetUrl = `http://localhost:${EXPO_SERVER_PORT}${relativePath}`
    const method = c.req.method
    console.log(`[project-runtime] Subdomain: proxying ${method} to Expo Hono server at ${targetUrl}`)

    try {
      // Build headers for the proxy request
      const proxyHeaders: Record<string, string> = {
        'Host': `localhost:${EXPO_SERVER_PORT}`,
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
      console.error('[project-runtime] Subdomain Expo proxy error:', error)
      return c.html(`
        <html>
          <body style="font-family: system-ui; padding: 2rem;">
            <h1>Preview Loading...</h1>
            <p>The Expo server is starting up. Please wait a moment and refresh.</p>
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
    const files: Array<{ path: string; name: string; type: 'file' | 'directory'; extension?: string; size?: number }> = []
    
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
          files.push({ 
            path: relativePath, 
            name: entry.name,
            type: 'directory'
          })
          listRecursive(fullPath, relativePath)
        } else {
          const stats = statSync(fullPath)
          const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : undefined
          files.push({ 
            path: relativePath, 
            name: entry.name,
            type: 'file',
            extension: ext,
            size: stats.size 
          })
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
  'prisma-generate': { command: 'bun --bun x prisma generate', timeout: 60000 },
  'prisma-push': { command: 'bun --bun x prisma db push', timeout: 60000 },
  'prisma-reset': { command: 'bun --bun x prisma db push --force-reset', timeout: 30000 },
  'prisma-migrate': { command: 'bun --bun x prisma migrate dev --name auto', timeout: 60000 },
  'playwright-test': { command: 'bun --bun x playwright test', timeout: 180000 },
  'typecheck': { command: 'bun --bun x tsc --noEmit', timeout: 60000 },
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

    // For Playwright tests, ensure dependencies are installed (workspaces from template may have no node_modules)
    if (commandId === 'playwright-test') {
      const nodeModulesDir = join(PROJECT_DIR, 'node_modules')
      if (!existsSync(nodeModulesDir)) {
        console.log(`[project-runtime] Running bun install before playwright (node_modules missing)`)
        const installResult = Bun.spawnSync(['bun', 'install'], {
          cwd: PROJECT_DIR,
          env: { ...process.env, CI: 'true' },
          stdout: 'inherit',
          stderr: 'inherit',
        })
        if (installResult.exitCode !== 0) {
          return c.json(
            { error: { code: 'install_failed', message: 'bun install failed. Run "bun install" in the project and try again.' } },
            500
          )
        }
      }
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
 * - testName?: string - Test name pattern (grep), ignored when line is set
 * - line?: number - Run only the test at this line (file:line); takes precedence over testName
 * - headed?: boolean - Run in headed mode
 * - reporter?: 'list' | 'json' | 'line' - Reporter to use
 */
app.post('/tests/run', async (c) => {
  console.log(`[project-runtime] Running tests for project ${PROJECT_ID}`)
  
  // Parse request body
  let body: { 
    file?: string
    testName?: string
    line?: number
    headed?: boolean
    reporter?: 'list' | 'json' | 'line'
  } = {}
  
  try {
    body = await c.req.json()
  } catch {
    // Empty body is fine, use defaults
  }

  const { file, testName, line, headed, reporter = 'list' } = body

  // Build command
  let command = 'bunx playwright test'
  
  // Add specific file (or file:line to run a single test)
  if (file) {
    if (line != null && line > 0) {
      command += ` "${file}:${line}"`
    } else {
      command += ` "${file}"`
    }
  }
  
  // Add test name filter (grep) only when not targeting by line
  if (testName && (line == null || line <= 0)) {
    command += ` --grep "${testName.replace(/"/g, '\\"')}"`
  }
  
  // Add headed mode
  if (headed) {
    command += ' --headed'
  }
  
  // Add reporter
  command += ` --reporter=${reporter}`

  // Ensure dependencies are installed (workspaces created from template may have no node_modules)
  const nodeModulesDir = join(PROJECT_DIR, 'node_modules')
  if (!existsSync(nodeModulesDir)) {
    console.log(`[project-runtime] Running bun install before tests (node_modules missing)`)
    const installResult = Bun.spawnSync(['bun', 'install'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, CI: 'true' },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (installResult.exitCode !== 0) {
      return c.json(
        { error: { code: 'install_failed', message: 'bun install failed. Run "bun install" in the project and try again.' } },
        500
      )
    }
  }

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

      // Append any test-result attachments (screenshots, traces, videos)
      // Playwright only prints these for failures; we surface them for all runs
      const resultsDir = join(PROJECT_DIR, 'test-results')
      if (existsSync(resultsDir)) {
        const attachments: string[] = []
        function walkResults(dir: string) {
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, entry.name)
              if (entry.isDirectory()) walkResults(full)
              else if (entry.name.endsWith('.png') || entry.name === 'trace.zip' || entry.name.endsWith('.webm')) {
                attachments.push(full.replace(PROJECT_DIR + '/', ''))
              }
            }
          } catch { /* ignore */ }
        }
        walkResults(resultsDir)
        if (attachments.length > 0) {
          await writer.write(encoder.encode('\n--- Test Artifacts ---\n'))
          for (const a of attachments) {
            await writer.write(encoder.encode(`${a}\n`))
          }
        }
      }

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
    prismaStudioProcess = Bun.spawn(['bun', '--bun', 'x', 'prisma', 'studio', '--port', String(PRISMA_STUDIO_PORT), '--browser', 'none'], {
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
 * IMPORTANT: The <base> tag only works with RELATIVE URLs (e.g., "ui/index.js").
 * Absolute paths like "/ui/index.js" ignore the base tag and resolve from domain root.
 * We must convert absolute paths to relative paths so the base tag works.
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
  
  // CRITICAL: Convert absolute paths to relative paths in script/link/img tags
  // The <base> tag only affects relative URLs - absolute paths like "/ui/index.js"
  // bypass the base tag entirely and resolve from domain root (causing 404s).
  // By removing the leading "/", we make them relative so the base tag works.
  
  // Convert src="/..." to src="..." (for script, img tags)
  // Handle both cases: <script src="/..." and <script async src="/...
  html = html.replace(/\ssrc="\/(?!\/)/gi, ' src="')
  html = html.replace(/\ssrc='\/(?!\/)/gi, " src='")
  
  // Convert href="/..." to href="..." (for link tags, excluding http/https and //)
  // Negative lookahead (?!\/) ensures we don't touch href="//" (protocol-relative URLs)
  html = html.replace(/\shref="\/(?!\/)/gi, ' href="')
  html = html.replace(/\shref='\/(?!\/)/gi, " href='")
  
  // Fix any absolute /api/ paths that bypass the base tag (in inline scripts)
  // Prisma Studio's JS sometimes constructs URLs like: location.origin + '/api/'
  // We inject a script to patch fetch/XMLHttpRequest to rewrite /api/ calls
  const patchScript = `
<script>
(function() {
  var proxyBase = ${JSON.stringify(basePath)};
  
  // Helper to extract URL string from various input types (string, URL, Request)
  function extractUrlString(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    if (input instanceof Request) return input.url;
    return null;
  }
  
  // Helper to rewrite URL for proxy
  function rewriteUrl(url) {
    if (typeof url !== 'string') return url;
    
    // Handle full URLs (http://... or https://...)
    if (url.indexOf('://') !== -1) {
      try {
        var urlObj = new URL(url);
        // Check if same domain or localhost - rewrite to use proxy
        if (urlObj.hostname === window.location.hostname || urlObj.hostname === 'localhost') {
          var path = urlObj.pathname;
          
          // CRITICAL FIX: Check if pathname already contains the proxy base
          // If it does, don't prepend it again (prevents double-prefixing)
          if (path.startsWith(proxyBase)) {
            // Path already has proxy base, use as-is
            url = path + urlObj.search;
          } else {
            // Strip the origin and treat as relative path through proxy
            if (path.startsWith('/')) path = path.substring(1);
            url = proxyBase + path + urlObj.search;
          }
        }
      } catch(e) {
        // Invalid URL, leave as-is
      }
    }
    // Handle protocol-relative URLs (//...) - leave unchanged
    else if (url.startsWith('//')) {
      return url;
    }
    // Handle /api/ calls - but check if already proxied
    else if ((url.startsWith('/api/') || url.startsWith('/api')) && !url.startsWith(proxyBase)) {
      url = proxyBase + url.substring(1);
    }
    // Handle other absolute paths at root - but check if already proxied
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
  window.fetch = function(input, init) {
    // fix-prisma-proxy: Handle Request, URL, and string inputs
    // Modern frameworks (including Prisma Studio) may pass Request or URL objects
    // instead of plain strings, which previously bypassed URL rewriting entirely.
    if (input instanceof Request) {
      var rewrittenUrl = rewriteUrl(input.url);
      if (rewrittenUrl !== input.url) {
        // Create a new Request with rewritten URL, preserving all other properties
        input = new Request(rewrittenUrl, input);
      }
      return originalFetch.call(this, input, init);
    }
    if (input instanceof URL) {
      var urlStr = rewriteUrl(input.toString());
      return originalFetch.call(this, urlStr, init);
    }
    var rewritten = rewriteUrl(input);
    return originalFetch.call(this, rewritten, init);
  };
  
  // Store original XMLHttpRequest.open
  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var args = Array.prototype.slice.call(arguments, 2);
    // fix-prisma-proxy: Handle URL objects in XHR too
    var urlStr = extractUrlString(url);
    if (urlStr !== null) {
      url = rewriteUrl(urlStr);
    }
    return originalOpen.apply(this, [method, url].concat(args));
  };
  
  // fix-prisma-proxy: Prevent Prisma Studio SPA router from changing location
  // If Prisma Studio pushes history state, it changes location.pathname which
  // breaks subsequent relative URL resolution. Lock the pathname to the proxy base.
  var originalPushState = history.pushState;
  var originalReplaceState = history.replaceState;
  history.pushState = function(state, title, url) {
    // Only allow if URL stays within proxy base path, otherwise no-op
    if (url) {
      var urlStr = typeof url === 'string' ? url : url.toString();
      if (!urlStr.startsWith(proxyBase) && urlStr.startsWith('/')) {
        // Redirect to proxy-prefixed path
        url = proxyBase + urlStr.substring(1);
      }
    }
    return originalPushState.call(this, state, title, url);
  };
  history.replaceState = function(state, title, url) {
    if (url) {
      var urlStr = typeof url === 'string' ? url : url.toString();
      if (!urlStr.startsWith(proxyBase) && urlStr.startsWith('/')) {
        url = proxyBase + urlStr.substring(1);
      }
    }
    return originalReplaceState.call(this, state, title, url);
  };
  
  // Patch dynamically created script/link elements
  // Some frameworks create these via createElement and set src/href
  var originalCreateElement = document.createElement.bind(document);
  document.createElement = function(tagName, options) {
    var element = originalCreateElement(tagName, options);
    var tag = tagName.toLowerCase();
    
    if (tag === 'script' || tag === 'img') {
      // Intercept src setter
      var descriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src') ||
                       Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (descriptor && descriptor.set) {
        var originalSetter = descriptor.set;
        Object.defineProperty(element, 'src', {
          set: function(value) {
            return originalSetter.call(this, rewriteUrl(value));
          },
          get: descriptor.get
        });
      }
    } else if (tag === 'link') {
      // Intercept href setter for link elements
      var linkDescriptor = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
      if (linkDescriptor && linkDescriptor.set) {
        var originalLinkSetter = linkDescriptor.set;
        Object.defineProperty(element, 'href', {
          set: function(value) {
            return originalLinkSetter.call(this, rewriteUrl(value));
          },
          get: linkDescriptor.get
        });
      }
    }
    
    return element;
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
  
  // Stop build watch process
  stopViteBuildWatch()

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

// Track HMR WebSocket connections for proxying to vite dev server
const hmrConnections = new Map<ServerWebSocket<unknown>, WebSocket>()

// WebSocket handlers for LSP and HMR
const websocketHandlers = {
  async open(ws: ServerWebSocket<unknown>) {
    const data = (ws as any).data as { type?: string; path?: string } | undefined
    
    // Handle HMR WebSocket connections
    if (data?.type === 'hmr' && isDevMode && viteDevProcess) {
      // Build the WebSocket URL for Vite dev server
      // Use normalized path and preserve query params
      const wsPath = data.path || '/'
      const wsSearch = (data as any).search || ''
      const viteWsUrl = `ws://localhost:${VITE_DEV_PORT}${wsPath}${wsSearch}`
      
      console.log(`[HMR WebSocket] Client connected, proxying to vite dev server at ${viteWsUrl}`)
      try {
        // Create connection to vite dev server
        const viteWs = new WebSocket(viteWsUrl)
        
        viteWs.onopen = () => {
          console.log('[HMR WebSocket] Connected to vite dev server')
        }
        
        viteWs.onmessage = (event) => {
          // Forward messages from vite to client
          if (ws.readyState === 1) {
            ws.send(typeof event.data === 'string' ? event.data : JSON.stringify(event.data))
          }
        }
        
        viteWs.onerror = (error) => {
          console.error('[HMR WebSocket] Vite connection error:', error)
        }
        
        viteWs.onclose = () => {
          console.log('[HMR WebSocket] Vite connection closed')
          hmrConnections.delete(ws)
          ws.close()
        }
        
        hmrConnections.set(ws, viteWs)
        return
      } catch (error) {
        console.error('[HMR WebSocket] Failed to connect to vite dev server:', error)
        ws.close(1011, 'Failed to connect to vite dev server')
        return
      }
    }
    
    // Handle LSP WebSocket connections
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
    // Handle HMR messages
    const viteWs = hmrConnections.get(ws)
    if (viteWs) {
      // Forward message to vite dev server
      if (viteWs.readyState === WebSocket.OPEN) {
        viteWs.send(typeof message === 'string' ? message : message.toString())
      }
      return
    }
    
    // Handle LSP messages
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
    // Handle HMR close
    const viteWs = hmrConnections.get(ws)
    if (viteWs) {
      console.log('[HMR WebSocket] Client disconnected:', code, reason)
      viteWs.close()
      hmrConnections.delete(ws)
      return
    }
    
    // Handle LSP close
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
  const isWebSocketUpgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  
  // Handle WebSocket upgrade for /lsp endpoint
  if (url.pathname === '/lsp' && isWebSocketUpgrade) {
    const success = server.upgrade(request)
    if (success) {
      // Return undefined to signal Bun that the upgrade was handled
      return undefined
    }
    return new Response('WebSocket upgrade failed', { status: 500 })
  }
  
  // Handle WebSocket upgrade for HMR when in dev mode
  // Vite HMR WebSocket connects to root or /@vite paths
  if (isDevMode && viteDevProcess && isWebSocketUpgrade) {
    // Normalize the path - strip any /api/projects/.../preview/ prefix
    // The browser might be connecting through a proxy path, but Vite expects root
    let wsPath = url.pathname
    const previewPathMatch = wsPath.match(/\/api\/projects\/[^/]+\/preview(.*)/)
    if (previewPathMatch) {
      wsPath = previewPathMatch[1] || '/'
    }
    // Also handle direct subdomain paths
    if (wsPath === '' || wsPath === '/?') {
      wsPath = '/'
    }
    
    console.log(`[project-runtime] HMR WebSocket upgrade requested: ${url.pathname} -> normalized: ${wsPath}`)
    const success = server.upgrade(request, { 
      data: { 
        type: 'hmr', 
        path: wsPath,
        search: url.search  // Preserve query params
      } 
    })
    if (success) {
      return undefined
    }
    return new Response('HMR WebSocket upgrade failed', { status: 500 })
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
