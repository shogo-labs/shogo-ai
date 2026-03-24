// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unified Skill Loader
 *
 * Skills live in .shogo/skills/<name>/SKILL.md (primary) with optional
 * scripts/ subdirectories. Compat loading from .claude/skills/ and
 * .agents/skills/ is preserved for community/registry skills.
 *
 * Legacy flat skills/*.md files are auto-migrated on first load.
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, statSync } from 'fs'
import { join, extname, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { resolveToolNames } from './gateway-tools'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Unified Skill interface
// ---------------------------------------------------------------------------

export interface Skill {
  name: string
  description: string
  content: string
  skillDir: string

  // Trigger matching (from legacy flat format)
  version?: string
  trigger?: string
  tools?: string[]

  // Invocation control (from Claude Code format)
  disableModelInvocation: boolean
  userInvocable: boolean
  allowedTools?: string[]
  context?: 'fork'
  agent?: string
  argumentHint?: string

  // Script support
  setup?: string
  scripts?: string[]
  runtime?: string
}

/** @deprecated Use Skill instead. Alias kept for downstream compat during migration. */
export type ClaudeCodeSkill = Skill

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parse YAML-like frontmatter from a Markdown skill file.
 * Handles simple key: value and key: [array] patterns.
 */
export function parseFrontmatter(raw: string): {
  metadata: Record<string, any>
  content: string
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { metadata: {}, content: raw }
  }

  const [, frontmatter, content] = match
  const metadata: Record<string, any> = {}

  for (const line of frontmatter.split('\n')) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const key = line.substring(0, colonIndex).trim()
    let value = line.substring(colonIndex + 1).trim()

    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1)
      metadata[key] = value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    } else if (value.startsWith('"') && value.endsWith('"')) {
      metadata[key] = value.slice(1, -1)
    } else {
      metadata[key] = value
    }
  }

  return { metadata, content: content.trim() }
}

// ---------------------------------------------------------------------------
// Helper: parse unified metadata from frontmatter into a Skill
// ---------------------------------------------------------------------------

function parseAllowedTools(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') {
    return raw.split(/[,\s]+/).map(t => t.trim()).filter(Boolean)
  }
  if (Array.isArray(raw)) return raw
  return undefined
}

function discoverScripts(skillDir: string): string[] {
  const scriptsDir = join(skillDir, 'scripts')
  if (!existsSync(scriptsDir)) return []
  try {
    return readdirSync(scriptsDir)
      .filter(f => /\.(py|js|ts|sh|mjs|cjs)$/.test(f))
      .sort()
  } catch { return [] }
}

function parseSkillFromDir(skillDir: string, dirName: string): Skill | null {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) return null

  try {
    const raw = readFileSync(skillMdPath, 'utf-8')
    const { metadata, content } = parseFrontmatter(raw)

    const name = metadata.name || dirName
    const description = metadata.description || content.split('\n')[0] || ''

    const rawTools = Array.isArray(metadata.tools) ? metadata.tools : []

    const scripts = discoverScripts(skillDir)

    return {
      name,
      description,
      content,
      skillDir,
      version: metadata.version || undefined,
      trigger: metadata.trigger || undefined,
      tools: rawTools.length > 0 ? resolveToolNames(rawTools) : undefined,
      disableModelInvocation: metadata['disable-model-invocation'] === 'true' || metadata['disable-model-invocation'] === true,
      userInvocable: metadata['user-invocable'] !== 'false' && metadata['user-invocable'] !== false,
      allowedTools: parseAllowedTools(metadata['allowed-tools']),
      context: metadata.context === 'fork' ? 'fork' : undefined,
      agent: metadata.agent || undefined,
      argumentHint: metadata['argument-hint'] || undefined,
      setup: metadata.setup || undefined,
      runtime: metadata.runtime || undefined,
      scripts: scripts.length > 0 ? scripts : undefined,
    }
  } catch (err: any) {
    console.error(`[Skills] Failed to load skill ${dirName}:`, err.message)
    return null
  }
}

// ---------------------------------------------------------------------------
// Unified skill loaders
// ---------------------------------------------------------------------------

/**
 * Load skills from a directory in the .shogo/skills/<name>/SKILL.md format.
 * Also supports flat .md files in the same directory for compat.
 */
export function loadSkillsFromDir(baseDir: string, subPath = '.shogo/skills'): Skill[] {
  const skillsDir = join(baseDir, ...subPath.split('/'))
  if (!existsSync(skillsDir)) return []

  const skills: Skill[] = []
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skill = parseSkillFromDir(join(skillsDir, entry.name), entry.name)
        if (skill) skills.push(skill)
      }
    }
  } catch { /* directory unreadable */ }

  return skills
}

