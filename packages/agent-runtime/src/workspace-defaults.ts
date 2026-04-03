// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAgentTemplateById } from './agent-templates'
import { getTemplateShogoDir, getTemplateCanvasStatePath, getTemplateCanvasCodeDir } from './template-loader'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_WORKSPACE_FILES: Record<string, string> = {
  'AGENTS.md': `# Operating Instructions

## Approach
- **Plan before you build.** For any multi-step task, first write a brief plan covering what you'll build, the data model, component layout, and test plan. Then execute.
- **Understand before you fix.** When debugging, trace the error to its root cause before editing. Read the failing code and understand why it fails.
- Build interactive UIs in src/App.tsx when the user asks for dashboards, apps, or visual displays
- Use memory tools to persist important facts the user shares
- Prefer action over clarification — make reasonable assumptions and explain what you did

## App Development
- The workspace is a standard Vite + React + Tailwind + shadcn/ui app
- Edit src/App.tsx for the main UI, add components under src/components/
- For data-driven apps, create a skill server by writing .shogo/server/schema.prisma
- Use edit_file to update existing files — avoid full rewrites

## Priorities
1. User requests — respond promptly and take action
2. Urgent alerts — surface immediately via channels
3. Scheduled checks — run on heartbeat cadence
4. Proactive suggestions — offer when relevant context is available
`,
  'SOUL.md': `# Soul

You are a capable, proactive AI agent. You communicate clearly and get things done efficiently.
You explain what you're about to do, then do it. You prefer showing over telling.

## Tone
- Direct and helpful, not verbose
- Confident but not presumptuous
- Celebrate completions briefly, then move on

## Boundaries
- Never execute destructive commands without explicit confirmation
- Never share credentials in channel messages
- Respect quiet hours for non-urgent notifications
`,
  'IDENTITY.md': `# Identity

- **Name:** Shogo
- **Emoji:** ⚡
- **Tagline:** Your AI agent — ready to build
`,
  'USER.md': `# User

- **Name:** (not set)
- **Timezone:** UTC
`,
  'HEARTBEAT.md': '',
  'TOOLS.md': `# Tools

Notes about available tools and conventions for this agent.
`,
  'MEMORY.md': `# Memory

Long-lived facts and learnings are stored here.
`,
  'config.json': JSON.stringify(
    {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      activeMode: 'canvas',
      canvasMode: 'code',
      model: {
        provider: 'anthropic',
        name: 'claude-sonnet-4-6',
      },
    },
    null,
    2
  ),
}

/**
 * Write default workspace files into a directory, creating subdirectories as needed.
 * Only writes files that don't already exist (won't overwrite user customizations).
 */
/**
 * Resolve a canonical workspace config/markdown file path.
 * Root is preferred (existing behavior); `.shogo/` is used when the workspace was
 * seeded from a template (see `seedWorkspaceFromTemplate`), which only copies into `.shogo/`.
 */
export function resolveWorkspaceConfigFilePath(dir: string, filename: string): string | null {
  const rootPath = join(dir, filename)
  if (existsSync(rootPath)) return rootPath
  const shogoPath = join(dir, '.shogo', filename)
  if (existsSync(shogoPath)) return shogoPath
  return null
}

export function seedWorkspaceDefaults(dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'skills'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'plans'), { recursive: true })

  for (const [filename, content] of Object.entries(DEFAULT_WORKSPACE_FILES)) {
    const filepath = join(dir, filename)
    if (!existsSync(filepath)) {
      writeFileSync(filepath, content, 'utf-8')
    }
  }
}

/**
 * Force-write all default workspace files (overwrites existing).
 * Used by eval runner to reset workspace between tests.
 */
export function resetWorkspaceDefaults(dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'skills'), { recursive: true })

  for (const [filename, content] of Object.entries(DEFAULT_WORKSPACE_FILES)) {
    writeFileSync(join(dir, filename), content, 'utf-8')
  }
}

