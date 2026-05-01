// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync, copyFileSync, readdirSync, statSync, lstatSync, realpathSync, unlinkSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pkg } from '@shogo/shared-runtime'
import { getAgentTemplateById } from './agent-templates'
import { getTemplateShogoDir, getTemplateCanvasStatePath, getTemplateCanvasCodeDir, getTemplateSrcDir, getTemplatePrismaDir, getTemplateDistDir } from './template-loader'

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
- For data-driven apps, append models to prisma/schema.prisma — the SDK auto-regenerates server.tsx and CRUD routes
- For custom non-CRUD routes (proxies, aggregations, webhooks), edit custom-routes.ts at the project root. Do NOT edit server.tsx; it is auto-generated
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

## exec vs. long-lived dev servers

The \`exec\` tool is for **finite** shell commands (installs, builds, tests,
typechecks). It is wrapped in a 5-minute timeout and returns only when the
command exits.

**Do NOT** use \`exec\` to start long-running processes — Vite dev servers,
\`expo start\` / Metro, \`bun run server.tsx\`, watchers, REPLs, etc. They will
either:

1. block until the 5-minute timeout fires and then get killed, or
2. appear to "hang" the agent for the user.

Long-lived dev servers are owned by the runtime's PreviewManager. They start
automatically when the workspace is seeded and surface their URL via the
preview tool. If you need to restart them, use the dedicated preview/dev
controls — never \`exec npx vite\` or \`exec npx expo start\`.

Rule of thumb: if the command would not exit on its own within ~30s, it does
not belong in \`exec\`.
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

  // Templates that define their own Prisma schema ship a `prisma/` directory
  // at the template root. It overrides whatever the runtime-template (or a
  // previous seeding pass) placed at <workspace>/prisma — the auto-generated
  // CRUD server then picks up the new models on next `bun run generate`.
  const templatePrismaDir = getTemplatePrismaDir(templateId)
  if (templatePrismaDir) {
    cpSync(templatePrismaDir, join(dir, 'prisma'), { recursive: true, force: true })
  }

  // Pre-built dist/ — see `getTemplateDistDir` doc-comment. We rm the
  // existing dist/ first because vite emits hashed filenames (e.g.
  // `index-AQQBZ6vm.js`) and `cpSync(force:true)` only overwrites files
  // with the same name. Without the rm, the bundled runtime-template's
  // `index-XXX.js` (Project Ready) lives on alongside the template's
  // `index-YYY.js` (BDR Pipeline) in dist/assets/ — the iframe's
  // index.html (replaced by the cp) references the new bundle, but
  // any tooling that reads the directory (or any cache that picks up
  // the stale chunk) still sees the old surface.
  const templateDistDir = getTemplateDistDir(templateId)
  if (templateDistDir) {
    const destDist = join(dir, 'dist')
    rmSync(destDist, { recursive: true, force: true })
    cpSync(templateDistDir, destDist, { recursive: true })
  }

  writeFileSync(join(dir, '.template'), templateId, 'utf-8')
  return true
}

/**
 * Re-merge a template's `src/`, `prisma/` and pre-built `dist/` onto an
 * existing workspace.
 *
 * Must run **after** `seedRuntimeTemplate` on first boot: the runtime skeleton
 * copies generic `src/App.tsx` (`Project Ready`). Agent templates ship curated
 * surfaces under `templates/<id>/src/` — those must win over that starter file.
 *
 * The pre-built `dist/` overlay is the second half of that fix: the canvas
 * iframe paints whatever `dist/` is on disk during Vite's cold rebuild, so
 * without overlaying the template's dist the user sees `Project Ready`
 * flash for ~1-3s even after `src/` is correct. See `getTemplateDistDir`.
 *
 * Same copy rules as inside `seedWorkspaceFromTemplate`; safe to repeat when
 * the workspace already matched the overlay (cpSync force is idempotent).
 */
export function overlayAgentTemplateCodeDirs(dir: string, templateId: string): boolean {
  const template = getAgentTemplateById(templateId)
  if (!template) return false

  let didAnything = false
  const templateSrcDir = getTemplateSrcDir(templateId)
  if (templateSrcDir) {
    cpSync(templateSrcDir, join(dir, 'src'), { recursive: true, force: true })
    didAnything = true
  }

  const templatePrismaDir = getTemplatePrismaDir(templateId)
  if (templatePrismaDir) {
    mkdirSync(join(dir, 'prisma'), { recursive: true })
    cpSync(templatePrismaDir, join(dir, 'prisma'), { recursive: true, force: true })
    didAnything = true
  }

  const templateDistDir = getTemplateDistDir(templateId)
  if (templateDistDir) {
    // Full replace, not merge — see seedWorkspaceFromTemplate for why.
    const destDist = join(dir, 'dist')
    rmSync(destDist, { recursive: true, force: true })
    cpSync(templateDistDir, destDist, { recursive: true })
    didAnything = true
  }

  return didAnything
}

// ---------------------------------------------------------------------------
// Runtime Template Seed (Vite + React + Tailwind + shadcn/ui)
// ---------------------------------------------------------------------------

const RUNTIME_TEMPLATE_SKIP = new Set([
  // node_modules is platform-specific; `ensureWorkspaceDeps` copies a fresh
  // tree (or runs `bun install`) once the workspace is seeded.
  'node_modules',
  // .shogo is template-/agent-specific; `seedWorkspaceDefaults` populates it.
  '.shogo',
  // Prisma generated files are workspace-specific (DB URL etc.) and are
  // re-created by `prisma generate` after seeding.
  'src/generated',
  // Note: we DO copy `dist/`. The bundled runtime-template ships a pre-built
  // bundle so the canvas iframe paints something useful (the generic Vite
  // starter) on the very first request, before Vite finishes its cold
  // rebuild. For agent-template projects, `overlayAgentTemplateCodeDirs`
  // replaces this with the template's own pre-built dist immediately
  // afterwards — see packages/agent-runtime/templates/<id>/dist.
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
  /**
   * Platform this stack ultimately runs on. Drives instance sizing,
   * disk overlays, and runtime image selection. Mirrored in
   * `@shogo/shared-runtime`'s `TECH_STACK_REGISTRY` so apps/api (which
   * doesn't bundle the tech-stacks directory) can answer the same
   * question without reading stack.json.
   *
   * Source of truth on disk; the registry is validated against this
   * field at agent-runtime boot — see `assertRegistryMatchesDisk()`.
   */
  target?: 'mobile' | 'web' | 'data' | 'native' | 'none'
  /**
   * Whether the agent-runtime's `seedTechStack(id)` is responsible for laying
   * down this stack's initial files (vs. apps/api copying the bundled Vite
   * template). Mirrored into the registry; `validateTechStackRegistry()`
   * checks the two stay in sync.
   */
  seedsOwnTemplate?: boolean
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
 * Verify every stack.json on disk has a matching entry in
 * `@shogo/shared-runtime`'s `TECH_STACK_REGISTRY` and that the `target`
 * field agrees. Run at agent-runtime boot — drift here means apps/api
 * (which only sees the registry) will size pods incorrectly for the
 * stack.
 *
 * Returns the list of mismatches so the caller can decide whether to
 * warn or hard-fail. We default to warning, since a missing registry
 * entry shouldn't take the runtime down for an unrelated bundling bug.
 */
export function validateTechStackRegistry(
  registry: Record<string, { target: string; seedsOwnTemplate?: boolean }>,
): Array<{ stackId: string; reason: string }> {
  const mismatches: Array<{ stackId: string; reason: string }> = []
  const onDisk = listTechStacks()
  const seenOnDisk = new Set<string>()
  for (const meta of onDisk) {
    seenOnDisk.add(meta.id)
    const reg = registry[meta.id]
    if (!reg) {
      mismatches.push({ stackId: meta.id, reason: 'missing from TECH_STACK_REGISTRY' })
      continue
    }
    if (meta.target && reg.target !== meta.target) {
      mismatches.push({
        stackId: meta.id,
        reason: `target mismatch: stack.json="${meta.target}" registry="${reg.target}"`,
      })
    }
    // Both fields default-falsy when omitted, so compare normalised booleans.
    const diskSeeds = !!meta.seedsOwnTemplate
    const regSeeds = !!reg.seedsOwnTemplate
    if (diskSeeds !== regSeeds) {
      mismatches.push({
        stackId: meta.id,
        reason: `seedsOwnTemplate mismatch: stack.json=${diskSeeds} registry=${regSeeds}`,
      })
    }
  }
  for (const id of Object.keys(registry)) {
    if (!seenOnDisk.has(id)) {
      mismatches.push({ stackId: id, reason: 'registry entry has no stack.json on disk' })
    }
  }
  return mismatches
}

/**
 * Paths under the workspace root that survive a `wipeProjectFiles()` pass.
 *
 * Anything *not* listed here is removed when the user explicitly resets the
 * project to a different tech stack. The allowlist is intentionally narrow:
 * agent identity (`.shogo/`), persistent agent memory, git history, canvas
 * state (so the dashboard layout doesn't blink to empty mid-reset), and the
 * agent-template marker — none of those describe the *code* of the project.
 *
 * Notably absent (i.e. wiped):
 *   - `src/`, `prisma/`, `package.json`, `bun.lock`, `vite.config.ts`,
 *     `tsconfig.json`, `app.json`, `tailwind.config.*`, etc. — the project
 *     code that the new stack's `starter/` will replace.
 *   - `.tech-stack` marker — `seedTechStack()` rewrites it for the new id.
 *   - `node_modules/` — a stack switch usually changes engines (Vite ↔ Metro,
 *     etc.); `ensureWorkspaceDeps()` will reinstall after seeding. Keeping a
 *     stale tree here is more dangerous than the install latency.
 */
const WIPE_PRESERVE_TOP_LEVEL = new Set<string>([
  '.shogo',
  'memory',
  '.git',
  '.canvas-state.json',
  '.template',
])

/**
 * Destructively remove every file/directory at the workspace root that isn't
 * in `WIPE_PRESERVE_TOP_LEVEL`. Used by the `/agent/workspace/reset-stack`
 * endpoint when the user confirms switching tech stacks — `seedTechStack()`
 * is idempotent and won't overwrite, so the workspace must be cleared first
 * for the new starter to take effect.
 *
 * Returns the number of top-level entries removed (useful for logging).
 */
export function wipeProjectFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const entry of readdirSync(dir)) {
    if (WIPE_PRESERVE_TOP_LEVEL.has(entry)) continue
    const target = join(dir, entry)
    try {
      rmSync(target, { recursive: true, force: true })
      removed++
    } catch (err: any) {
      console.warn(`[workspace-defaults] wipeProjectFiles: could not remove ${target}: ${err?.message ?? err}`)
    }
  }
  // `.shogo/` survives wipes (agent identity), but the install-marker
  // inside it is package.json-specific. Leaving the old hash behind
  // makes PreviewManager think the *new* stack's deps are stale on the
  // very first start after a switch, kicking off a reinstall it
  // doesn't actually need (and which fails on Windows boxes without
  // Node.js).
  clearInstallMarker(dir)
  console.log(`[workspace-defaults] wipeProjectFiles: removed ${removed} top-level entries from ${dir}`)
  return removed
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

// ---------------------------------------------------------------------------
// Install-marker — sha256(package.json) under `.shogo/install-marker`
// ---------------------------------------------------------------------------
//
// Both `ensureWorkspaceDeps` (host-side, fires before the agent runtime is
// up) and `PreviewManager.installDepsIfNeeded` (agent-side, fires when the
// preview starts) need to agree on whether the workspace's deps are
// already installed for the current `package.json`. The marker is the
// shared signal so:
//   - `ensureWorkspaceDeps` records the hash after a successful install,
//   - `PreviewManager` skips its own redundant reinstall when the recorded
//     hash matches the current `package.json` hash.
//
// Without this, a stack switch (Vite→Expo, etc.) would always trip
// PreviewManager's "package.json hash changed" reinstall path even though
// `ensureWorkspaceDeps` had just run a fresh install for the new stack.
// On Windows that reinstall hits the `npm.cmd not found` failure path
// when Node.js isn't separately installed — see
// `apps/desktop/.../docs/windows-node-prereq.md` for context.

const INSTALL_MARKER_RELATIVE = ['.shogo', 'install-marker'] as const

export function getInstallMarkerPath(dir: string): string {
  return join(dir, ...INSTALL_MARKER_RELATIVE)
}

/** sha256 of the workspace's `package.json`, or null if it can't be read. */
export function computePackageJsonHash(dir: string): string | null {
  try {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) return null
    return createHash('sha256').update(readFileSync(pkgPath, 'utf-8')).digest('hex')
  } catch {
    return null
  }
}

export function readInstallMarker(dir: string): string | null {
  try {
    const path = getInstallMarkerPath(dir)
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8').trim()
    return raw || null
  } catch {
    return null
  }
}

/**
 * Write the install marker for `dir`. Defaults to the current
 * `package.json` hash when no explicit hash is provided. Best-effort:
 * any I/O failure is swallowed because a missing marker only causes one
 * extra (idempotent) install on the next start, never a correctness bug.
 */
export function writeInstallMarker(dir: string, hash?: string): void {
  const value = hash ?? computePackageJsonHash(dir)
  if (!value) return
  try {
    mkdirSync(join(dir, '.shogo'), { recursive: true })
    writeFileSync(getInstallMarkerPath(dir), value, 'utf-8')
  } catch {
    // Marker write is best-effort.
  }
}

/**
 * Remove the install marker. Used by `wipeProjectFiles` on a stack switch
 * — `.shogo/` is preserved across wipes (it carries agent identity), but
 * the marker inside it is package.json-specific and would otherwise leak
 * a stale hash from the previous stack.
 */
export function clearInstallMarker(dir: string): void {
  try {
    const path = getInstallMarkerPath(dir)
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Best-effort.
  }
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
  // The template is a React+Vite project so this is only useful for
  // workspaces whose package.json actually depends on Vite. Mobile stacks
  // (Expo / RN) and Python stacks have completely different dependency
  // graphs — copying the Vite template into them produces a Frankenstein
  // node_modules where `expo` is missing and PreviewManager later has to
  // re-run install anyway. Detect the mismatch and fall through to the
  // proper install path.
  const workspacePkgUsesVite = (() => {
    try {
      const pkgPath = join(dir, 'package.json')
      if (!existsSync(pkgPath)) return false
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
      // We treat "vite" or any framework that depends on vite (e.g.
      // @vitejs/plugin-react) as a signal the workspace will use the
      // shared template.
      return !!(deps.vite || deps['@vitejs/plugin-react'])
    } catch { return false }
  })()
  const templatePath = getRuntimeTemplatePath()
  const templateModules = templatePath ? join(templatePath, 'node_modules') : null
  const templatePlatform = templatePath ? readPlatformMarker(templatePath) : null
  const templateUsable = workspacePkgUsesVite
    && templateModules
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
  } else if (templateModules && !workspacePkgUsesVite) {
    console.log(
      '[workspace-defaults] Workspace package.json does not depend on vite — skipping template copy, will run install',
    )
  }

  console.log('[workspace-defaults] Installing workspace dependencies...')
  // Delegate to the platform-aware package manager so we go through the
  // *same* install pipeline as `PreviewManager.installDepsIfNeeded`. On
  // Windows that means npm (which doesn't trip the bun-1.x hardlink bug
  // — see platform-pkg.ts) with an automatic fallback to
  // `bun install --backend=copyfile` when Node.js isn't installed; on
  // macOS/Linux it stays bun. Doing the install through pkg.installAsync
  // also means we no longer need this file's hand-rolled --frozen-lockfile
  // dance — installAsync owns the retry policy.
  await pkg.installAsync(dir, { frozen: true })
  writePlatformMarker(dir)
  // Record the install marker so PreviewManager.installDepsIfNeeded sees
  // a hash match on its first run and skips redundant reinstall — this
  // is what made stack switches (Vite → Expo) trip the "package.json
  // hash changed" path even though we just installed the right deps.
  writeInstallMarker(dir)
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
  output   = "../src/generated/prisma"
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

// Legacy `.shogo/server/` skill-server port. The skill server is retired
// and this constant is only consumed by `buildSkillServerConfig`, which
// is itself only used by migration tests that synthesize a pre-merge
// `.shogo/server/` workspace. Honour the same env precedence the unified
// `PreviewManager` uses (`API_SERVER_PORT` → legacy `SKILL_SERVER_PORT`
// → 3001) so the fixture doesn't bake in the long-dead 4100 default.
const SKILL_SERVER_PORT =
  Number(process.env.API_SERVER_PORT) ||
  Number(process.env.SKILL_SERVER_PORT) ||
  3001

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

/**
 * The legacy `.shogo/server/` skill server has been retired. The project's
 * own backend (root `server.tsx` + `prisma/schema.prisma`) is now the
 * single API server, owned by `PreviewManager`. This helper is kept as a
 * no-op shim because eval workers and other callers still reference it
 * during the rollout — it will be deleted once those callers stop calling
 * it. See `migrations/skill-server-to-root.ts` for the one-shot migration
 * of existing workspaces with a populated `.shogo/server/`.
 */
export function seedSkillServer(workspaceDir: string): { created: boolean; serverDir: string } {
  return { created: false, serverDir: join(workspaceDir, '.shogo', 'server') }
}

/**
 * Test-only: re-export the legacy schema/config strings for any test that
 * still constructs a synthetic `.shogo/server/` for migration coverage.
 * Production code should not use these.
 */
export const __LEGACY_SKILL_SERVER_INTERNALS = {
  SKILL_SERVER_SCHEMA,
  SKILL_SERVER_CONFIG,
  CUSTOM_ROUTES_TEMPLATE,
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
