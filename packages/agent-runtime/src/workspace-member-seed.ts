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
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
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
   * The host (metal agent) owns durability: it overlays any backup after
   * boot, exactly as it does over the template in a single-project VM.
   */
  hostMediatedDurability: boolean
  /** Members whose in-guest download completed cleanly and found no archive. */
  newProjectIds: string[]
}

/**
 * Whether the anchor folder may be seeded. Seeding is only safe when either
 * no durable source exists (a clean "no archive" result) or the host will
 * overlay the durable source afterwards. A failed or skipped download never
 * qualifies: the real project may exist and just not be reachable yet.
 */
export function shouldSeedAnchorMember(input: AnchorSeedDecisionInput): boolean {
  const anchor = input.anchorProjectId?.trim()
  if (!anchor || !input.memberProjectIds.includes(anchor)) return false
  return input.hostMediatedDurability || input.newProjectIds.includes(anchor)
}
