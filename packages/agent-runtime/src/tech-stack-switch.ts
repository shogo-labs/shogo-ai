// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tech-stack switching, in one place.
 *
 * Three callers used to do their own version of this — the Capabilities panel
 * (`POST /agent/workspace/reset-stack`), the GitHub import path (a repo's files
 * replace the starter, so the stack is re-detected) and the Git checkout path.
 * They drifted. Everything that applies a stack change to a workspace on disk
 * now goes through `applyTechStackChange()`:
 *
 *   1. (optional) wipe the previous stack's files — `resetFiles: true` only;
 *   2. seed the new stack's starter (missing files only) + `.tech-stack`;
 *   3. update the env the runtime reads the stack from, because
 *      `resolveWorkspaceTechStackId()` prefers `TECH_STACK_ID` /
 *      `WORKSPACE_TECH_STACKS` over the `.tech-stack` marker — a marker-only
 *      switch is a no-op in a cloud pod;
 *   4. restart that project's preview so the new stack's build is what serves.
 *
 * The preview restart is injected: this module is a leaf (project-tools imports
 * it), while the preview managers live in `server.ts`. `server.ts` registers
 * `restartPreviewForStack` here at boot.
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  getTechStackPath,
  loadTechStackMeta,
  readTechStackMarker,
  runtimeTemplateTopLevelEntries,
  seedRuntimeTemplate,
  seedTechStack,
  wipeProjectFiles,
  writeTechStackDoc,
} from './workspace-defaults'

/** Whether `projectDir` is the runtime's own workspace root or a member folder. */
export type TechStackScope = 'root' | 'member'

export interface PreviewRestartRequest {
  projectDir: string
  /** Member project id; the root's id is only informational. */
  projectId: string
  scope: TechStackScope
  stackId: string
}

type PreviewRestarter = (req: PreviewRestartRequest) => void

let previewRestarter: PreviewRestarter | null = null

/**
 * Register how a stack change restarts a preview. Called once by `server.ts`
 * at boot; `null` unregisters (tests).
 */
export function setTechStackPreviewRestarter(fn: PreviewRestarter | null): void {
  previewRestarter = fn
}

export interface ApplyTechStackChangeInput {
  projectDir: string
  /** Project id of the workspace being changed. */
  projectId: string
  stackId: string
  /**
   * `root` when `projectDir` is the runtime's `WORKSPACE_DIR`; `member` for an
   * attached project's own folder. Defaults to comparing against
   * `process.env.WORKSPACE_DIR`.
   */
  scope?: TechStackScope
  /**
   * Delete the current project code before seeding (the destructive reset the
   * Capabilities panel offers). Leaves `.shogo/`, `memory/`, `.git/` and
   * `.canvas-state.json` alone — see `WIPE_PRESERVE_TOP_LEVEL`.
   */
  resetFiles?: boolean
}

/** Why a stack change was refused before it touched anything. */
export type TechStackChangeErrorCode =
  | 'stack_change_needs_reset'
  | 'unknown_stack'
  | 'missing_folder'
  | 'seed_failed'

/**
 * What a stack change would do, decided before anything is written.
 * `needsReset` means the switch collides with the project's own files, and
 * applying it would leave a project that is half one stack and half the other.
 */
export interface TechStackChangePlan {
  /** Marker value we found (`''` when the project has none yet). */
  from: string
  to: string
  /**
   * Existing top-level entries the new stack would write — its own `starter/`
   * entries, the files the bundled runtime-template provides, and
   * `package.json`, which the Vite re-seed edits in place rather than
   * overwriting.
   */
  collisions: string[]
  /** True when `collisions` is non-empty and `resetFiles` was not passed. */
  needsReset: boolean
  /** Existing top-level entries the new stack does not write: they stay put. */
  leftInPlace: string[]
}

export interface ApplyTechStackChangeResult extends TechStackChangePlan {
  ok: boolean
  stackId: string
  /** Set on failure; `stack_change_needs_reset` is the refusal. */
  code?: TechStackChangeErrorCode
  /** Top-level starter entries written. */
  seeded: boolean
  /** Top-level entries removed by `resetFiles`; `null` when nothing was wiped. */
  wiped: number | null
  /** Whether `.shogo/STACK.md` was replaced with the new stack's doc. */
  stackDocUpdated: boolean
  /** Whether the runtime env the stack resolves from was updated. */
  envUpdated: boolean
  previewRestarted: boolean
  error?: string
  /** What the caller should do instead, when `code` is set. */
  hint?: string
}

function scopeOf(projectDir: string, explicit?: TechStackScope): TechStackScope {
  if (explicit) return explicit
  const root = process.env.WORKSPACE_DIR || process.env.AGENT_DIR
  return root && projectDir !== root ? 'member' : 'root'
}

