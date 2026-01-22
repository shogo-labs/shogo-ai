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
 * If running in project context (PROJECT_ID env var set), uses the project's
 * workspace directory. Otherwise creates a new directory based on project name.
 */
function getDefaultOutputDir(projectName: string): string {
  // Check for project context - if PROJECT_ID is set, use that directory
  const projectId = process.env.PROJECT_ID
  if (projectId) {
    // Running in project runtime context - use the project's workspace directory
    const workspacesDir = resolve(MONOREPO_ROOT, "workspaces")
    if (existsSync(workspacesDir)) {
      return resolve(workspacesDir, projectId)
    }
  }

  // Not in project context - create new directory based on project name
  const workspacesDir = resolve(MONOREPO_ROOT, "workspaces")
  if (existsSync(workspacesDir)) {
    return resolve(workspacesDir, projectName)
  }

  // Fallback to current directory
  return resolve(process.cwd(), projectName)
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
}> {
  try {
    // Find the template
    const templates = loadTemplates()
    const template = templates.find((t) => t.name === args.template)

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
      }
    }

    // When force is used (or in project context), remove conflicting directories to ensure clean copy
    if (shouldForce && existsSync(projectDir)) {
      const dirsToClean = ["src", "prisma", ".tanstack"]
      for (const dir of dirsToClean) {
        const dirPath = join(projectDir, dir)
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true })
        }
      }
    }

    // Exclusions - don't copy these
    const exclude = [
      "node_modules",
      "bun.lock",
      ".git",
      "dev.db",
      "dev.db-journal",
      "playwright-report",
      "test-results",
      "template.json",
    ]

    // Copy template directory
    const copiedFiles = copyDir(template.path, projectDir, exclude)

    // Update package.json with new name
    updatePackageJson(projectDir, args.name)

    // Delete existing dev.db if copied (start fresh)
    const devDbPath = join(projectDir, "prisma", "dev.db")
    if (existsSync(devDbPath)) {
      rmSync(devDbPath, { force: true })
    }

    // Install dependencies unless skipped
    if (!args.skipInstall) {
      try {
        execSync("bun install", {
          cwd: projectDir,
          stdio: "pipe",
          timeout: 120000,
        })

        // Run prisma generate
        execSync("bunx prisma generate", {
          cwd: projectDir,
          stdio: "pipe",
          timeout: 60000,
        })

        // Run prisma db push to create database
        execSync("bunx prisma db push", {
          cwd: projectDir,
          stdio: "pipe",
          timeout: 60000,
        })
      } catch (error: any) {
        // Non-fatal - user can run manually
        console.warn("[template.copy] Warning: Install/setup failed, run manually")
      }
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

    // In project context, add restart instructions
    if (isProjectContext) {
      const projectId = process.env.PROJECT_ID
      response.needsRestart = true
      response.instructions = [
        "Template files have been copied to the project directory.",
        "The Vite dev server needs to be restarted for changes to take effect.",
        `Use Bash to run: curl -X POST http://localhost:8002/api/projects/${projectId}/runtime/restart`,
        "After restart, the preview will automatically show the new app.",
      ]
    }

    return response
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: "COPY_ERROR",
        message: error.message || "Failed to copy template",
      },
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

NOTE: In project context, files are automatically overwritten (force is enabled by default).
After copying, the Vite dev server will automatically reload with the new code.

Available templates:
- todo-app: Simple task management (beginner)
- expense-tracker: Personal finance with categories/transactions (intermediate)
- crm: Customer relationship management with contacts/deals (intermediate)
- inventory: Stock and product management with suppliers (intermediate)
- kanban: Project boards with drag-and-drop cards (intermediate)
- ai-chat: AI chatbot with conversation history, Vercel AI SDK (advanced)

Options:
- skipInstall: true - Don't run bun install or prisma setup
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
