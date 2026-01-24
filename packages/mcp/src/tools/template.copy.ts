/**
 * MCP Tool: template.copy
 *
 * Copy a starter template to a new project directory.
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { resolve, join, dirname } from "path"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "fs"
import { execSync } from "child_process"
import { MONOREPO_ROOT } from "../paths"
import { loadTemplates, type TemplateInfo } from "./template.list"

// Parameter schema
const Params = t({
  /** Template name to copy (e.g., "todo-app", "expense-tracker", "crm") */
  template: "string",
  /** Name for the new project */
  name: "string",
  /** Output directory (optional, defaults to workspaces/{name}) */
  "output?": "string",
  /** Skip dependency installation */
  "skipInstall?": "boolean",
  /** Dry run - return what would be created without writing */
  "dryRun?": "boolean",
  /** Force overwrite existing files in non-empty directory */
  "force?": "boolean",
})

type TemplateCopyParams = typeof Params.infer

/**
 * Recursively copy directory, excluding certain paths
 */
function copyDir(
  src: string,
  dest: string,
  exclude: string[] = [],
  files: string[] = []
): string[] {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true })
  }

  const entries = readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    // Check exclusions
    if (exclude.some((ex) => entry.name === ex || srcPath.includes(ex))) {
      continue
    }

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, exclude, files)
    } else {
      copyFileSync(srcPath, destPath)
      files.push(destPath)
    }
  }

  return files
}

/**
 * Update package.json with new project name
 */
function updatePackageJson(projectDir: string, projectName: string): void {
  const pkgPath = join(projectDir, "package.json")
  if (!existsSync(pkgPath)) return

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  pkg.name = projectName
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8")
}

/**
 * Get default output directory for new projects
 * 
 * Priority:
 * 1. PROJECT_DIR env var (Kubernetes runtime - /app/project)
 * 2. PROJECT_ID with workspaces dir (local dev with project context)
 * 3. workspaces/{name} (local dev, new project)
 * 4. current directory (fallback)
 * 
 * NOTE: The name parameter is ONLY used for package.json, NOT for directory creation.
 * Templates always copy to the root of the project directory.
 */
function getDefaultOutputDir(projectName: string): string {
  // Priority 1: PROJECT_DIR env var (Kubernetes runtime)
  // This is the correct path in containerized environments
  const projectDir = process.env.PROJECT_DIR
  if (projectDir && existsSync(projectDir)) {
    console.log(`[template.copy] Using PROJECT_DIR: ${projectDir}`)
    return projectDir
  }

  // Priority 2: PROJECT_ID with workspaces directory (local dev with project context)
  const projectId = process.env.PROJECT_ID
  if (projectId) {
    const workspacesDir = resolve(MONOREPO_ROOT, "workspaces")
    if (existsSync(workspacesDir)) {
      const projectPath = resolve(workspacesDir, projectId)
      console.log(`[template.copy] Using PROJECT_ID workspace: ${projectPath}`)
      return projectPath
    }
  }

  // Priority 3: workspaces/{projectId or name} for local development
  const workspacesDir = resolve(MONOREPO_ROOT, "workspaces")
  if (existsSync(workspacesDir)) {
    // Use projectId if available, otherwise use name
    const dirName = projectId || projectName
    const projectPath = resolve(workspacesDir, dirName)
    console.log(`[template.copy] Using workspaces directory: ${projectPath}`)
    return projectPath
  }

  // Priority 4: Fallback to cwd
  console.log(`[template.copy] Using cwd fallback: ${process.cwd()}`)
  return process.cwd()
}

/**
 * Simple timing helper for performance instrumentation
 */
function createTimer() {
  const start = performance.now()
  const steps: { name: string; durationMs: number }[] = []
  let lastMark = start
  
  return {
    mark(name: string) {
      const now = performance.now()
      const duration = now - lastMark
      steps.push({ name, durationMs: Math.round(duration) })
      console.log(`[template.copy] ⏱️  ${name}: ${Math.round(duration)}ms`)
      lastMark = now
    },
    total() {
      return Math.round(performance.now() - start)
    },
    getSteps() {
      return steps
    }
  }
}

