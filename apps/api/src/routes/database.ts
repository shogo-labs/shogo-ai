/**
 * Database API Routes
 *
 * Endpoints for managing Prisma Studio instances for project workspaces.
 * Each project can have one Prisma Studio instance running.
 *
 * Endpoints:
 * - POST /projects/:projectId/database/start - Start Prisma Studio
 * - POST /projects/:projectId/database/stop - Stop Prisma Studio
 * - GET /projects/:projectId/database/status - Get Prisma Studio status
 * - GET /projects/:projectId/database/url - Get Prisma Studio URL (starts if needed)
 */

import { Hono } from "hono"
import { spawn, type ChildProcess } from "child_process"
import { existsSync } from "fs"
import { join } from "path"

/**
 * Prisma Studio instance info
 */
interface PrismaStudioInstance {
  projectId: string
  port: number
  process: ChildProcess
  url: string
  startedAt: number
  status: 'starting' | 'running' | 'stopped' | 'error'
}

/**
 * In-memory store for running Prisma Studio instances
 */
const studioInstances = new Map<string, PrismaStudioInstance>()

/**
 * Base port for Prisma Studio instances (each project gets a unique port)
 */
const BASE_STUDIO_PORT = 5555

/**
 * Get next available port for Prisma Studio
 */
function getNextPort(): number {
  const usedPorts = new Set(Array.from(studioInstances.values()).map(i => i.port))
  let port = BASE_STUDIO_PORT
  while (usedPorts.has(port)) {
    port++
  }
  return port
}

/**
 * Configuration for database routes
 */
export interface DatabaseRoutesConfig {
  /**
   * Workspaces directory where projects are stored
   */
  workspacesDir: string
}

/**
 * Create database routes
 */
