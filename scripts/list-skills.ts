#!/usr/bin/env bun
/**
 * List available skills from .claude/skills directory
 * Outputs JSON array of {name, description} objects
 * Used to populate VITE_SHOGO_SKILLS env var for the web app
 */
import { readdir, readFile } from "fs/promises"
import { join } from "path"

const skillsDir = join(import.meta.dir, "../.claude/skills")

interface SkillOption {
  name: string
  description: string
}

/**
 * Parse YAML description which may be:
 * - Single line: description: Some text
 * - Block scalar: description: >
 *     Multi-line text
 *     indented
 */
function parseDescription(yaml: string): string {
  // Check for block scalar (> or |) first
  const blockMatch = yaml.match(/description:\s*[>|]\s*\n([\s\S]*?)(?=\n[a-z]|\n---|$)/i)
  if (blockMatch) {
    // Fold multi-line into single line, collapse whitespace
    return blockMatch[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
  }

  // Try single line (not starting with > or |)
  const singleLine = yaml.match(/description:\s*([^>|\n].+)/)
  if (singleLine) return singleLine[1].trim()

  return ""
}

async function listSkills(): Promise<void> {
  const entries = await readdir(skillsDir, { withFileTypes: true })

  const skills = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (dir): Promise<SkillOption | null> => {
        const skillPath = join(skillsDir, dir.name, "SKILL.md")
        try {
          const content = await readFile(skillPath, "utf-8")
          // Parse YAML frontmatter between --- markers
          const match = content.match(/^---\n([\s\S]*?)\n---/)
          if (!match) return { name: dir.name, description: "" }
          const yaml = match[1]
          const name = yaml.match(/name:\s*(.+)/)?.[1]?.trim() || dir.name
          const description = parseDescription(yaml)
          return { name, description }
        } catch {
          return null
        }
      })
  )

  const filtered = skills.filter((s): s is SkillOption => s !== null)
  // Sort alphabetically by name for consistent ordering
  filtered.sort((a, b) => a.name.localeCompare(b.name))

  console.log(JSON.stringify(filtered))
}

listSkills()