/**
 * Execute template.copy
 */
export async function executeTemplateCopy(
  args: TemplateCopyParams
): Promise<{
  ok: boolean
  projectDir?: string
  files?: string[]
  template?: TemplateInfo
  error?: any
  timings?: { steps: { name: string; durationMs: number }[]; totalMs: number }
}> {
  const timer = createTimer()
  console.log(`[template.copy] ⏱️  Starting template copy for "${args.template}"...`)
  
  try {
    // Find the template
    const templates = loadTemplates()
    const template = templates.find((t) => t.name === args.template)
    timer.mark('loadTemplates')

    if (!template) {
      return {
        ok: false,
        error: {
          code: "TEMPLATE_NOT_FOUND",
          message: `Template "${args.template}" not found. Available templates: ${templates.map((t) => t.name).join(", ")}`,
        },
      }
    }

    // Determine output directory
    const projectDir = args.output
      ? resolve(args.output)
      : getDefaultOutputDir(args.name)
    timer.mark('determineOutputDir')

    // In project context (PROJECT_ID set), always force overwrite
    // since we're copying into an existing project workspace
    const isProjectContext = !!process.env.PROJECT_ID
    const shouldForce = args.force || isProjectContext

    // Check if output already exists
    if (existsSync(projectDir) && !args.dryRun) {
      const contents = readdirSync(projectDir)
      if (contents.length > 0 && !shouldForce) {
        return {
          ok: false,
          error: {
            code: "DIR_EXISTS",
            message: `Directory "${projectDir}" already exists and is not empty. Use force: true to overwrite.`,
          },
          timings: { steps: timer.getSteps(), totalMs: timer.total() },
        }
      }
    }

    // Dry run - just return what would be created
    if (args.dryRun) {
      return {
        ok: true,
        projectDir,
        template,
        files: [
          "package.json",
          "tsconfig.json",
          "vite.config.ts",
          "prisma/schema.prisma",
          "src/client.tsx",
          "src/router.tsx",
          "src/routes/__root.tsx",
          "src/routes/index.tsx",
          "src/lib/shogo.ts",
          "src/utils/*.ts",
        ],
        timings: { steps: timer.getSteps(), totalMs: timer.total() },
      }
    }

    // When force is used (or in project context), remove conflicting directories and files to ensure clean copy
    if (shouldForce && existsSync(projectDir)) {
      // Remove directories that might conflict
      const dirsToClean = ["src", "prisma", ".tanstack"]
      for (const dir of dirsToClean) {
        const dirPath = join(projectDir, dir)
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true })
        }
      }
      
      // Remove files that might conflict with TanStack Start templates
      // TanStack Start generates its own HTML, so remove any existing index.html
      const filesToClean = ["index.html"]
      for (const file of filesToClean) {
        const filePath = join(projectDir, file)
        if (existsSync(filePath)) {
          rmSync(filePath, { force: true })
          console.log(`[template.copy] Removed conflicting file: ${file}`)
        }
      }
    }
    timer.mark('cleanConflictingFiles')

    // Check if template has pre-installed node_modules (from Docker image)
    const templateNodeModules = join(template.path, "node_modules")
    const hasPreinstalledDeps = existsSync(templateNodeModules)
    
    // Exclusions - don't copy these
    // NOTE: If template has pre-installed node_modules, we INCLUDE it for faster setup
    const exclude = [
      ...(hasPreinstalledDeps ? [] : ["node_modules"]), // Copy node_modules if pre-installed
      "bun.lock", // Always regenerate lockfile for the target environment
      ".git",
      "dev.db",
      "dev.db-journal",
      "playwright-report",
      "test-results",
      "template.json",
    ]
    
    if (hasPreinstalledDeps) {
      console.log(`[template.copy] ⚡ Template has pre-installed node_modules - will copy for faster setup`)
    }

    // Copy template directory
    const copiedFiles = copyDir(template.path, projectDir, exclude)
    timer.mark('copyTemplateFiles')

    // Update package.json with new name
    updatePackageJson(projectDir, args.name)
    timer.mark('updatePackageJson')

    // Delete existing dev.db if copied (start fresh)
    const devDbPath = join(projectDir, "prisma", "dev.db")
    if (existsSync(devDbPath)) {
      rmSync(devDbPath, { force: true })
    }

    // Get relative file paths for response
    const relativeFiles = copiedFiles.map((f) =>
      f.replace(projectDir + "/", "")
    )

    // Build response with context-aware instructions
    const response: any = {
      ok: true,
      projectDir,
      template,
      files: relativeFiles,
    }

    // In project context, automatically rebuild and restart the preview server
    // The /preview/restart endpoint handles: bun install, prisma generate, prisma db push, build, and server start
    if (isProjectContext) {
      const projectId = process.env.PROJECT_ID
      response.projectId = projectId
      
      // Call the local runtime's restart endpoint (port 8080)
      // This will: install deps, run prisma, build the project, and start the Nitro/Vite server
      try {
        console.log(`[template.copy] ⏱️  Triggering preview restart for project ${projectId}...`)
        console.log(`[template.copy] This will run: bun install, prisma generate, prisma db push, vite build, and start server`)
        
        const restartResponse = await fetch(`http://localhost:8080/preview/restart`, {
          method: 'POST',
        })
        timer.mark('previewRestartCall')
        
        if (restartResponse.ok) {
          const restartResult = await restartResponse.json() as { mode: string; port: number | null; timings?: any }
          response.setup = {
            success: true,
            steps: ['bun install', 'prisma generate', 'prisma db push', 'vite build', `start ${restartResult.mode} server`],
            message: `Template fully set up and running in ${restartResult.mode} mode`,
            mode: restartResult.mode,
            port: restartResult.port,
            timings: restartResult.timings,
          }
          console.log(`[template.copy] ⏱️  Setup complete: ${restartResult.mode} mode on port ${restartResult.port}`)
          if (restartResult.timings) {
            console.log(`[template.copy] ⏱️  Restart timings: ${JSON.stringify(restartResult.timings)}`)
          }
        } else {
          const errorData = await restartResponse.json().catch(() => ({})) as { error?: string }
          response.setup = {
            success: false,
            error: errorData.error || `Setup failed with status ${restartResponse.status}`,
          }
          console.warn(`[template.copy] Setup failed: ${restartResponse.status}`)
        }
      } catch (restartError: any) {
        response.setup = {
          success: false,
          error: `Could not reach runtime server: ${restartError.message}`,
        }
        console.warn(`[template.copy] Setup error: ${restartError.message}`)
        timer.mark('previewRestartCall (failed)')
      }
      
      response.message = response.setup?.success 
        ? `Template "${template.name}" copied and fully set up. The preview should now show the app.`
        : `Template copied but setup failed: ${response.setup?.error}. Try refreshing the preview.`
    } else if (!args.skipInstall) {
      // Local development (not in project context) - run install steps here
      const installResults: { step: string; success: boolean; error?: string; durationMs?: number }[] = []
      
      // Step 1: bun install
      try {
        console.log("[template.copy] ⏱️  Running bun install...")
        const bunInstallStart = performance.now()
        execSync("bun install", {
          cwd: projectDir,
          stdio: "pipe",
          timeout: 120000,
        })
        const bunInstallDuration = Math.round(performance.now() - bunInstallStart)
        installResults.push({ step: "bun install", success: true, durationMs: bunInstallDuration })
        console.log(`[template.copy] ⏱️  bun install completed in ${bunInstallDuration}ms`)
      } catch (error: any) {
        console.error("[template.copy] bun install failed:", error.message)
        installResults.push({ step: "bun install", success: false, error: error.message })
      }
      timer.mark('bunInstall')

      // Step 2: prisma generate (only if bun install succeeded)
      if (installResults[0]?.success) {
        try {
          console.log("[template.copy] ⏱️  Running prisma generate...")
          const prismaGenStart = performance.now()
          execSync("bunx prisma generate", {
            cwd: projectDir,
            stdio: "pipe",
            timeout: 60000,
          })
          const prismaGenDuration = Math.round(performance.now() - prismaGenStart)
          installResults.push({ step: "prisma generate", success: true, durationMs: prismaGenDuration })
          console.log(`[template.copy] ⏱️  prisma generate completed in ${prismaGenDuration}ms`)
        } catch (error: any) {
          console.error("[template.copy] prisma generate failed:", error.message)
          installResults.push({ step: "prisma generate", success: false, error: error.message })
        }
        timer.mark('prismaGenerate')
      }

      // Step 3: prisma db push (only if previous steps succeeded)
      if (installResults.every(r => r.success)) {
        try {
          console.log("[template.copy] ⏱️  Running prisma db push...")
          const prismaPushStart = performance.now()
          execSync("bunx prisma db push", {
            cwd: projectDir,
            stdio: "pipe",
            timeout: 60000,
          })
          const prismaPushDuration = Math.round(performance.now() - prismaPushStart)
          installResults.push({ step: "prisma db push", success: true, durationMs: prismaPushDuration })
          console.log(`[template.copy] ⏱️  prisma db push completed in ${prismaPushDuration}ms`)
        } catch (error: any) {
          console.error("[template.copy] prisma db push failed:", error.message)
          installResults.push({ step: "prisma db push", success: false, error: error.message })
        }
        timer.mark('prismaDbPush')
      }

      response.install = {
        ran: true,
        steps: installResults,
        allSucceeded: installResults.every(r => r.success),
      }
      
      response.message = installResults.every(r => r.success)
        ? `Template copied and dependencies installed. Run "cd ${projectDir} && bun run dev" to start.`
        : `Template copied but some setup steps failed. Check the install results.`
    }

    // Add timing information to response
    const totalMs = timer.total()
    response.timings = { steps: timer.getSteps(), totalMs }
    console.log(`[template.copy] ⏱️  TOTAL: ${totalMs}ms`)

    return response
  } catch (error: any) {
    const totalMs = timer.total()
    console.log(`[template.copy] ⏱️  FAILED after ${totalMs}ms: ${error.message}`)
    return {
      ok: false,
      error: {
        code: "COPY_ERROR",
        message: error.message || "Failed to copy template",
      },
      timings: { steps: timer.getSteps(), totalMs },
    }
  }
}

