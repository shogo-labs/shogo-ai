// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync, copyFileSync, readdirSync, statSync, lstatSync, realpathSync, unlinkSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAgentTemplateById } from './agent-templates'
import { getTemplateShogoDir, getTemplateCanvasStatePath, getTemplateCanvasCodeDir, getTemplateSrcDir } from './template-loader'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_WORKSPACE_FILES: Record<string, string> = {
  'AGENTS.md': `# Identity

- **Name:** Shogo
- **Emoji:** ⚡
- **Tagline:** Your AI agent — ready to build

# Personality

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

# User

- **Name:** (not set)
- **Timezone:** UTC

# Operating Instructions

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

/**
 * Remove stale .shogo symlinks left by previous VM 9p mount runs.
 * The VM creates .shogo -> /tmp/shogo-local/<id>/.shogo which becomes a
 * broken symlink on the host after the VM exits. mkdirSync({recursive:true})
 * sees the symlink entry but can't traverse it, causing ENOENT.
 */
function removeStaleShogoSymlink(dir: string): void {
  const shogoDir = join(dir, '.shogo')
  try {
    const st = lstatSync(shogoDir)
    if (st.isSymbolicLink()) {
      try { statSync(shogoDir) } catch { rmSync(shogoDir, { force: true }) }
    }
  } catch {}
}

export function seedWorkspaceDefaults(dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  removeStaleShogoSymlink(dir)
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
  removeStaleShogoSymlink(dir)
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
    removeStaleShogoSymlink(dir)
    const destShogo = join(dir, '.shogo')
    if (!existsSync(destShogo)) {
      cpSync(shogoSrc, destShogo, { recursive: true })
      if (agentName) {
        for (const fname of ['AGENTS.md']) {
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

  const templateSrcDir = getTemplateSrcDir(templateId)
  if (templateSrcDir) {
    cpSync(templateSrcDir, join(dir, 'src'), { recursive: true, force: true })
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
 *
 * Candidate paths (checked in order, first with package.json wins):
 * - RUNTIME_TEMPLATE_DIR env override (any environment)
 * - Relative to source tree (local dev: __dirname is packages/agent-runtime/src/)
 * - Adjacent to bundled server.js (VM guest: __dirname is /opt/shogo/)
 * - /app/templates/runtime-template (Docker / K8s)
 * - /opt/shogo/templates/runtime-template (VM pre-provisioned rootfs)
 */
export function getRuntimeTemplatePath(): string | null {
  const envOverride = process.env.RUNTIME_TEMPLATE_DIR
  const candidates = [
    ...(envOverride ? [envOverride] : []),
    join(__dirname, '..', '..', '..', 'templates', 'runtime-template'),
    join(__dirname, 'templates', 'runtime-template'),
    '/app/templates/runtime-template',
    '/opt/shogo/templates/runtime-template',
  ]
  for (const p of candidates) {
    if (existsSync(join(p, 'package.json'))) {
      // Resolve symlinks so cpSync doesn't choke on a symlink-to-directory.
      // The VM image symlinks /opt/shogo/templates/runtime-template → /app/templates/runtime-template/
      try { return realpathSync(p) } catch { return p }
    }
  }
  return null
}

/**
 * Copy runtime-template source files into a workspace so it's a working
 * Vite + React project out of the box. Excludes node_modules (platform-specific)
 * — those are handled by ensureWorkspaceDeps() which copies pre-built modules
 * from the template or falls back to `bun install`.
 *
 * Returns true if files were copied, false if template was not found
 * or workspace already has a package.json.
 */
export function seedRuntimeTemplate(dir: string): boolean {
  if (existsSync(join(dir, 'package.json'))) return false

  const templatePath = getRuntimeTemplatePath()
  if (!templatePath) {
    console.error('[workspace-defaults] ERROR: runtime-template not found in any candidate path — workspace will lack Vite/React/Tailwind setup')
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

// ---------------------------------------------------------------------------
// Tech Stack Seeding
// ---------------------------------------------------------------------------

function getTechStacksBasePath(): string {
  const candidates = [
    join(__dirname, '..', 'tech-stacks'),
    join(__dirname, 'tech-stacks'),
    join(__dirname, '..', '..', '..', 'tech-stacks'),
    '/app/tech-stacks',
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return join(__dirname, '..', 'tech-stacks')
}

export function getTechStackPath(stackId: string): string | null {
  const base = getTechStacksBasePath()
  const stackDir = join(base, stackId)
  if (existsSync(join(stackDir, 'stack.json'))) return stackDir
  return null
}

export interface TechStackMeta {
  id: string
  name: string
  description: string
  tags: string[]
  runtime?: {
    devServer?: string
    buildCommand?: string
    /**
     * Port the stack's template API sidecar (e.g. Hono `server.tsx`) listens on.
     * Note: this is NOT the URL users hit in a browser — the agent runtime
     * itself serves the built app at the root of `process.env.PORT`. This
     * number is only relevant to internal `/api/*` proxying.
     */
    templateApiPort?: number
  }
  capabilities?: {
    webEnabled?: boolean
    browserEnabled?: boolean
    shellEnabled?: boolean
    heartbeatEnabled?: boolean
    imageGenEnabled?: boolean
    memoryEnabled?: boolean
    quickActionsEnabled?: boolean
  }
}

