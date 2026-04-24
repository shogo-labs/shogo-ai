/// <reference types="vite/client" />
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bundled access to the verbatim-ported gstack SKILL.md files and manifest
 * that ship inside this template at .shogo/skills/. Vite globs them at build
 * time so the browser can seed the SkillDoc table without any server-side
 * filesystem access.
 *
 * Used by the "Seed skills from manifest" button on RolesPanel and
 * SkillsRegistry when the SkillDoc table is empty.
 */

export interface GstackManifestSkill {
  name: string
  role: string
  stage: string
  isCore: boolean
  sourceUrl: string
  sourceSha: string
  bodySha256: string
  portedAt: string
}

export interface GstackManifest {
  upstream: string
  commit: string
  license: string
  portedAt: string
  skillCount: number
  coreCount: number
  skills: GstackManifestSkill[]
}

// Manifest — small JSON, eager load is fine.
import manifest from '../../.shogo/skills/gstack-manifest.json'

export function loadManifest(): GstackManifest {
  return manifest as unknown as GstackManifest
}

// Bodies — 41 markdown files, ~3MB total. Lazy glob so Vite code-splits them
// and we only fetch what the seed loop actually needs.
const bodyLoaders = import.meta.glob('../../.shogo/skills/gstack-*/SKILL.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

/**
 * Load a single SKILL.md body by its gstack directory name (e.g. "office-hours").
 * Returns the full file contents including the ported-frontmatter block.
 */
export async function loadSkillBody(skillDirName: string): Promise<string | null> {
  const suffix = `/gstack-${skillDirName}/SKILL.md`
  for (const [key, loader] of Object.entries(bodyLoaders)) {
    if (key.endsWith(suffix)) {
      return loader()
    }
  }
  return null
}

/**
 * Strip the YAML frontmatter block (--- ... ---) that the port-gstack.ts
 * script prepends. Returns the byte-identical upstream markdown body.
 */
export function stripPortFrontmatter(raw: string): string {
  if (!raw.startsWith('---\n')) return raw
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) return raw
  return raw.slice(end + 5)
}
