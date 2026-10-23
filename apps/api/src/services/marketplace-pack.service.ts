// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reading a pack off disk and off a listing version.
 *
 * A listing's project *is* the pack anchor: `pack.yaml` sits in its root next
 * to `AGENTS.md`, so publishing the existing snapshot ships the pack with no
 * second storage format. A listing without `pack.yaml` installs exactly as it
 * did before packs existed.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSystemManifest, resolveScheduleTiming, type SystemManifest } from '@shogo/agent-runtime/src/system-manifest'
import { listPackTemplates } from '@shogo/agent-runtime/src/pack-templates'
import { prisma } from '../lib/prisma'
import { getWorkspacesDir } from '../lib/workspaces-dir'

export const PACK_FILE = 'pack.yaml'

export type ProjectPackResult =
  | { status: 'none' }
  | { status: 'invalid'; errors: string[] }
  | { status: 'ok'; pack: SystemManifest }

/** Parse `pack.yaml` from a project root. `none` means this is not a pack. */
export function readProjectPack(projectId: string | null | undefined): ProjectPackResult {
  // A listing row may predate `projectId` (or be a bare snapshot); there is no
  // root to read, so it is simply not a pack rather than a crash.
  if (!projectId) return { status: 'none' }
  const abs = join(getWorkspacesDir(), projectId, PACK_FILE)
  if (!existsSync(abs)) return { status: 'none' }
  let source: string
  try {
    source = readFileSync(abs, 'utf-8')
  } catch (err: any) {
    return { status: 'invalid', errors: [`${PACK_FILE}: ${err?.message ?? err}`] }
  }
  const parsed = parseSystemManifest(source)
  if (!parsed.ok || !parsed.manifest) return { status: 'invalid', errors: parsed.errors }
  return { status: 'ok', pack: parsed.manifest }
}

/** The pack stored on a listing version, parsed. Null when the version has none. */
export async function loadVersionPack(listingId: string, version: string): Promise<SystemManifest | null> {
  const row = await prisma.marketplaceListingVersion.findFirst({
    where: { listingId, version },
    select: { systemPack: true },
  })
  const raw = row?.systemPack as unknown
  if (!raw) return null
  const value = typeof raw === 'string' ? safeJson(raw) : raw
  const parsed = parseSystemManifest(value)
  return parsed.ok && parsed.manifest ? parsed.manifest : null
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export interface PackCatalogueEntry {
  id: string
  name: string
  description: string
  questions: unknown[]
  channels: string[]
  schedules: Array<{ key: string; name: string; cron: string; enabled: boolean }>
}

/** The 13 installable built-in packs (departments + specialists). */
export function listPackCatalogue(): PackCatalogueEntry[] {
  return listPackTemplates().map((pack) => {
    const manifest = pack.manifest as unknown as SystemManifest
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      questions: manifest.setup?.questions ?? [],
      channels: (manifest.teamChannels ?? []).map((c) => c.name),
      // The composed cron: an `hour`/`timezone` schedule has no `cron` string of
      // its own until the answers are in, so the catalogue shows what it resolves to.
      schedules: (manifest.schedules ?? []).map((s) => ({ key: s.key, name: s.name, cron: resolveScheduleTiming(s, undefined).cronExpression, enabled: s.enabled })),
    }
  })
}
