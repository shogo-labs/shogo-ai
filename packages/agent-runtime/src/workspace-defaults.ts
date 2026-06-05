// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync, copyFileSync, readdirSync, statSync, lstatSync, realpathSync, unlinkSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pkg } from '@shogo/shared-runtime'

// =============================================================================
// Per-workspace install mutex
// =============================================================================
//
// `bun install` is NOT safe to run concurrently against the same workspace.
// On 2026-05-13 (project 865f99fa) we observed two parallel callers race
// each other:
//
//   Path A: server.ts:initializeEssentials → fire-and-forget
//           pm.start() → PreviewManager.installDepsIfNeeded
//           → bun install (frozen=false)
//   Path B: server.ts:startGateway        → await waitForDeps
//           → ensureWorkspaceDeps         → bun install (frozen=true)
//
// Both detected the 25 missing top-level deps simultaneously. Bun 1.3.x
// uses atomic rename + hardlink/copy from its global cache, and two
// concurrent installs against the same `node_modules/` step on each
// other's temp files. The first install crashed with:
//   "FileNotFound: copying file dist/WasmPanicRegistry.js"
// Without `expo` actually installed, `expo export` was skipped, no
// `dist/` was produced, and the user saw nothing on preview.
//
// `runWorkspaceInstall` keeps a process-wide `Map<absoluteCwd, Promise>`
// of in-flight installs. The first caller starts `pkg.installAsync`; any
// concurrent caller for the same workspace joins that promise instead of
// kicking off a second `bun install`. If the install fails, we throw to
// every joined caller so they can each apply their own recovery (e.g.
// `ensureWorkspaceDeps` wipes `node_modules/` on failure).
// =============================================================================

const inFlightInstalls = new Map<string, Promise<void>>()

export interface RunWorkspaceInstallOptions {
  /**
   * Mirrors `pkg.installAsync`'s `frozen` flag. When two callers race,
   * the first caller's value wins (the second joins the in-flight
   * promise). In practice both callers operate on the same workspace
   * with the same `package.json`, so they'd produce identical
   * `node_modules/` either way; the stricter caller is just preferring
   * lockfile-respecting failure when the lockfile drifts.
   */
  frozen: boolean
}

/**
 * Run `pkg.installAsync(dir, opts)` exactly once per workspace at a time.
 * Concurrent callers for the same `dir` share the in-flight promise.
 * See file-level mutex doc for the failure mode this protects against.
 */
export async function runWorkspaceInstall(
  dir: string,
  opts: RunWorkspaceInstallOptions,
): Promise<void> {
  const key = resolvePath(dir)
  const existing = inFlightInstalls.get(key)
  if (existing) {
    console.log(
      `[workspace-defaults] install already in flight for ${key} — joining ` +
        `existing promise (frozen=${opts.frozen} caller is the second)`,
    )
    return existing
  }
  const promise = pkg.installAsync(dir, opts).finally(() => {
    inFlightInstalls.delete(key)
  })
  inFlightInstalls.set(key, promise)
  return promise
}

/**
 * Test-only: clear the in-flight map between cases. Calling this in
 * production code is a bug — it can drop a real in-flight install on
 * the floor.
 */