/** Top-level entries a stack's starter would write into a workspace. */
function starterEntries(stackId: string): string[] {
  const stackPath = getTechStackPath(stackId)
  if (!stackPath) return []
  const starterDir = join(stackPath, 'starter')
  if (!existsSync(starterDir)) return []
  try {
    return readdirSync(starterDir)
  } catch {
    return []
  }
}

/**
 * Every top-level entry seeding `stackId` into a workspace would write.
 *
 * A stack declares its files in one of two places — its own `starter/`, or (for
 * Vite-family stacks, which declare `runtime.devServer: 'vite'`) the bundled
 * runtime-template. Both have to be counted: `react-app` has no `starter/` at
 * all.
 */
export function seedEntries(stackId: string): string[] {
  const entries = new Set(starterEntries(stackId))
  if (writesPackageJson(stackId)) {
    for (const entry of runtimeTemplateTopLevelEntries()) entries.add(entry)
  }
  return [...entries].sort()
}

/**
 * Whether seeding this stack edits an existing `package.json` in place rather
 * than skipping it: `seedRuntimeTemplate()` adds the `@shogo-ai/sdk` pin on top
 * of whatever the project already declares.
 */
function writesPackageJson(stackId: string): boolean {
  return loadTechStackMeta(stackId)?.runtime?.devServer === 'vite'
}

/**
 * Top-level entries the runtime owns rather than the project: they are never
 * part of a stack's write set, and `wipeProjectFiles()` keeps them, so they are
 * neither collisions nor "left in place". `.tech-stack` is the marker the switch
 * itself writes.
 */
const HOUSEKEEPING_ENTRIES = new Set([
  '.shogo',
  '.tech-stack',
  'memory',
  '.git',
  'node_modules',
  'dist',
  '.canvas-state.json',
])

function topLevelEntries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Decide what switching `projectDir` to `stackId` would do. Pure: reads the
 * folder and the stack catalogue, writes nothing, touches no env and no preview.
 *
 * A collision is the whole reason this exists. `seedTechStack()` only fills
 * paths that do not exist, so a switch into a project that already has files
 * silently lands half of the new stack (`index.html`, `src/`, `.gitignore`
 * survive, `prisma/` and a `@shogo-ai/sdk` pin appear) and the project is left
 * in a state that is neither stack. Those switches are refused instead;
 * `resetFiles: true` is the only way through them.
 */
export function planTechStackChange(input: {
  projectDir: string
  stackId: string
  resetFiles?: boolean
}): TechStackChangePlan {
  const entries = seedEntries(input.stackId)
  const existing = new Set(topLevelEntries(input.projectDir))
  const collisions = entries.filter((entry) => existing.has(entry))
  // `package.json` counts whenever the seed would edit it, even if a future
  // template stops listing it — that edit is the silent one.
  if (writesPackageJson(input.stackId) && existing.has('package.json') && !collisions.includes('package.json')) {
    collisions.push('package.json')
  }
  const leftInPlace = input.resetFiles
    ? []
    : topLevelEntries(input.projectDir)
        .filter((entry) => !HOUSEKEEPING_ENTRIES.has(entry) && !entries.includes(entry))
        .sort()
  return {
    from: readTechStackMarker(input.projectDir),
    to: input.stackId,
    collisions: collisions.sort(),
    needsReset: collisions.length > 0 && input.resetFiles !== true,
    leftInPlace,
  }
}

/** The one sentence a refused switch should carry, in the tool and in the API. */
export function stackChangeRefusalHint(plan: TechStackChangePlan): string {
  const shown = plan.collisions.slice(0, 6).join(', ')
  const more = plan.collisions.length > 6 ? `, +${plan.collisions.length - 6} more` : ''
  return (
    `"${plan.to}" would write ${plan.collisions.length} entr${plan.collisions.length === 1 ? 'y' : 'ies'} that already exist ` +
    `in this project (${shown}${more}), so nothing was changed. Pass resetFiles: true to delete the current project code ` +
    `first and seed "${plan.to}" clean (agent identity, memory, git history and canvas state survive), ` +
    `or stay on "${plan.from || 'the current stack'}".`
  )
}

/**
 * Point `TECH_STACK_ID` (root) / `WORKSPACE_TECH_STACKS[projectId]` (member) at
 * the new stack, so the next `resolveWorkspaceTechStackId()` agrees with the
 * marker we (or the GitHub import) wrote. Returns true when a value actually
 * changed.
 */
