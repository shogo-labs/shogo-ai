// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Skill Loader
 *
 * Loads skills from the workspace skills/ directory.
 * Skills are Markdown files with YAML frontmatter defining
 * trigger patterns, required tools, and instructions.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, extname, dirname } from 'path'
import { fileURLToPath } from 'url'
import { resolveToolNames } from './gateway-tools'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface Skill {
  name: string
  version: string
  description: string
  trigger: string
  tools: string[]
  content: string
  filePath: string
}

/**
 * Parse YAML-like frontmatter from a Markdown skill file.
 * Handles simple key: value and key: [array] patterns.
 */
function parseFrontmatter(raw: string): {
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

    // Handle array values: [item1, item2]
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

/**
 * Load all skills from a directory.
 */
export function loadSkills(skillsDir: string): Skill[] {
  if (!existsSync(skillsDir)) return []

  const skills: Skill[] = []
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

      const rawTools = Array.isArray(metadata.tools) ? metadata.tools : []
      skills.push({
        name: metadata.name,
        version: metadata.version || '1.0.0',
        description: metadata.description || '',
        trigger: metadata.trigger,
        tools: resolveToolNames(rawTools),
        content,
        filePath,
      })
    } catch (error: any) {
      console.error(`[Skills] Failed to load ${file}:`, error.message)
    }
  }

  return skills
}

/**
 * Load bundled skills shipped with agent-runtime.
 * Only includes bundled skills whose names don't conflict with workspace skills.
 */
export function loadBundledSkills(existingSkillNames: Set<string>): Skill[] {
  const bundledDir = join(__dirname, 'bundled-skills')
  if (!existsSync(bundledDir)) return []

  const all = loadSkills(bundledDir)
  return all.filter((s) => !existingSkillNames.has(s.name))
}

// ---------------------------------------------------------------------------
// Claude Code Skill Format (.claude/skills/<name>/SKILL.md)
// ---------------------------------------------------------------------------

export interface ClaudeCodeSkill {
  name: string
  description: string
  content: string
  skillDir: string
  disableModelInvocation: boolean
  userInvocable: boolean
  allowedTools?: string[]
  context?: 'fork'
  agent?: string
  argumentHint?: string
}

/**
 * Load skills in the Claude Code .claude/skills/<name>/SKILL.md format.
 * Scans the given directory for subdirectories containing SKILL.md.
 */
export function loadClaudeCodeSkills(baseDir: string): ClaudeCodeSkill[] {
  const skillsDir = join(baseDir, '.claude', 'skills')
  if (!existsSync(skillsDir)) return []

  const skills: ClaudeCodeSkill[] = []
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillMdPath = join(skillsDir, entry.name, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue

      try {
        const raw = readFileSync(skillMdPath, 'utf-8')
        const { metadata, content } = parseFrontmatter(raw)

        const name = metadata.name || entry.name
        const description = metadata.description || content.split('\n')[0] || ''

        const allowedToolsRaw = metadata['allowed-tools']
        const allowedTools = typeof allowedToolsRaw === 'string'
          ? allowedToolsRaw.split(/[,\s]+/).map(t => t.trim()).filter(Boolean)
          : Array.isArray(allowedToolsRaw) ? allowedToolsRaw : undefined

        skills.push({
          name,
          description,
          content,
          skillDir: join(skillsDir, entry.name),
          disableModelInvocation: metadata['disable-model-invocation'] === 'true' || metadata['disable-model-invocation'] === true,
          userInvocable: metadata['user-invocable'] !== 'false' && metadata['user-invocable'] !== false,
          allowedTools,
          context: metadata.context === 'fork' ? 'fork' : undefined,
          agent: metadata.agent || undefined,
          argumentHint: metadata['argument-hint'] || undefined,
        })
      } catch (err: any) {
        console.error(`[Skills] Failed to load Claude Code skill ${entry.name}:`, err.message)
      }
    }
  } catch { /* directory unreadable */ }

  return skills
}

/**
 * Load Claude Code skills from all relevant locations:
 * - workspace/.claude/skills/ (project-level)
 * - ~/.claude/skills/ (user-level, optional)
 *
 * Project skills take precedence over user skills on name collision.
 */
export function loadAllClaudeCodeSkills(workspaceDir: string): ClaudeCodeSkill[] {
  const projectSkills = loadClaudeCodeSkills(workspaceDir)
  const projectNames = new Set(projectSkills.map(s => s.name))

  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  let userSkills: ClaudeCodeSkill[] = []
  if (homeDir) {
    const homeClaudeDir = join(homeDir, '.claude', 'skills')
    if (existsSync(join(homeDir, '.claude'))) {
      userSkills = loadClaudeCodeSkills(homeDir).filter(s => !projectNames.has(s.name))
    }
  }

  return [...projectSkills, ...userSkills]
}

/**
 * Build a skills description block for injection into the system prompt.
 * Only includes skills where disable-model-invocation is false.
 * Respects a character budget (default: 16000 chars).
 */
export function buildSkillsPromptSection(
  skills: ClaudeCodeSkill[],
  charBudget?: number,
): string {
  const budget = charBudget || parseInt(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET || '16000', 10)
  const invocableSkills = skills.filter(s => !s.disableModelInvocation)

  if (invocableSkills.length === 0) return ''

  let section = '## Available Skills\n\nUse the `skill` tool to invoke these skills when relevant:\n\n'
  let currentSize = section.length

  for (const skill of invocableSkills) {
    const line = `- **${skill.name}**: ${skill.description}${skill.argumentHint ? ` (args: ${skill.argumentHint})` : ''}\n`
    if (currentSize + line.length > budget) break
    section += line
    currentSize += line.length
  }

  return section
}

/**
 * Match a user message against loaded skills.
 * Returns the first matching skill, or null.
 */
export function matchSkill(skills: Skill[], message: string): Skill | null {
  const lowerMessage = message.toLowerCase()

  for (const skill of skills) {
    const triggers = skill.trigger.split('|').map((t) => t.trim().toLowerCase())

    for (const trigger of triggers) {
      // Regex trigger (wrapped in /.../)
      if (trigger.startsWith('/') && trigger.endsWith('/')) {
        try {
          const regex = new RegExp(trigger.slice(1, -1), 'i')
          if (regex.test(message)) return skill
        } catch {
          // Invalid regex, skip
        }
        continue
      }

      // Keyword/phrase match
      if (lowerMessage.includes(trigger)) {
        return skill
      }
    }
  }

  return null
}
