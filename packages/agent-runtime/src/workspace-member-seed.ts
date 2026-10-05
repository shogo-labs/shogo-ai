// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Starter seeding for the ANCHOR member of a workspace runtime.
 *
 * A single-project runtime seeds its tech stack + runtime template into
 * `WORKSPACE_DIR` at boot. A workspace runtime deliberately skips that
 * (the root holds sibling project folders, not one app), and relies on each
 * member's durable archive to populate `<WORKSPACE_DIR>/<projectId>/`. A
 * brand-new project has no archive, so its folder stays empty, the anchor
 * preview has no `package.json` to build, and `/api/preview/:id/open` polls
 * forever.
 *
 * These helpers give the anchor folder the same starter a single-project
 * runtime would have had — but only when the folder has no project source,
 * so they can never clobber real content.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedRuntimeTemplate, seedTechStack } from './workspace-defaults'

const VITE_STACK_IDS = new Set(['react-app', 'threejs-game', 'phaser-game'])

/** Entries that can exist in a member folder before any project source does. */
const NON_SOURCE_ENTRIES = new Set(['.git', '.shogo', 'node_modules', '.DS_Store'])

/** True when `dir` holds anything that looks like project source. */
export function memberHasProjectSource(dir: string): boolean {
  if (!existsSync(dir)) return false
  return readdirSync(dir).some((entry) => !NON_SOURCE_ENTRIES.has(entry))
}

/**
 * Pick the anchor's tech stack from `WORKSPACE_TECH_STACKS` (a JSON map of
 * projectId → techStackId set by the API). Returns undefined when absent or
 * malformed, which seeds the default Vite runtime template.
 */
export function resolveMemberTechStackId(
  projectId: string,
  raw: string | undefined = process.env.WORKSPACE_TECH_STACKS,
): string | undefined {
  if (!raw) return undefined
  try {
    const map = JSON.parse(raw)
    const id = map && typeof map === 'object' ? map[projectId] : undefined
    return typeof id === 'string' && id.trim() ? id.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Stamp a member folder's `.tech-stack` from the project's settings, the
 * workspace counterpart of `applyEnvTechStackMarker`. Settings are the source
 * of truth, so a project switched to another stack (or restored with a stale
 * marker) previews with the stack it is set to. Returns true when it wrote.
 */
export function applyMemberTechStackMarker(
  dir: string,
  projectId: string,
  raw: string | undefined = process.env.WORKSPACE_TECH_STACKS,
): boolean {
  const techStackId = resolveMemberTechStackId(projectId, raw)
  if (!techStackId || !existsSync(dir)) return false
  const markerPath = join(dir, '.tech-stack')
  try {
    if (existsSync(markerPath) && readFileSync(markerPath, 'utf-8').trim() === techStackId) return false
    writeFileSync(markerPath, techStackId, 'utf-8')
    return true
  } catch (err: any) {
    console.warn(`[workspace-member-seed] Failed to stamp .tech-stack for ${projectId}: ${err?.message ?? err}`)
    return false
  }
}

export interface SeedMemberResult {
  seeded: boolean
  techStackId?: string
}

/**
 * Seed the starter into a member folder that has no project source. A no-op
 * (seeded: false) when the folder already has source.
 */
export function seedEmptyWorkspaceMember(dir: string, techStackId?: string): SeedMemberResult {
  mkdirSync(dir, { recursive: true })
  if (memberHasProjectSource(dir)) return { seeded: false, techStackId }

  if (techStackId) seedTechStack(dir, techStackId)
  if (!techStackId || VITE_STACK_IDS.has(techStackId)) seedRuntimeTemplate(dir)

  return { seeded: memberHasProjectSource(dir), techStackId }
}

export interface AnchorSeedDecisionInput {
  /** Explicit `WORKSPACE_ANCHOR_PROJECT_ID` — never the ids[0] fallback. */
  anchorProjectId: string | undefined
  /** Projects this runtime serves. */
  memberProjectIds: string[]
  /**
   * Members confirmed to have no durable source: by a clean in-guest download,
   * or, under host-mediated durability, by the host's own lookup
   * (`WORKSPACE_NEW_PROJECT_IDS`).
   */
  newProjectIds: string[]
}

/**
 * Whether the anchor folder may be seeded. Only when its durable source is
 * confirmed absent. A failed or skipped lookup never qualifies, and neither
 * does "the host will overlay the backup afterwards": projects seeded ahead of
 * that overlay have come back with every file they share with the starter
 * (`app/index.tsx`, `package.json`, `prisma/dev.db`, ...) reverted to it.
 */
export function shouldSeedAnchorMember(input: AnchorSeedDecisionInput): boolean {
  const anchor = input.anchorProjectId?.trim()
  if (!anchor || !input.memberProjectIds.includes(anchor)) return false
  return input.newProjectIds.includes(anchor)
}

/**
 * Parse the host's `WORKSPACE_NEW_PROJECT_IDS` (comma-separated). Returns null
 * when the variable is absent, i.e. a host that predates it; an empty string
 * means the host confirmed that no member is new.
 */
export function parseHostConfirmedNewProjectIds(
  raw: string | undefined = process.env.WORKSPACE_NEW_PROJECT_IDS,
): string[] | null {
  if (raw === undefined) return null
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}