/**
 * Load all skills from all relevant locations (highest priority first):
 * 1. workspace/.shogo/skills/ (primary, Shogo native)
 * 2. workspace/.claude/skills/ (compat for community/registry)
 * 3. workspace/.agents/skills/ (compat, Agent Skills spec)
 *
 * Earlier sources take precedence on name collision.
 */
export function loadAllSkills(workspaceDir: string): Skill[] {
  const shogoSkills = loadSkillsFromDir(workspaceDir, '.shogo/skills')
  const knownNames = new Set(shogoSkills.map(s => s.name))

  const claudeSkills = loadSkillsFromDir(workspaceDir, '.claude/skills')
    .filter(s => !knownNames.has(s.name))
  for (const s of claudeSkills) knownNames.add(s.name)

  const agentsSkills = loadSkillsFromDir(workspaceDir, '.agents/skills')
    .filter(s => !knownNames.has(s.name))

  return [...shogoSkills, ...claudeSkills, ...agentsSkills]
}

// ---------------------------------------------------------------------------
// Legacy migration: skills/*.md -> .shogo/skills/<name>/SKILL.md
// ---------------------------------------------------------------------------

/**
 * Migrate legacy flat skills/*.md files to .shogo/skills/<name>/SKILL.md.
 * Only runs if skills/ exists and .shogo/skills/ does not yet exist.
 * Leaves the old skills/ directory intact as a backup.
 */
export function migrateFromLegacySkills(workspaceDir: string): void {
  const legacyDir = join(workspaceDir, 'skills')
  const shogoDir = join(workspaceDir, '.shogo', 'skills')

  if (!existsSync(legacyDir)) return
  if (existsSync(shogoDir)) return

  let files: string[]
  try {
    files = readdirSync(legacyDir).filter(f => extname(f) === '.md')
  } catch { return }

  if (files.length === 0) return

  console.log(`[Skills] Migrating ${files.length} legacy skills from skills/ to .shogo/skills/`)
  mkdirSync(shogoDir, { recursive: true })

  for (const file of files) {
    const skillName = basename(file, '.md')
    const destDir = join(shogoDir, skillName)
    mkdirSync(destDir, { recursive: true })
    try {
      copyFileSync(join(legacyDir, file), join(destDir, 'SKILL.md'))
      console.log(`[Skills]   Migrated ${file} -> .shogo/skills/${skillName}/SKILL.md`)
    } catch (err: any) {
      console.error(`[Skills]   Failed to migrate ${file}:`, err.message)
    }
  }
}

// ---------------------------------------------------------------------------
// Bundled skills (shipped with agent-runtime)
// ---------------------------------------------------------------------------

/**
 * Load bundled skills shipped with agent-runtime in directory format.
 * Only includes bundled skills whose names don't conflict with existing workspace skills.
 */
export function loadBundledSkills(existingSkillNames: Set<string>): Skill[] {
  const bundledDir = join(__dirname, 'bundled-skills')
  if (!existsSync(bundledDir)) return []

  const skills: Skill[] = []
  try {
    for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skill = parseSkillFromDir(join(bundledDir, entry.name), entry.name)
      if (skill && !existingSkillNames.has(skill.name)) {
        skills.push(skill)
      }
    }
  } catch { /* unreadable */ }

  return skills
}

// ---------------------------------------------------------------------------
// Skill search
// ---------------------------------------------------------------------------

export interface SkillSearchResult extends Skill {
  installed: boolean
  score: number
}

/**
 * Search installed and bundled skills by keyword relevance.
 */