/**
 * Seed workspace from a template. Copies the template's .shogo/ directory
 * and .canvas-state.json into the workspace.
 * Only writes files that don't already exist (preserves customizations).
 * Also writes a .template marker file so the runtime knows which template was used.
 */
export function seedWorkspaceFromTemplate(dir: string, templateId: string, agentName?: string): boolean {
  const template = getAgentTemplateById(templateId)
  if (!template) return false

  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })

  const shogoSrc = getTemplateShogoDir(templateId)
  if (shogoSrc) {
    const destShogo = join(dir, '.shogo')
    if (!existsSync(destShogo)) {
      cpSync(shogoSrc, destShogo, { recursive: true })
      if (agentName) {
        for (const fname of ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md']) {
          const fp = join(destShogo, fname)
          if (existsSync(fp)) {
            const content = readFileSync(fp, 'utf-8')
            if (content.includes('{{AGENT_NAME}}')) {
              writeFileSync(fp, content.replace(/\{\{AGENT_NAME\}\}/g, agentName), 'utf-8')
            }
          }
        }
      }
    }
  }

  const canvasSrc = getTemplateCanvasStatePath(templateId)
  if (canvasSrc) {
    const canvasDest = join(dir, '.canvas-state.json')
    if (!existsSync(canvasDest)) {
      cpSync(canvasSrc, canvasDest)
    }
  }

  const canvasCodeSrc = getTemplateCanvasCodeDir(templateId)
  if (canvasCodeSrc) {
    const canvasDest = join(dir, 'canvas')
    if (!existsSync(canvasDest)) {
      cpSync(canvasCodeSrc, canvasDest, { recursive: true })
    }
  }

  writeFileSync(join(dir, '.template'), templateId, 'utf-8')
  return true
}

// ---------------------------------------------------------------------------
// Runtime Template Seed (Vite + React + Tailwind + shadcn/ui)
// ---------------------------------------------------------------------------

const RUNTIME_TEMPLATE_SKIP = new Set([
  'dist',
  'node_modules',
  '.shogo',
  // Prisma generated files and lock are workspace-specific
  'src/generated',
])

/**
 * Resolve the path to the runtime-template directory.
 * In Docker: /app/templates/runtime-template
 * In local dev: ../../templates/runtime-template (relative to src/)
 */
function getRuntimeTemplatePath(): string | null {
  const candidates = [
    join(__dirname, '..', '..', '..', 'templates', 'runtime-template'),
    '/app/templates/runtime-template',
  ]
  for (const p of candidates) {
    if (existsSync(join(p, 'package.json'))) return p
  }
  return null
}

/**
 * Copy runtime-template files into a workspace so it's a working
 * Vite + React project out of the box. Copies node_modules if the
 * template has pre-installed deps (from Docker build). Skips files
 * that already exist to preserve user modifications (e.g. after S3 restore).
 *
 * Returns true if files were copied, false if template was not found
 * or workspace already has a package.json.
 */
export function seedRuntimeTemplate(dir: string): boolean {
  if (existsSync(join(dir, 'package.json'))) return false

  const templatePath = getRuntimeTemplatePath()
  if (!templatePath) {
    console.warn('[workspace-defaults] runtime-template not found — skipping')
    return false
  }

  cpSync(templatePath, dir, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(templatePath.length + 1)
      if (!rel) return true
      const topLevel = rel.split('/')[0]
      return !RUNTIME_TEMPLATE_SKIP.has(topLevel) && !RUNTIME_TEMPLATE_SKIP.has(rel)
    },
  })

  console.log('[workspace-defaults] Seeded runtime template into workspace')
  return true
}

/**
 * Ensure workspace has node_modules installed.
 * If the template copy included pre-installed node_modules, this is a no-op.
 * Otherwise, runs `bun install` to install dependencies.
 */
