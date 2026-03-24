// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// Skill Reader
//
// Reads all bundled-skills SKILL.md files, parses frontmatter,
// and computes content hashes for cache comparison.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseFrontmatter } from '../skills'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BUNDLED_SKILLS_DIR = join(__dirname, '..', 'bundled-skills')

export interface SkillSummary {
  name: string
  description: string
  trigger: string
  tools: string[]
  content: string
  contentHash: string
  dirPath: string
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * Read all bundled skills, parse frontmatter, and compute content hashes.
 */
export function readBundledSkills(skillsDir: string = BUNDLED_SKILLS_DIR): SkillSummary[] {
  if (!existsSync(skillsDir)) return []

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md')))
    .map(d => {
      const dirPath = join(skillsDir, d.name)
      const raw = readFileSync(join(dirPath, 'SKILL.md'), 'utf-8')
      const { metadata, content } = parseFrontmatter(raw)

      const tools = Array.isArray(metadata.tools)
        ? metadata.tools
        : typeof metadata.tools === 'string'
          ? metadata.tools.split(',').map((t: string) => t.trim()).filter(Boolean)
          : []

      return {
        name: metadata.name ?? d.name,
        description: metadata.description ?? '',
        trigger: metadata.trigger ?? '',
        tools,
        content,
        contentHash: hashContent(raw),
        dirPath,
      }
    })
}