export function searchSkills(
  query: string,
  installed: Skill[],
  bundled: Skill[],
  limit = 5,
): SkillSearchResult[] {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  if (queryWords.length === 0) return []

  const queryLower = query.toLowerCase()
  const seen = new Set<string>()
  const scored: SkillSearchResult[] = []

  const scoreSkill = (skill: Skill, isInstalled: boolean) => {
    if (seen.has(skill.name)) return
    seen.add(skill.name)

    const nameLower = skill.name.toLowerCase()
    const triggerLower = (skill.trigger || '').toLowerCase()
    const descLower = skill.description.toLowerCase()
    const contentLower = skill.content.toLowerCase()

    let score = 0

    if (nameLower.includes(queryLower)) score += 25
    if (triggerLower.includes(queryLower)) score += 20
    if (descLower.includes(queryLower)) score += 12

    for (const word of queryWords) {
      if (nameLower.includes(word)) score += 20
      if (triggerLower.includes(word)) score += 15
      if (descLower.includes(word)) score += 10
      if (contentLower.includes(word)) score += 1
    }

    if (score > 0) {
      scored.push({ ...skill, installed: isInstalled, score })
    }
  }

  for (const skill of installed) scoreSkill(skill, true)
  for (const skill of bundled) scoreSkill(skill, false)

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Bundled External Skills (from skill-registry.json, fetched at build time)
// ---------------------------------------------------------------------------

export interface SkillRegistryEntry {
  name: string
  description: string
  source: string
  sourceDescription: string
  dirName: string
}

/**
 * Load the manifest of bundled external skills.
 * Fetched at Docker build time by scripts/fetch-external-skills.ts.
 */
export function loadSkillRegistryManifest(): SkillRegistryEntry[] {
  const manifestPath = join(__dirname, 'bundled-claude-skills', 'manifest.json')
  if (!existsSync(manifestPath)) return []
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch {
    return []
  }
}

/**
 * Load a single bundled external skill by source + dirName.
 */
export function loadBundledClaudeCodeSkill(source: string, dirName: string): Skill | null {
  const skillDir = join(__dirname, 'bundled-claude-skills', source, dirName)
  return parseSkillFromDir(skillDir, dirName)
}

// ---------------------------------------------------------------------------
// System prompt injection
// ---------------------------------------------------------------------------

/**
 * Build a skills description block for injection into the system prompt.
 * Only includes skills where disable-model-invocation is false.
 * Respects a character budget (default: 16000 chars).
 */
export function buildSkillsPromptSection(
  skills: Skill[],
  charBudget?: number,
): string {
  const budget = charBudget || parseInt(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET || '16000', 10)
  const invocableSkills = skills.filter(s => !s.disableModelInvocation)

  if (invocableSkills.length === 0) return ''

  let section = '## Available Skills\n\nUse the `skill` tool to invoke these skills when relevant:\n\n'
  let currentSize = section.length

  for (const skill of invocableSkills) {
    let line = `- **${skill.name}**: ${skill.description}`
    if (skill.argumentHint) line += ` (args: ${skill.argumentHint})`
    if (skill.scripts && skill.scripts.length > 0) line += ` [scripts: ${skill.scripts.join(', ')}]`
    line += '\n'
    if (currentSize + line.length > budget) break
    section += line
    currentSize += line.length
  }

  return section
}

// ---------------------------------------------------------------------------
// Trigger matching
// ---------------------------------------------------------------------------

/**
 * Match a user message against loaded skills that have trigger patterns.
 * Returns the first matching skill, or null.
 */
export function matchSkill(skills: Skill[], message: string): Skill | null {
  const lowerMessage = message.toLowerCase()

  for (const skill of skills) {
    if (!skill.trigger) continue

    const triggers = skill.trigger.split('|').map((t) => t.trim().toLowerCase())

    for (const trigger of triggers) {
      if (trigger.startsWith('/') && trigger.endsWith('/')) {
        try {
          const regex = new RegExp(trigger.slice(1, -1), 'i')
          if (regex.test(message)) return skill
        } catch {
          // Invalid regex, skip
        }
        continue
      }

      if (lowerMessage.includes(trigger)) {
        return skill
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Deprecated: kept for backward compat during migration
// ---------------------------------------------------------------------------

/** @deprecated Use loadSkillsFromDir instead */
export function loadSkills(skillsDir: string): Skill[] {
  if (!existsSync(skillsDir)) return []

  const skills: Skill[] = []

  // Try directory format first
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skill = parseSkillFromDir(join(skillsDir, entry.name), entry.name)
        if (skill) skills.push(skill)
      }
    }
  } catch { /* */ }

  // Fall back to flat .md files
  try {
    const files = readdirSync(skillsDir)
    for (const file of files) {
      if (extname(file) !== '.md') continue

      const filePath = join(skillsDir, file)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const { metadata, content } = parseFrontmatter(raw)

        if (!metadata.name || !metadata.trigger) {
          console.warn(`[Skills] Skipping ${file}: missing name or trigger`)
          continue
        }

        const name = metadata.name
        if (skills.some(s => s.name === name)) continue

        const rawTools = Array.isArray(metadata.tools) ? metadata.tools : []
        skills.push({
          name,
          description: metadata.description || '',
          content,
          skillDir: dirname(filePath),
          version: metadata.version || '1.0.0',
          trigger: metadata.trigger,
          tools: resolveToolNames(rawTools),
          disableModelInvocation: false,
          userInvocable: true,
        })
      } catch (error: any) {
        console.error(`[Skills] Failed to load ${file}:`, error.message)
      }
    }
  } catch { /* */ }

  return skills
}

/** @deprecated Use loadAllSkills instead */
export function loadAllClaudeCodeSkills(workspaceDir: string): Skill[] {
  return loadAllSkills(workspaceDir)
}

/** @deprecated Use loadSkillsFromDir instead */
export function loadClaudeCodeSkills(baseDir: string, subPath = '.claude/skills'): Skill[] {
  return loadSkillsFromDir(baseDir, subPath)
}
