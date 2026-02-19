/**
 * Skill Loader
 *
 * Loads skills from the workspace skills/ directory.
 * Skills are Markdown files with YAML frontmatter defining
 * trigger patterns, required tools, and instructions.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, extname } from 'path'
import { resolveToolNames } from './gateway-tools'

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