/**
 * Register template.copy tool
 */
export function registerTemplateCopy(server: FastMCP) {
  server.addTool({
    name: "template.copy",
    description: `Copy a starter template to set up the current project. The template provides a working app structure with Prisma schema, React components, TanStack Router, and Shogo SDK integration.

IMPORTANT: This tool handles EVERYTHING automatically:
1. Copies template files to the project root
2. Runs "bun install" to install dependencies
3. Runs "prisma generate" to generate Prisma client
4. Runs "prisma db push" to set up the database
5. Builds the project with "vite build" (using Nitro for TanStack Start)
6. Starts the production server
7. The preview will automatically show the running app

You do NOT need to run any commands after using this tool. Just call template.copy and the app will be ready.

Available templates:
- todo-app: Simple task management (beginner)
- expense-tracker: Personal finance with categories/transactions (intermediate)
- crm: Customer relationship management with contacts/deals (intermediate)
- inventory: Stock and product management with suppliers (intermediate)
- kanban: Project boards with drag-and-drop cards (intermediate)
- ai-chat: AI chatbot with conversation history, Vercel AI SDK (advanced)
- form-builder: Dynamic form creation (intermediate)
- feedback-form: User feedback collection (beginner)
- booking-app: Appointment/booking system (intermediate)

Options:
- dryRun: true - Preview what would be copied without writing

Examples:
- template.copy({ template: "todo-app", name: "my-tasks" })
- template.copy({ template: "expense-tracker", name: "my-expenses" })`,
    parameters: Params as any,
    execute: async (args: any) => {
      const result = await executeTemplateCopy(args)
      return JSON.stringify(result, null, 2)
    },
  })
}
