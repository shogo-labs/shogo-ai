/**
 * Terminal API Routes
 *
 * Endpoints for executing preset shell commands on project workspaces.
 * Only allows a predefined set of safe commands to prevent arbitrary execution.
 *
 * Endpoints:
 * - POST /projects/:projectId/terminal/exec - Execute a preset command
 * - GET /projects/:projectId/terminal/commands - List available commands
 */

import { Hono } from "hono"
import { spawn } from "child_process"
import { existsSync } from "fs"
import { join } from "path"

/**
 * Preset command definition
 */
export interface PresetCommand {
  /** Unique identifier for the command */
  id: string
  /** Display label */
  label: string
  /** Description of what the command does */
  description: string
  /** The actual shell command to execute */
  command: string
  /** Category for grouping in UI */
  category: 'package' | 'database' | 'server' | 'test' | 'build'
  /** Whether this command is potentially destructive */
  dangerous?: boolean
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number
}

/**
 * Available preset commands that users can execute
 */
export const PRESET_COMMANDS: PresetCommand[] = [
  // Package Management
  {
    id: 'bun-install',
    label: 'Install Dependencies',
    description: 'Install all project dependencies with bun',
    command: 'bun install',
    category: 'package',
    timeout: 120000, // 2 minutes
  },
  
  // Database (Prisma)
  {
    id: 'prisma-generate',
    label: 'Generate Prisma Client',
    description: 'Regenerate Prisma client after schema changes',
    command: 'bunx prisma generate',
    category: 'database',
  },
  {
    id: 'prisma-push',
    label: 'Push Schema',
    description: 'Push schema changes to the database',
    command: 'bunx prisma db push',
    category: 'database',
  },
  {
    id: 'prisma-reset',
    label: 'Reset Database',
    description: 'Wipe and recreate database from schema (destructive)',
    command: 'bunx prisma db push --force-reset',
    category: 'database',
    dangerous: true,
    timeout: 30000,
  },
  {
    id: 'prisma-migrate',
    label: 'Run Migrations',
    description: 'Create and apply database migrations',
    command: 'bunx prisma migrate dev --name auto',
    category: 'database',
    timeout: 60000,
  },
  
  // Testing
  {
    id: 'playwright-test',
    label: 'Run Tests',
    description: 'Run Playwright E2E tests',
    command: 'bunx playwright test',
    category: 'test',
    timeout: 180000, // 3 minutes
  },
  {
    id: 'playwright-test-headed',
    label: 'Run Tests (Visible)',
    description: 'Run tests with browser visible',
    command: 'bunx playwright test --headed',
    category: 'test',
    timeout: 180000,
  },
  
  // Build
  {
    id: 'typecheck',
    label: 'Type Check',
    description: 'Run TypeScript type checking',
    command: 'bunx tsc --noEmit',
    category: 'build',
    timeout: 60000,
  },
  {
    id: 'build',
    label: 'Build for Production',
    description: 'Create production build',
    command: 'bun run build',
    category: 'build',
    timeout: 120000,
  },
]

/**
 * Configuration for terminal routes
 */
export interface TerminalRoutesConfig {
  /**
   * Workspaces directory where projects are stored
   */
  workspacesDir: string
}

/**
 * Create terminal routes
 */
export function terminalRoutes(config: TerminalRoutesConfig) {
  const { workspacesDir } = config
  const router = new Hono()

  /**
   * GET /projects/:projectId/terminal/commands - List available commands
   */
  router.get("/projects/:projectId/terminal/commands", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    // If project directory doesn't exist yet, still return available commands
    // (the commands are generic, not project-specific)

    // Return available commands grouped by category
    const commandsByCategory = PRESET_COMMANDS.reduce((acc, cmd) => {
      if (!acc[cmd.category]) {
        acc[cmd.category] = []
      }
      acc[cmd.category].push({
        id: cmd.id,
        label: cmd.label,
        description: cmd.description,
        category: cmd.category,
        dangerous: cmd.dangerous || false,
      })
      return acc
    }, {} as Record<string, Array<{ id: string; label: string; description: string; category: string; dangerous: boolean }>>)

    return c.json({ commands: commandsByCategory }, 200)
  })

  /**
   * POST /projects/:projectId/terminal/exec - Execute a preset command
   *
   * Request body:
   * - commandId: string - ID of the preset command to execute
   * - confirmDangerous?: boolean - Must be true for dangerous commands
   *
   * Response: Streaming text output of the command
   */
  router.post("/projects/:projectId/terminal/exec", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    // Verify project exists
    if (!existsSync(projectDir)) {
      return c.json(
        { error: { code: "project_not_found", message: "Project not found" } },
        404
      )
    }

    // Parse request body
    let body: { commandId: string; confirmDangerous?: boolean }
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { error: { code: "invalid_body", message: "Invalid request body" } },
        400
      )
    }

    const { commandId, confirmDangerous } = body

    // Find the preset command
    const preset = PRESET_COMMANDS.find(cmd => cmd.id === commandId)
    if (!preset) {
      return c.json(
        { error: { code: "unknown_command", message: `Unknown command: ${commandId}` } },
        400
      )
    }

    // Require confirmation for dangerous commands
    if (preset.dangerous && !confirmDangerous) {
      return c.json(
        { 
          error: { 
            code: "confirmation_required", 
            message: "This command is destructive. Set confirmDangerous: true to proceed." 
          } 
        },
        400
      )
    }

    const timeout = preset.timeout || 60000

    console.log(`[Terminal] Executing command: ${preset.command} in ${projectDir}`)

    // Create a streaming response
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    // Execute command asynchronously
    ;(async () => {
      try {
        // Write header
        await writer.write(encoder.encode(`$ ${preset.command}\n\n`))

        // Spawn the command
        const child = spawn('sh', ['-c', preset.command], {
          cwd: projectDir,
          env: {
            ...process.env,
            // Ensure colors are enabled
            FORCE_COLOR: '1',
            // Prisma needs this to not prompt
            CI: 'true',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        // Set up timeout
        const timeoutId = setTimeout(() => {
          child.kill('SIGTERM')
          writer.write(encoder.encode('\n\n[ERROR] Command timed out\n'))
        }, timeout)

        // Stream stdout
        child.stdout?.on('data', async (data: Buffer) => {
          try {
            await writer.write(data)
          } catch {
            // Writer closed, ignore
          }
        })

        // Stream stderr
        child.stderr?.on('data', async (data: Buffer) => {
          try {
            await writer.write(data)
          } catch {
            // Writer closed, ignore
          }
        })

        // Handle completion
        child.on('close', async (code) => {
          clearTimeout(timeoutId)
          try {
            await writer.write(encoder.encode(`\n\n[Process exited with code ${code}]\n`))
            await writer.close()
          } catch {
            // Writer already closed, ignore
          }
        })

        // Handle errors
        child.on('error', async (err) => {
          clearTimeout(timeoutId)
          try {
            await writer.write(encoder.encode(`\n\n[ERROR] ${err.message}\n`))
            await writer.close()
          } catch {
            // Writer already closed, ignore
          }
        })

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

  return router
}

export default terminalRoutes