export async function ensureWorkspaceDeps(dir: string): Promise<void> {
  if (!existsSync(join(dir, 'package.json'))) return
  if (existsSync(join(dir, 'node_modules', '.package-lock.json')) ||
      existsSync(join(dir, 'node_modules', '.cache'))) return

  const viteBin = join(dir, 'node_modules', '.bin', 'vite')
  if (existsSync(viteBin)) return

  console.log('[workspace-defaults] Installing workspace dependencies...')
  const { spawn } = await import('child_process')
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('bun', ['install', '--frozen-lockfile'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.stdout?.on('data', () => {})
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else {
        console.warn(`[workspace-defaults] bun install exited with code ${code}, retrying without --frozen-lockfile`)
        const retry = spawn('bun', ['install'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
        retry.stderr?.on('data', () => {})
        retry.stdout?.on('data', () => {})
        retry.on('close', (c2) => {
          if (c2 === 0) resolve()
          else reject(new Error(`bun install failed: ${stderr}`))
        })
        retry.on('error', reject)
      }
    })
    proc.on('error', reject)
  })
  console.log('[workspace-defaults] Workspace dependencies installed')
}

// ---------------------------------------------------------------------------
// Skill Server Seed
// ---------------------------------------------------------------------------

const SKILL_SERVER_SCHEMA = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}

// Add your models below. Each model gets CRUD routes at /api/{model-name-plural}.
// The skill server auto-regenerates when you save this file.
`

const SKILL_SERVER_PRISMA_CONFIG = `import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: './schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:./skill.db',
  },
})
`

const SKILL_SERVER_PORT = Number(process.env.SKILL_SERVER_PORT) || 4100

const SKILL_SERVER_CONFIG = JSON.stringify(
  {
    schema: './schema.prisma',
    outputs: [
      {
        dir: './generated',
        generate: ['routes', 'hooks', 'types'],
      },
      {
        dir: '.',
        generate: ['server'],
        serverConfig: {
          routesPath: './generated',
          dbPath: './db',
          port: SKILL_SERVER_PORT,
          skipStatic: true,
        },
      },
      {
        dir: '.',
        generate: ['db'],
        dbProvider: 'sqlite',
      },
    ],
  },
  null,
  2,
)

/**
 * Seed the skill server skeleton in .shogo/server/.
 * Creates schema.prisma, shogo.config.json, and necessary directories.
 * Only writes files that don't already exist.
 */
export function seedSkillServer(workspaceDir: string): { created: boolean; serverDir: string } {
  const serverDir = join(workspaceDir, '.shogo', 'server')
  const schemaPath = join(serverDir, 'schema.prisma')

  if (existsSync(schemaPath)) {
    return { created: false, serverDir }
  }

  mkdirSync(serverDir, { recursive: true })
  mkdirSync(join(serverDir, 'generated'), { recursive: true })
  mkdirSync(join(serverDir, 'hooks'), { recursive: true })

  writeFileSync(schemaPath, SKILL_SERVER_SCHEMA, 'utf-8')
  writeFileSync(join(serverDir, 'shogo.config.json'), SKILL_SERVER_CONFIG, 'utf-8')
  writeFileSync(join(serverDir, 'prisma.config.ts'), SKILL_SERVER_PRISMA_CONFIG, 'utf-8')

  return { created: true, serverDir }
}

// ---------------------------------------------------------------------------
// LSP Configuration Seed
// ---------------------------------------------------------------------------



const WORKSPACE_PYRIGHTCONFIG = JSON.stringify(
  {
    pythonVersion: '3.11',
    typeCheckingMode: 'basic',
    reportMissingImports: true,
    reportMissingModuleSource: false,
    reportOptionalMemberAccess: true,
    exclude: ['.shogo', 'node_modules', 'canvas'],
  },
  null,
  2,
)

/**
 * Seed LSP configuration into a workspace so language servers
 * can provide diagnostics. The workspace already has tsconfig.json
 * from the template — we only add pyrightconfig.json for Python.
 */
export function seedLSPConfig(dir: string): void {
  writeFileSync(join(dir, 'pyrightconfig.json'), WORKSPACE_PYRIGHTCONFIG, 'utf-8')
}