export function syncTechStackEnv(
  projectId: string,
  stackId: string,
  scope: TechStackScope,
): boolean {
  if (scope === 'root') {
    if (process.env.TECH_STACK_ID === stackId) return false
    // Only overwrite an existing var: a desktop single-project runtime has no
    // TECH_STACK_ID at all and resolves from `.tech-stack` alone.
    if (!process.env.TECH_STACK_ID) return false
    process.env.TECH_STACK_ID = stackId
    return true
  }
  let stacks: Record<string, string> = {}
  try {
    const parsed = JSON.parse(process.env.WORKSPACE_TECH_STACKS || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      stacks = parsed as Record<string, string>
    }
  } catch {
    stacks = {}
  }
  if (stacks[projectId] === stackId) return false
  process.env.WORKSPACE_TECH_STACKS = JSON.stringify({ ...stacks, [projectId]: stackId })
  return true
}

/**
 * Apply a stack change to a workspace that is reachable on this runtime.
 * Never throws: an unknown stack, a colliding switch or an unwritable folder
 * comes back as `{ ok: false, code, error }` so the caller can report it
 * instead of pretending. A refusal writes nothing at all — no marker, no seed,
 * no `.shogo/` write, no env, no restart.
 */
export function applyTechStackChange(input: ApplyTechStackChangeInput): ApplyTechStackChangeResult {
  const stackId = input.stackId?.trim()
  const projectId = input.projectId || basename(input.projectDir)
  const scope = scopeOf(input.projectDir, input.scope)
  const base: ApplyTechStackChangeResult = {
    ok: false,
    stackId,
    seeded: false,
    wiped: null,
    stackDocUpdated: false,
    envUpdated: false,
    previewRestarted: false,
    from: '',
    to: stackId,
    collisions: [],
    needsReset: false,
    leftInPlace: [],
  }

  if (!stackId) return { ...base, code: 'unknown_stack', error: 'stackId is required' }
  if (!getTechStackPath(stackId)) {
    return { ...base, code: 'unknown_stack', error: `Unknown tech stack: ${stackId}` }
  }
  if (!existsSync(input.projectDir)) {
    return { ...base, code: 'missing_folder', error: `Project folder does not exist: ${input.projectDir}` }
  }

  const plan = planTechStackChange({
    projectDir: input.projectDir,
    stackId,
    resetFiles: input.resetFiles,
  })
  if (plan.needsReset) {
    const hint = stackChangeRefusalHint(plan)
    console.log(
      `[tech-stack-switch] ${projectId}: refusing ${plan.from || '(none)'} -> ${stackId} — ` +
        `${plan.collisions.length} collision(s): ${plan.collisions.join(', ')}`,
    )
    return {
      ...base,
      ...plan,
      ok: false,
      code: 'stack_change_needs_reset',
      error: `Switching to "${stackId}" would overwrite ${plan.collisions.length} existing entr${
        plan.collisions.length === 1 ? 'y' : 'ies'
      }: ${plan.collisions.join(', ')}`,
      hint,
    }
  }

  let wiped: number | null = null
  if (input.resetFiles) wiped = wipeProjectFiles(input.projectDir)

  const seeded = seedTechStack(input.projectDir, stackId)
  if (!seeded) {
    return { ...base, ...plan, code: 'seed_failed', wiped, error: `Failed to seed tech stack ${stackId}` }
  }

  // `.shogo/` survives `wipeProjectFiles()`, and `seedTechStack()` only fills
  // STACK.md when it is missing — so on a switch it would keep describing the
  // stack the marker just left. Replace it, but leave `.shogo/AGENTS.md` (agent
  // identity) and the rest of `.shogo/` alone.
  const stackDocUpdated = plan.from !== stackId
    ? writeTechStackDoc(input.projectDir, stackId, { overwrite: true })
    : false

  // Vite-family stacks borrow the bundled runtime template (vite + react +
  // tailwind + the Hono/Prisma sidecar); whether a stack is one is declared in
  // its own stack.json rather than hard-coded here.
  if (writesPackageJson(stackId)) {
    seedRuntimeTemplate(input.projectDir)
  }

  const envUpdated = syncTechStackEnv(projectId, stackId, scope)

  let previewRestarted = false
  if (previewRestarter) {
    try {
      previewRestarter({ projectDir: input.projectDir, projectId, scope, stackId })
      previewRestarted = true
    } catch (err: any) {
      console.warn(`[tech-stack-switch] preview restart failed: ${err?.message ?? err}`)
    }
  }

  console.log(
    `[tech-stack-switch] ${projectId}: ${stackId} (scope=${scope}, ` +
      `resetFiles=${input.resetFiles === true}, wiped=${wiped ?? 0}, ` +
      `leftInPlace=${plan.leftInPlace.length}, stackDoc=${stackDocUpdated})`,
  )

  return {
    ...base,
    ...plan,
    ok: true,
    seeded,
    wiped,
    // Nothing collided: either there was nothing there, or `resetFiles` cleared
    // it. The plan's collision list is only meaningful on the refusal path.
    collisions: [],
    stackDocUpdated,
    envUpdated,
    previewRestarted,
  }
}