export function loadTechStackMeta(stackId: string): TechStackMeta | null {
  const stackPath = getTechStackPath(stackId)
  if (!stackPath) return null
  try {
    return JSON.parse(readFileSync(join(stackPath, 'stack.json'), 'utf-8'))
  } catch {
    return null
  }
}

export function listTechStacks(): TechStackMeta[] {
  const base = getTechStacksBasePath()
  if (!existsSync(base)) return []
  const stacks: TechStackMeta[] = []
  for (const entry of readdirSync(base)) {
    const stackJsonPath = join(base, entry, 'stack.json')
    if (existsSync(stackJsonPath)) {
      try {
        stacks.push(JSON.parse(readFileSync(stackJsonPath, 'utf-8')))
      } catch { /* skip malformed */ }
    }
  }
  return stacks
}

/**
 * Seed tech stack files into a workspace.
 * Copies .shogo/STACK.md and starter/ files from the tech stack.
 * Only writes files that don't already exist (preserves customizations).
 * Returns true if files were seeded, false if stack not found.
 */
export function seedTechStack(dir: string, stackId: string): boolean {
  const stackPath = getTechStackPath(stackId)
  if (!stackPath) {
    console.warn(`[workspace-defaults] Tech stack "${stackId}" not found — skipping`)
    return false
  }

  const stackMd = join(stackPath, '.shogo', 'STACK.md')
  if (existsSync(stackMd)) {
    const destShogo = join(dir, '.shogo')
    mkdirSync(destShogo, { recursive: true })
    const destStackMd = join(destShogo, 'STACK.md')
    if (!existsSync(destStackMd)) {
      copyFileSync(stackMd, destStackMd)
    }
  }

  const starterDir = join(stackPath, 'starter')
  if (existsSync(starterDir)) {
    cpSync(starterDir, dir, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(starterDir.length + 1)
        if (!rel) return true
        const dest = join(dir, rel)
        return !existsSync(dest)
      },
    })
  }

  writeFileSync(join(dir, '.tech-stack'), stackId, 'utf-8')
  console.log(`[workspace-defaults] Tech stack "${stackId}" seeded into workspace`)
  return true
}

/**
 * Run a tech stack's setup script if present.
 * The script is expected to be idempotent.
 */