export function _resetWorkspaceInstallMutex(): void {
  inFlightInstalls.clear()
}
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
  // External (VS Code-style) projects: NEVER seed default workspace
  // files into the user's repo root. The user's tree gets:
  //   - `.shogo/` (skills/, plans/, local/, project.json, AGENTS.md)
  // and nothing else. Anything we'd add at the top level (App.tsx,
  // package.json, README.md, etc.) would conflict with the user's
  // existing scaffold or pollute a clean repo.
  //
  // The .shogo skeleton itself is already created in
  // RuntimeManager.ensureProjectDirectory for external projects, so
  // this branch is a no-op when the layout already matches. We re-run
  // the `mkdir -p` for each subdir so:
  //   - Old folders bound before a subdir was added still end up
  //     with the modern shape.
  //   - The user's existing `.shogo/project.json`, custom skills, or
  //     plans are left strictly untouched (no file writes in this
  //     branch — see test `pre-existing complete .shogo` for the
  //     enforced invariant).
  //
  // Pre-conditions on `.shogo` worth defending against:
  //
  //   1. **Broken symlink** — e.g. a stale `.shogo -> /tmp/shogo-local/<id>/.shogo`
  //      left over from a previous VM 9p mount. `removeStaleShogoSymlink`
  //      only deletes the link when its target is gone, so a *valid*
  //      symlink (e.g. user-curated `.shogo -> ../shared-shogo`) is
  //      preserved. Without this, `mkdirSync(recursive:true)` fails
  //      with ENOENT trying to traverse the dead link.
  //
  //   2. **`.shogo` is a regular file** — a Mac stray `.DS_Store`-shaped
  //      mistake, or a user who created a file by that name on purpose.
  //      `mkdirSync` would surface this as a cryptic ENOTDIR; we throw
  //      a clear, actionable error instead. We deliberately do NOT
  //      delete the file — the user might have something important
  //      there that they need to inspect before we touch anything.
  if (process.env.WORKING_MODE === 'external') {
    removeStaleShogoSymlink(dir)
    const shogoPath = join(dir, '.shogo')
    if (existsSync(shogoPath)) {
      const st = lstatSync(shogoPath)
      if (!st.isDirectory() && !st.isSymbolicLink()) {
        throw new Error(
          `Cannot bind external project: '${shogoPath}' exists and is not a directory. ` +
            `Shogo needs to create a '.shogo' folder there to store agent state. ` +
            `Move or rename the existing file (e.g. \`mv .shogo .shogo.bak\`), then re-open the folder.`,
        )
      }
    }
    mkdirSync(join(dir, '.shogo', 'skills'), { recursive: true })
    mkdirSync(join(dir, '.shogo', 'plans'), { recursive: true })
    mkdirSync(join(dir, '.shogo', 'local'), { recursive: true })
    return
  }

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
 * Seed workspace from a template. DEPRECATED — kept only as a no-op
 * shim while the consolidation rolls out. The marketplace install
 * flow's `copyWorkspaceFiles` already lays down everything this used
 * to copy (the source project's workspace was materialized with
 * exactly the same overlays at migration time). New callers should
 * not reach this function.
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
 * DEPRECATED. Kept only as a no-op shim during the templates →
 * marketplace consolidation rollout — both call-sites
 * (RuntimeManager, agent-runtime/server) were already removed. The
 * marketplace install flow stamps the same overlay bytes via
 * `copyWorkspaceFiles` from the source project's pre-merged
 * workspace, so reapplying it on every boot is now redundant.
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
 *   1. RUNTIME_TEMPLATE_DIR env override (any environment, escape hatch).
 *   2. `<dirname(process.execPath)>/runtime-template` — the
 *      "shipped-with-the-binary" location used by self-hosted cli-workers.
 *      The agent-runtime build pipeline post-compile-copies the template
 *      tree next to each binary so a single tarball ships both. Without
 *      this, a compiled standalone binary on a VPS has no way to find
 *      the template (its source-tree path resolves into the bundled
 *      virtual filesystem; `/app/templates/...` is a Docker convention
 *      that doesn't exist on a bare host).
 *   3. Relative to source tree (local dev: `__dirname` is
 *      `packages/agent-runtime/src/`).
 *   4. Adjacent to bundled server.js (VM guest: `__dirname` is
 *      `/opt/shogo/`).
 *   5. `/app/templates/runtime-template` — Docker / K8s convention.
 *   6. `/opt/shogo/templates/runtime-template` — VM pre-provisioned
 *      rootfs. Symlink target of the K8s path on the VM image.
 */
export function getRuntimeTemplatePath(): string | null {
  const envOverride = process.env.RUNTIME_TEMPLATE_DIR
  // When the operator explicitly points us at a template dir, treat that
  // choice as exclusive — falling through to the bundled candidates if
  // their dir doesn't yet exist would silently mask a misconfiguration
  // (and tests using a sentinel non-existent path to mean "no template
  // available here" would unexpectedly pick up the repo's checked-in
  // templates/runtime-template/ instead).
  if (envOverride !== undefined) {
    if (existsSync(join(envOverride, 'package.json'))) {
      try { return realpathSync(envOverride) } catch { return envOverride }
    }
    return null
  }
  let execAdjacent: string | null = null
  try {
    if (process.execPath) {
      execAdjacent = join(dirname(process.execPath), 'runtime-template')
    }
  } catch { /* execPath unavailable (e.g. test stub) */ }
  const candidates = [
    ...(execAdjacent ? [execAdjacent] : []),
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

// Files the runtime-template must ALWAYS provide, even when the full seed is
// skipped because the workspace already has a package.json. A workspace that
// has app code but no Prisma scaffold otherwise forces the agent to hand-roll
// `prisma/schema.prisma` and `prisma.config.ts` from scratch — which is
// error-prone: weaker models write a `migrate: { url() }` config (wrong shape)
// instead of `datasource: { url }`, so `prisma db push` fails with
// "datasource.url property is required" no matter how DATABASE_URL is set.
// Restoring the canonical template files closes that gap. Never overwrite an
// existing file — only fill genuine holes.
const RUNTIME_TEMPLATE_CRITICAL_FILES = [
  'prisma/schema.prisma',
  'prisma.config.ts',
]

/**
 * Copy the always-required runtime-template files into `dir` when they're
 * missing. Idempotent and non-destructive: files that already exist are left
 * untouched. Returns the list of files that were restored.
 *
 * Called both from the full {@link seedRuntimeTemplate} path (where it's a
 * no-op, since the full copy already placed them) and when that path is skipped
 * because a `package.json` is present — the latter is the case that actually
 * needs it (a pre-existing workspace missing only its Prisma scaffold).
 */
export function restoreMissingRuntimeTemplateFiles(dir: string): string[] {
  const templatePath = getRuntimeTemplatePath()
  if (!templatePath) return []
  const restored: string[] = []
  for (const rel of RUNTIME_TEMPLATE_CRITICAL_FILES) {
    const dest = join(dir, rel)
    if (existsSync(dest)) continue
    const src = join(templatePath, rel)
    if (!existsSync(src)) continue
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    restored.push(rel)
  }
  if (restored.length > 0) {
    console.log(`[workspace-defaults] Restored missing runtime-template files: ${restored.join(', ')}`)
  }
  return restored
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
  if (existsSync(join(dir, 'package.json'))) {
    // Full seed was already done (or the workspace pre-exists). Still ensure
    // the critical Prisma scaffold is present so the agent never has to invent
    // prisma.config.ts / schema.prisma from scratch.
    restoreMissingRuntimeTemplateFiles(dir)
    return false
  }

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
  /**
   * Optional one-click shell commands surfaced in the IDE's terminal rail.
   * Layered on top of `package.json#scripts` and file-probe presets by
   * `buildQuickCommands()` in `quick-commands.ts`. Stack-defined entries
   * win over colliding script-derived entries with the same `id`, letting
   * a stack tune labels/timeouts (e.g. python-data's `pip-install-requirements`
   * uses a longer timeout than the file-probe default).
   */
  quickCommands?: Array<{
    id: string
    label: string
    description?: string
    command: string
    category: 'package' | 'database' | 'server' | 'test' | 'build' | 'lint'
    dangerous?: boolean
    timeout?: number
  }>
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

// Public re-exports of the in-module platform helpers. PreviewManager.
// installDepsIfNeeded needs to consult the same marker to detect
// cross-platform install reuse (host installs as darwin-arm64, VM
// guest mounts the same node_modules as linux-arm64, install-marker
// hash still matches because package.json didn't change — without
// this check the in-VM install short-circuits and the missing
// linux-arm64 rollup/esbuild/swc natives blow up the next vite build).
export { PLATFORM_TAG as INSTALL_PLATFORM_TAG }
export function readInstallPlatformMarker(dir: string): string | null {
  return readPlatformMarker(dir)
}
export function writeInstallPlatformMarker(dir: string): void {
  writePlatformMarker(dir)
}

/**
 * Whether the workspace's `package.json` declares Vite (or a vite-
 * dependent plugin) as a dep. Used to gate the `existsSync(viteBin)`
 * fast paths in `ensureWorkspaceDeps`: a workspace pre-seeded by the
 * Vite warm-pool template and then overlaid with a non-Vite import
 * (e.g. an Expo project) has the bin without the dep, and trusting
 * the bin alone leads to the cloud Expo "kind of works but never
 * rebuilds" bug. Best-effort: any read/parse failure returns false
 * (the conservative choice — we'd rather attempt an install than
 * incorrectly skip one).
 */
export function workspaceUsesVite(dir: string): boolean {
  try {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) return false
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    return !!(deps.vite || deps['@vitejs/plugin-react'])
  } catch {
    return false
  }
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
 * Return the names of top-level dependencies declared in `package.json`
 * (both `dependencies` and `devDependencies`) that are NOT present as
 * directories under `node_modules/`. Used to decide whether an existing
 * `node_modules/` is actually trustworthy when no install marker is on
 * disk — a partial or crashed prior install leaves `node_modules/`
 * present but missing key packages (vite, @shogo-ai/sdk, etc.), and
 * we'd otherwise stamp that broken state as "good".
 *
 * Cheap: one `existsSync` per declared dep, capped at the number of
 * names actually in package.json. Skips git/protocol/file specifiers
 * — those don't map to a deterministic `node_modules/<name>` path —
 * and tolerates a missing or unreadable package.json by returning
 * an empty list (no false-positive reinstalls).
 */
export function findMissingTopLevelDeps(dir: string): string[] {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return []

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) }
  catch { return [] }

  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const nodeModules = join(dir, 'node_modules')
  if (!existsSync(nodeModules)) return Object.keys(allDeps)

  const missing: string[] = []
  for (const [name, spec] of Object.entries(allDeps)) {
    // Skip non-registry specifiers — those don't always materialise as
    // `node_modules/<name>` (workspace:*, file:, git+, etc. may resolve
    // to symlinks or alternative layouts that aren't worth probing).
    if (typeof spec === 'string' && /^(file:|link:|workspace:|git\+|https?:|github:)/.test(spec)) continue
    if (!existsSync(join(nodeModules, name, 'package.json'))) {
      missing.push(name)
    }
  }
  return missing
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
 * Compare two `x.y.z` semver strings numerically. Returns >0 if a > b,
 * <0 if a < b, 0 if equal. Treats pre-release/build suffixes as the
 * lowest-precedence component (we just strip them) — good enough for
 * pin migrations where the only callers feed clean release numbers
 * pulled from npm and from the bundled runtime-template's package.json.
 */
function compareSemver(a: string, b: string): number {
  const parse = (s: string) => s.replace(/[+-].*$/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const [aMaj, aMin, aPat] = parse(a)
  const [bMaj, bMin, bPat] = parse(b)
  return (aMaj - bMaj) || (aMin - bMin) || (aPat - bPat)
}

/**
 * Heal legacy `@shogo-ai/sdk` pins and `generate` scripts in a user's
 * workspace `package.json`.
 *
 * Why this exists: projects bootstrapped pre-May 2026 shipped with
 *   "@shogo-ai/sdk": "^0.4.0"
 *   "generate":     "bunx shogo generate"
 *
 * That combination is permanently broken on every macOS install:
 *   1. `bunx shogo` resolves to the only published 0.4.x — `0.4.0` —
 *      because the registry jumps 0.4.0 → 1.0.0 with no patch
 *      in between (0.4.1 was tagged internally but never published).
 *   2. The published 0.4.0 CLI does `execSync(\`bun ${absScriptPath}\`)`
 *      which `/bin/sh` tokenizes on whitespace, truncating workspace
 *      paths under `~/Library/Application Support/Shogo/...` and
 *      crashing with `Module not found "/Users/<u>/Library/Application"`.
 *
 * Once an install is on the broken pin, no amount of `bun install`
 * rescues it — the only working npm version that satisfies `^0.4.0`
 * really is 0.4.0. The only fix is to rewrite the pin to a non-broken
 * line.
 *
 * Behaviour:
 *
 *   - If the workspace pins a version of `@shogo-ai/sdk` strictly less
 *     than what the bundled runtime-template carries, rewrite the pin
 *     to `^${bundled-version}`. The new pin matches the SDK that the
 *     desktop app's own runtime-template/node_modules is built against,
 *     so we ship a known-working pair.
 *   - If the workspace's `scripts.generate` matches the legacy
 *     `bunx shogo …` / `bun x shogo …` shape, rewrite it to the
 *     path-based form
 *     `bun ./node_modules/@shogo-ai/sdk/bin/cli.mjs generate`. The
 *     path form skips bunx's npm-cache lookup entirely and stays
 *     space-safe (no shell tokenization — Bun handles argv directly).
 *
 * Side-effects: writes back the modified `package.json`. Because
 * `ensureWorkspaceDeps`'s install-marker is a sha256 of that file,
 * the next call after migration trips a fresh install — exactly what
 * we want to pull the upgraded SDK into `node_modules/`.
 *
 * Safe to call repeatedly: bails when nothing needs fixing and never
 * downgrades existing healthy pins.
 */
export function migrateLegacyShogoSdkPin(dir: string): { upgraded: boolean; before?: string; after?: string; scriptRewritten?: boolean } {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return { upgraded: false }

  let raw: string
  try { raw = readFileSync(pkgPath, 'utf-8') } catch { return { upgraded: false } }

  let pkgJson: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    scripts?: Record<string, string>
  }
  try { pkgJson = JSON.parse(raw) } catch { return { upgraded: false } }

  // The bundled runtime-template is the source of truth for the "good"
  // SDK version — its node_modules/ ships pre-installed in the desktop
  // app, so whatever it pins is guaranteed to resolve.
  let templateSdkVersion: string | null = null
  const templatePath = getRuntimeTemplatePath()
  if (templatePath) {
    try {
      const templatePkg = JSON.parse(readFileSync(join(templatePath, 'package.json'), 'utf-8'))
      const range = templatePkg.dependencies?.['@shogo-ai/sdk'] ?? templatePkg.devDependencies?.['@shogo-ai/sdk']
      if (typeof range === 'string') {
        // Strip leading range operators (^, ~, >=, etc.) to get a
        // concrete version for comparison.
        const m = range.match(/(\d+\.\d+\.\d+)/)
        if (m) {
          templateSdkVersion = m[1]
        } else if (range.startsWith('workspace:')) {
          // Source (unmaterialized) template — `@shogo-ai/sdk` is the
          // `workspace:*` sentinel, which carries no concrete version.
          // This only happens in a dev checkout where getRuntimeTemplatePath
          // resolves to the source tree (shipped templates are always
          // materialized to a concrete `^X.Y.Z` first). Best-effort: read the
          // sibling monorepo SDK version so dev workspaces still heal; if the
          // package isn't co-located, fall through to a clean no-op.
          try {
            const repoSdkPkg = JSON.parse(
              readFileSync(join(templatePath, '..', '..', 'packages', 'sdk', 'package.json'), 'utf-8'),
            )
            if (typeof repoSdkPkg.version === 'string') templateSdkVersion = repoSdkPkg.version
          } catch { /* no co-located packages/sdk — leave null, migration no-ops */ }
        }
      }
    } catch { /* template package.json missing/malformed — no upgrade target */ }
  }

  let changed = false
  let beforePin: string | undefined
  let afterPin: string | undefined
  let scriptRewritten = false

  // 1. Pin migration.
  const userSdkRange = pkgJson.dependencies?.['@shogo-ai/sdk']
  if (userSdkRange && templateSdkVersion) {
    const userVerMatch = userSdkRange.match(/(\d+\.\d+\.\d+)/)
    const userVer = userVerMatch?.[1]
    // Upgrade if either:
    //   - user's pin is older than the bundled SDK (compareSemver < 0)
    //   - user's pin is the known-broken 0.4.0 (exact match — same
    //     compareSemver result, but we log it explicitly so we know
    //     we're healing the bug, not just bumping for fun)
    if (userVer && compareSemver(userVer, templateSdkVersion) < 0) {
      const newRange = `^${templateSdkVersion}`
      pkgJson.dependencies!['@shogo-ai/sdk'] = newRange
      beforePin = userSdkRange
      afterPin = newRange
      changed = true
      console.log(
        `[workspace-defaults] migrateLegacyShogoSdkPin: ` +
        `upgrading @shogo-ai/sdk ${userSdkRange} → ${newRange} in ${pkgPath}`,
      )
    }
  }

  // 2. Script rewrite.
  const gen = pkgJson.scripts?.generate?.trim()
  if (gen && /^(bunx|bun\s+x)(\s+--bun)?\s+shogo(\s|$)/.test(gen)) {
    const safeGen = 'bun ./node_modules/@shogo-ai/sdk/bin/cli.mjs generate'
    pkgJson.scripts!.generate = safeGen
    scriptRewritten = true
    changed = true
    console.log(
      `[workspace-defaults] migrateLegacyShogoSdkPin: ` +
      `rewrote broken \`bunx shogo generate\` script to path-safe form in ${pkgPath}`,
    )
  }

  if (!changed) return { upgraded: false }

  // Preserve a trailing newline if the original file had one — many
  // tools (git, eslint, prettier) treat its absence as a diff.
  const trailingNewline = raw.endsWith('\n') ? '\n' : ''
  try {
    writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + trailingNewline)
  } catch (err: any) {
    console.error(`[workspace-defaults] migrateLegacyShogoSdkPin: failed to write ${pkgPath}: ${err.message}`)
    return { upgraded: false }
  }

  // Pin upgrade is meaningless if the stale `node_modules/@shogo-ai/sdk`
  // stays on disk — bun install with a cached lockfile may decline to
  // reinstall what's already there, and the next launch's
  // `findMissingTopLevelDeps` check still sees the directory and skips
  // the install. Wipe the installed SDK so the upgrade actually
  // materialises on the next `bun install`. We also drop the install
  // marker so PreviewManager.installDepsIfNeeded can't short-circuit
  // through its hash-match fast path on the rewritten package.json.
  if (afterPin) {
    try {
      const sdkDir = join(dir, 'node_modules', '@shogo-ai', 'sdk')
      if (existsSync(sdkDir)) {
        rmSync(sdkDir, { recursive: true, force: true })
        console.log(
          `[workspace-defaults] migrateLegacyShogoSdkPin: cleared stale ${sdkDir} so reinstall picks up the upgrade`,
        )
      }
    } catch (err: any) {
      console.warn(`[workspace-defaults] migrateLegacyShogoSdkPin: could not clear stale SDK: ${err.message}`)
    }
    clearInstallMarker(dir)
  }

  return { upgraded: !!afterPin, before: beforePin, after: afterPin, scriptRewritten }
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
export async function ensureWorkspaceDeps(dir: string): Promise<{ didInstall: boolean }> {
  if (!existsSync(join(dir, 'package.json'))) return { didInstall: false }

  // Run BEFORE the install-marker check so an upgrade trips a reinstall
  // (the marker is a sha256 of package.json — rewriting the SDK pin or
  // the `generate` script changes the hash and forces install to run).
  migrateLegacyShogoSdkPin(dir)

  const viteBin = join(dir, 'node_modules', '.bin', 'vite')
  const nodeModules = join(dir, 'node_modules')

  // Does the workspace's package.json actually depend on Vite? We need
  // this to gate the `existsSync(viteBin)` fast-paths below: a
  // workspace pre-seeded with the Vite/react-app warm-pool template
  // and then overlaid with a non-Vite import (e.g. Expo) will have a
  // leftover `.bin/vite` shim with no corresponding dep in the
  // current package.json. Returning early in that case leaves the
  // workspace with the warm pod's Vite node_modules instead of the
  // user's real deps — surfaced as the 2026-05-12 imported-Expo
  // "kind of works but never rebuilds" bug. The `workspacePkgUsesVite`
  // check that already exists below (around the template-copy fast
  // path) needs to gate these two earlier shortcuts too. Inlined
  // close to the call sites so the gating reads as a single decision.
  const workspaceDependsOnVite = workspaceUsesVite(dir)

  // Check for wrong-platform modules (e.g. macOS host-mounted into Linux VM)
  const installedPlatform = readPlatformMarker(dir)
  if (installedPlatform && installedPlatform !== PLATFORM_TAG) {
    console.log(`[workspace-defaults] node_modules built for ${installedPlatform}, need ${PLATFORM_TAG} — reinstalling`)
    try { rmSync(nodeModules, { recursive: true, force: true }) } catch {}
  } else if (existsSync(viteBin) && workspaceDependsOnVite) {
    if (installedPlatform === PLATFORM_TAG) return { didInstall: false }
    // No marker — check for wrong-platform native binaries (rollup)
    if (!installedPlatform && existsSync(nodeModules)) {
      const wrongPlatform = detectWrongPlatformNativeDeps(dir)
      if (wrongPlatform) {
        console.log(`[workspace-defaults] Detected ${wrongPlatform} native deps, need ${PLATFORM_TAG} — reinstalling`)
        try { rmSync(nodeModules, { recursive: true, force: true }) } catch {}
      } else {
        writePlatformMarker(dir)
        return { didInstall: false }
      }
    }
  } else if (existsSync(viteBin) && !workspaceDependsOnVite) {
    // Defensive log so production can see at a glance when a
    // hybrid-state workspace (Vite leftover bin + non-Vite
    // package.json) was correctly NOT short-circuited.
    console.log(
      `[workspace-defaults] Found leftover .bin/vite but package.json doesn't depend on vite — falling through to install`,
    )
  }

  // Non-Vite stacks (Expo, React Native, etc.) don't have a `vite` bin to
  // probe, but we *do* have the install-marker (sha256 of package.json)
  // shared with PreviewManager.installDepsIfNeeded. If node_modules is
  // present and the marker matches the current package.json, skip the
  // install — this is the equivalent of the `existsSync(viteBin)` fast path
  // above but for stacks that don't use Vite.
  //
  // Without this short-circuit we'd run `npm install` on every restart for
  // every Expo project (idempotent but slow: ~30-90s on Windows). It also
  // means `bun add <pkg>` made by the agent — which updates package.json's
  // hash — correctly trips a single reinstall on the next start, exactly
  // the same gating PreviewManager uses.
  if (existsSync(nodeModules) && (!installedPlatform || installedPlatform === PLATFORM_TAG)) {
    const expectedHash = computePackageJsonHash(dir)
    const recordedHash = readInstallMarker(dir)
    if (expectedHash != null && recordedHash != null && expectedHash === recordedHash) {
      // Trust-but-verify (see same comment in preview-manager.ts):
      // in cloud, the marker travels with the workspace archive but
      // `node_modules/` does not. A pod that installed deps + wrote the
      // marker, then crashed before its deps-cache upload landed, leaves
      // the next pod with a marker whose hash matches package.json but
      // a `node_modules/` from the warm-pool's Vite template (which is
      // missing every Expo / @react-three / etc. dep). Without this
      // probe the install short-circuit fires, the bundler can't find
      // its bin (`node_modules/.bin/expo`) or imports (`expo`,
      // `@react-three/fiber`), and the build never recovers — exactly
      // the staging symptom on 9e7ecdc7-... seen on 2026-05-13.
      const missing = findMissingTopLevelDeps(dir)
      if (missing.length === 0) {
        if (!installedPlatform) writePlatformMarker(dir)
        console.log('[workspace-defaults] install-marker matches package.json — skipping reinstall')
        return { didInstall: false }
      }
      console.log(
        `[workspace-defaults] install-marker matches but ${missing.length} declared dep(s) missing from node_modules (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}) — marker is stale, running install`,
      )
      // fall through to install
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
  const workspacePkgUsesVite = workspaceDependsOnVite
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
        return { didInstall: false }
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
  try {
    await runWorkspaceInstall(dir, { frozen: true })
  } catch (err) {
    // If install fails (timeout, crash) it can leave a partially-populated
    // node_modules behind. PreviewManager / subsequent reads will then hit
    // ENOENT for files like @prisma/internals/dist/cli/getSchema.js (see
    // production main.log) because lower-level packages were never finished.
    // Wipe the partial tree so the next launch retries from a clean state.
    try {
      console.warn('[workspace-defaults] Install failed — clearing partial node_modules so the next launch retries clean')
      rmSync(nodeModules, { recursive: true, force: true })
    } catch {}
    throw err
  }
  writePlatformMarker(dir)
  // Record the install marker so PreviewManager.installDepsIfNeeded sees
  // a hash match on its first run and skips redundant reinstall — this
  // is what made stack switches (Vite → Expo) trip the "package.json
  // hash changed" path even though we just installed the right deps.
  writeInstallMarker(dir)
  console.log('[workspace-defaults] Workspace dependencies installed')
  return { didInstall: true }
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