export function databaseRoutes(config: DatabaseRoutesConfig) {
  const { workspacesDir } = config
  const router = new Hono()

  /**
   * POST /projects/:projectId/database/start - Start Prisma Studio
   */
  router.post("/projects/:projectId/database/start", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    // Verify project exists
    if (!existsSync(projectDir)) {
      return c.json(
        { error: { code: "project_not_found", message: "Project not found" } },
        404
      )
    }

    // Check if Prisma schema exists
    const prismaSchemaPath = join(projectDir, "prisma", "schema.prisma")
    if (!existsSync(prismaSchemaPath)) {
      return c.json(
        { error: { code: "no_prisma_schema", message: "No Prisma schema found in project" } },
        400
      )
    }

    // Check if already running
    const existing = studioInstances.get(projectId)
    if (existing && existing.status === 'running') {
      return c.json({
        url: existing.url,
        port: existing.port,
        status: existing.status,
        startedAt: existing.startedAt,
      }, 200)
    }

    // Get a port for this instance
    const port = getNextPort()
    const url = `http://localhost:${port}`

    console.log(`[Database] Starting Prisma Studio for ${projectId} on port ${port}`)

    // Start Prisma Studio
    const child = spawn('bunx', ['prisma', 'studio', '--port', port.toString(), '--browser', 'none'], {
      cwd: projectDir,
      env: {
        ...process.env,
        // Ensure it doesn't try to open a browser
        BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    const instance: PrismaStudioInstance = {
      projectId,
      port,
      process: child,
      url,
      startedAt: Date.now(),
      status: 'starting',
    }

    studioInstances.set(projectId, instance)

    // Listen for stdout to detect when it's ready
    let outputBuffer = ''
    child.stdout?.on('data', (data: Buffer) => {
      outputBuffer += data.toString()
      // Prisma Studio prints "Started on http://localhost:PORT" when ready
      if (outputBuffer.includes('Started on') || outputBuffer.includes('listening')) {
        instance.status = 'running'
        console.log(`[Database] Prisma Studio running for ${projectId} at ${url}`)
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      // Prisma Studio also logs to stderr sometimes
      if (text.includes('Started on') || text.includes('listening')) {
        instance.status = 'running'
      }
      console.error(`[Database] Prisma Studio stderr (${projectId}):`, text)
    })

    child.on('close', (code) => {
      console.log(`[Database] Prisma Studio for ${projectId} exited with code ${code}`)
      instance.status = 'stopped'
      studioInstances.delete(projectId)
    })

    child.on('error', (err) => {
      console.error(`[Database] Prisma Studio error for ${projectId}:`, err)
      instance.status = 'error'
    })

    // Wait a moment for it to start
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Update status based on whether process is still alive
    if (child.exitCode === null) {
      instance.status = 'running'
    }

    return c.json({
      url: instance.url,
      port: instance.port,
      status: instance.status,
      startedAt: instance.startedAt,
    }, 200)
  })

  /**
   * POST /projects/:projectId/database/stop - Stop Prisma Studio
   */
  router.post("/projects/:projectId/database/stop", async (c) => {
    const projectId = c.req.param("projectId")

    const instance = studioInstances.get(projectId)
    if (!instance) {
      return c.json(
        { error: { code: "not_running", message: "Prisma Studio is not running" } },
        404
      )
    }

    console.log(`[Database] Stopping Prisma Studio for ${projectId}`)

    // Kill the process
    try {
      instance.process.kill('SIGTERM')
    } catch (err) {
      console.error(`[Database] Error killing Prisma Studio:`, err)
    }

    studioInstances.delete(projectId)

    return c.json({ success: true }, 200)
  })

  /**
   * GET /projects/:projectId/database/status - Get Prisma Studio status
   */
  router.get("/projects/:projectId/database/status", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    // Verify project exists
    if (!existsSync(projectDir)) {
      return c.json(
        { error: { code: "project_not_found", message: "Project not found" } },
        404
      )
    }

    // Check if Prisma schema exists
    const prismaSchemaPath = join(projectDir, "prisma", "schema.prisma")
    const hasPrisma = existsSync(prismaSchemaPath)

    const instance = studioInstances.get(projectId)

    if (!instance) {
      return c.json({
        status: 'stopped',
        hasPrisma,
        url: null,
      }, 200)
    }

    return c.json({
      status: instance.status,
      url: instance.url,
      port: instance.port,
      startedAt: instance.startedAt,
      hasPrisma,
    }, 200)
  })

  /**
   * GET /projects/:projectId/database/url - Get Prisma Studio URL (starts if needed)
   */
  router.get("/projects/:projectId/database/url", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    // Verify project exists
    if (!existsSync(projectDir)) {
      return c.json(
        { error: { code: "project_not_found", message: "Project not found" } },
        404
      )
    }

    // Check if Prisma schema exists
    const prismaSchemaPath = join(projectDir, "prisma", "schema.prisma")
    if (!existsSync(prismaSchemaPath)) {
      return c.json(
        { error: { code: "no_prisma_schema", message: "No Prisma schema found. Run 'prisma init' or copy a template first." } },
        400
      )
    }

    // Check if already running
    let instance = studioInstances.get(projectId)
    if (instance && instance.status === 'running') {
      return c.json({
        url: instance.url,
        status: instance.status,
      }, 200)
    }

    // Start Prisma Studio (reuse start logic via internal fetch)
    const port = getNextPort()
    const url = `http://localhost:${port}`

    console.log(`[Database] Auto-starting Prisma Studio for ${projectId} on port ${port}`)

    const child = spawn('bunx', ['prisma', 'studio', '--port', port.toString(), '--browser', 'none'], {
      cwd: projectDir,
      env: {
        ...process.env,
        BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    instance = {
      projectId,
      port,
      process: child,
      url,
      startedAt: Date.now(),
      status: 'starting',
    }

    studioInstances.set(projectId, instance)

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      if (text.includes('Started on') || text.includes('listening')) {
        instance!.status = 'running'
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      if (text.includes('Started on') || text.includes('listening')) {
        instance!.status = 'running'
      }
    })

    child.on('close', () => {
      instance!.status = 'stopped'
      studioInstances.delete(projectId)
    })

    child.on('error', () => {
      instance!.status = 'error'
    })

    // Wait for startup
    await new Promise(resolve => setTimeout(resolve, 2500))

    if (child.exitCode === null) {
      instance.status = 'running'
    }

    return c.json({
      url: instance.url,
      status: instance.status,
    }, 200)
  })

  return router
}

/**
 * Stop all running Prisma Studio instances (for graceful shutdown)
 */
export function stopAllPrismaStudios() {
  for (const [projectId, instance] of studioInstances) {
    console.log(`[Database] Stopping Prisma Studio for ${projectId}`)
    try {
      instance.process.kill('SIGTERM')
    } catch (err) {
      // Ignore
    }
  }
  studioInstances.clear()
}

export default databaseRoutes