export async function runTechStackSetup(dir: string, stackId: string): Promise<void> {
  const stackPath = getTechStackPath(stackId)
  if (!stackPath) return

  const setupScript = join(stackPath, 'starter', 'setup.sh')
  if (!existsSync(setupScript)) return

  const destSetup = join(dir, 'setup.sh')
  if (!existsSync(destSetup)) return

  console.log(`[workspace-defaults] Running tech stack setup for "${stackId}"...`)
  const { spawn } = await import('child_process')
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('bash', ['setup.sh'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(chunk) })
    proc.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(chunk) })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else {
        console.warn(`[workspace-defaults] Tech stack setup exited with code ${code}`)
        resolve()
      }
    })
    proc.on('error', (err) => {
      console.warn(`[workspace-defaults] Tech stack setup error: ${err.message}`)
      resolve()
    })
  })
}

const PLATFORM_TAG = `${process.platform}-${process.arch}`

function readPlatformMarker(dir: string): string | null {
  const marker = join(dir, 'node_modules', '.shogo-platform')
  if (!existsSync(marker)) return null
  try { return readFileSync(marker, 'utf-8').trim() } catch { return null }
}

function writePlatformMarker(dir: string): void {
  try { writeFileSync(join(dir, 'node_modules', '.shogo-platform'), PLATFORM_TAG + '\n') } catch {}
}

/**
 * Detect if node_modules contains native binaries for a different platform.
 * Checks @rollup/ packages which have predictable platform-specific naming.
 * Returns the detected foreign platform string, or null if OK.
 */
function detectWrongPlatformNativeDeps(dir: string): string | null {
  const rollupDir = join(dir, 'node_modules', '@rollup')
  if (!existsSync(rollupDir)) return null
  try {
    const entries = readdirSync(rollupDir)
    const platformPkgs = entries.filter(e => e.startsWith('rollup-'))
    if (platformPkgs.length === 0) return null
    const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : 'win32'
    const hasCorrect = platformPkgs.some(e => e.includes(`-${os}-`))
    if (hasCorrect) return null
    return platformPkgs[0]?.replace('rollup-', '') ?? 'unknown'
  } catch { return null }
}

/**
 * Ensure workspace has node_modules installed with correct platform binaries.
 *
 * Platform detection: a `.shogo-platform` marker records what OS+arch the
 * modules were installed for. If it doesn't match the current platform
 * (e.g. macOS modules mounted into a Linux VM), we nuke and reinstall.
 *
 * Fast path: if the runtime-template in the image has pre-installed
 * node_modules (from provisioning), copy them directly — avoids a
 * full `bun install` on every workspace creation.
 *
 * Fallback: runs `bun install` when no pre-built modules are available.
 */
export async function ensureWorkspaceDeps(dir: string): Promise<void> {
  if (!existsSync(join(dir, 'package.json'))) return

  const viteBin = join(dir, 'node_modules', '.bin', 'vite')
  const nodeModules = join(dir, 'node_modules')

  // Check for wrong-platform modules (e.g. macOS host-mounted into Linux VM)
  const installedPlatform = readPlatformMarker(dir)
  if (installedPlatform && installedPlatform !== PLATFORM_TAG) {
    console.log(`[workspace-defaults] node_modules built for ${installedPlatform}, need ${PLATFORM_TAG} — reinstalling`)
    try { rmSync(nodeModules, { recursive: true, force: true }) } catch {}
  } else if (existsSync(viteBin)) {
    if (installedPlatform === PLATFORM_TAG) return
    // No marker — check for wrong-platform native binaries (rollup)
    if (!installedPlatform && existsSync(nodeModules)) {
      const wrongPlatform = detectWrongPlatformNativeDeps(dir)
      if (wrongPlatform) {
        console.log(`[workspace-defaults] Detected ${wrongPlatform} native deps, need ${PLATFORM_TAG} — reinstalling`)
        try { rmSync(nodeModules, { recursive: true, force: true }) } catch {}
      } else {
        writePlatformMarker(dir)
        return
      }
    }
  }

  // Fast path: copy pre-installed node_modules from the image template.
  const templatePath = getRuntimeTemplatePath()
  const templateModules = templatePath ? join(templatePath, 'node_modules') : null
  const templatePlatform = templatePath ? readPlatformMarker(templatePath) : null
  const templateUsable = templateModules
    && existsSync(join(templateModules, '.bin', 'vite'))
    && (!templatePlatform || templatePlatform === PLATFORM_TAG)
  if (templateUsable) {
    console.log('[workspace-defaults] Copying pre-installed node_modules from template...')
    try {
      cpSync(templateModules!, join(dir, 'node_modules'), { recursive: true })
      writePlatformMarker(dir)
      if (existsSync(viteBin)) {
        console.log('[workspace-defaults] Pre-installed deps ready (copied from template)')
        return
      }
    } catch (err: any) {
      console.warn(`[workspace-defaults] Failed to copy template node_modules: ${err.message}`)
    }
  }

  console.log('[workspace-defaults] Installing workspace dependencies...')
  const { spawn } = await import('child_process')
  const bunBin = process.env.SHOGO_BUN_PATH || 'bun'
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bunBin, ['install', '--frozen-lockfile'], {
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
        const retry = spawn(bunBin, ['install'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
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
  writePlatformMarker(dir)
  console.log('[workspace-defaults] Workspace dependencies installed')
}

// ---------------------------------------------------------------------------
// Skill Server Seed
// ---------------------------------------------------------------------------

export const SKILL_SERVER_SCHEMA_HEADER = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}
`

const SKILL_SERVER_SCHEMA = SKILL_SERVER_SCHEMA_HEADER + `
// Add your models below. Each model gets CRUD routes at /api/{model-name-plural}.
// The skill server auto-regenerates when you save this file.
`

/**
 * Build a complete skill server Prisma schema from model definitions.
 * Prepends the canonical datasource+generator header so callers
 * don't need to duplicate it.
 */
export function buildSkillServerSchema(models: string): string {
  return SKILL_SERVER_SCHEMA_HEADER + '\n' + models.trim() + '\n'
}

export const SKILL_SERVER_PRISMA_CONFIG = `import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: './schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:./skill.db',
  },
})
`

const SKILL_SERVER_PORT = Number(process.env.SKILL_SERVER_PORT) || 4100

export function buildSkillServerConfig(port = SKILL_SERVER_PORT): string {
  return JSON.stringify(
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
            port,
            skipStatic: true,
            customRoutesPath: './custom-routes',
            dynamicCrudImport: true,
            bunServe: true,
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
}

const SKILL_SERVER_CONFIG = buildSkillServerConfig()

/**
 * Seed the skill server skeleton in .shogo/server/.
 * Creates schema.prisma, shogo.config.json, and necessary directories.
 * Only writes files that don't already exist.
 */
export const CUSTOM_ROUTES_TEMPLATE = `import { Hono } from 'hono'
const app = new Hono()
// Add custom API routes here. They are mounted at /api/.
export default app
`

export function seedSkillServer(workspaceDir: string): { created: boolean; serverDir: string } {
  const serverDir = join(workspaceDir, '.shogo', 'server')
  const schemaPath = join(serverDir, 'schema.prisma')

  if (existsSync(schemaPath)) {
    // Even if the schema already existed, ensure custom-routes.ts is present
    const customRoutesPath = join(serverDir, 'custom-routes.ts')
    if (!existsSync(customRoutesPath)) {
      writeFileSync(customRoutesPath, CUSTOM_ROUTES_TEMPLATE, 'utf-8')
    }
    return { created: false, serverDir }
  }

  mkdirSync(serverDir, { recursive: true })
  mkdirSync(join(serverDir, 'generated'), { recursive: true })
  mkdirSync(join(serverDir, 'hooks'), { recursive: true })

  writeFileSync(schemaPath, SKILL_SERVER_SCHEMA, 'utf-8')
  writeFileSync(join(serverDir, 'shogo.config.json'), SKILL_SERVER_CONFIG, 'utf-8')
  writeFileSync(join(serverDir, 'prisma.config.ts'), SKILL_SERVER_PRISMA_CONFIG, 'utf-8')
  writeFileSync(join(serverDir, 'custom-routes.ts'), CUSTOM_ROUTES_TEMPLATE, 'utf-8')

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
