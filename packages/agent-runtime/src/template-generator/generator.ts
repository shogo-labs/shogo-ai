// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Template Generation Pass
 *
 * One Claude call per template group. Produces the actual workspace files
 * (AGENTS.md, HEARTBEAT.md, etc.) and template.json metadata,
 * then writes the template directory to disk.
 */

import { sendMessageJSON } from '@shogo/shared-runtime'
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TemplateGroup } from './grouper'
import type { SkillSummary } from './skill-reader'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates')
const BUNDLED_SKILLS_DIR = join(__dirname, '..', 'bundled-skills')

interface GeneratedWorkspace {
  [key: string]: unknown
}

const SYSTEM_PROMPT = `You are an expert at creating AI agent workspace configurations. You produce complete, production-quality workspace files for a Shogo AI agent.

Given a template group (name, description, category, skills with their full content), generate all workspace files. Follow these patterns:

## AGENTS.md
A single file with all agent configuration sections:

### # Identity
- Name: {{AGENT_NAME}} (literal placeholder, gets replaced at creation time)
- Emoji: matching the template icon
- Tagline: concise value prop

### # Personality
- Who the agent is and what it does (2-3 paragraphs)
- Tone section with 4-5 bullet points
- Boundaries section (what it won't do, disclaimers)

### # User
- Template with placeholder fields relevant to this use case
- Name, timezone, plus 3-5 domain-specific fields

### # Operating Instructions
- Multi-surface canvas strategy: list 3-5 canvas surfaces the agent manages
- Core workflow: numbered steps for the agent's main loop
- Skill workflow: how the bundled skills should be used
- Recommended integrations: suggest tool_search queries for relevant MCP integrations
- Canvas patterns: which components to use (Metric grids, DataList, Charts, Tabs)

## HEARTBEAT.md
- 3-5 periodic tasks grouped by frequency
- Each task is a concrete action the agent performs on its heartbeat

## config
- heartbeatInterval: 1800-7200 depending on use case
- heartbeatEnabled: true
- model: { provider: "anthropic", name: "claude-sonnet-4-5" }
- activeMode: "canvas"

## settings
- Match config values for heartbeatInterval, heartbeatEnabled
- modelProvider: "anthropic", modelName: "claude-sonnet-4-5"

## integrations
- 2-5 recommended integrations (category name from Composio, e.g. "github", "slack", "stripe")

Respond with ONLY valid JSON matching the schema (no markdown fences).`

export async function generateTemplate(
  group: TemplateGroup,
  allSkills: SkillSummary[],
  options?: { dryRun?: boolean },
): Promise<void> {
  const groupSkills = allSkills.filter(s => group.skillNames.includes(s.name))

  const skillContents = groupSkills
    .map(s => `### ${s.name}\n\n${s.content}`)
    .join('\n\n---\n\n')

  const prompt = `Generate workspace files for this template:

**ID:** ${group.templateId}
**Name:** ${group.name}
**Category:** ${group.category}
**Description:** ${group.description}
**Icon:** ${group.icon}

## Skills included:

${skillContents}`

  if (options?.dryRun) {
    console.log(`[generator] DRY RUN — would generate template "${group.templateId}" with ${groupSkills.length} skills`)
    return
  }

  console.log(`[generator] Generating template "${group.templateId}"...`)

  const { data, usage } = await sendMessageJSON<GeneratedWorkspace>(prompt, {
    system: SYSTEM_PROMPT,
    temperature: 0,
  })

  console.log(`[generator] Generated "${group.templateId}" (${usage.inputTokens}+${usage.outputTokens} tokens)`)

  // Some responses wrap everything in a "files" key — unwrap it
  const workspace = (data.files && typeof data.files === 'object' && !Array.isArray(data.files))
    ? { ...data.files as Record<string, unknown>, settings: data.settings, integrations: data.integrations, config: data.config ?? (data.files as any).config }
    : data

  writeTemplateToDisk(group, workspace as GeneratedWorkspace, groupSkills)
}

// Map from possible LLM response keys to workspace filenames
const WORKSPACE_KEY_MAP: Record<string, string> = {
  'agents': 'AGENTS.md',
  'AGENTS.md': 'AGENTS.md',
  'AGENTS': 'AGENTS.md',
  'heartbeat': 'HEARTBEAT.md',
  'HEARTBEAT.md': 'HEARTBEAT.md',
  'HEARTBEAT': 'HEARTBEAT.md',
}

function resolveWorkspaceFile(key: string): string | null {
  return WORKSPACE_KEY_MAP[key] ?? null
}

function writeTemplateToDisk(
  group: TemplateGroup,
  workspace: GeneratedWorkspace,
  skills: SkillSummary[],
): void {
  const templateDir = join(TEMPLATES_DIR, group.templateId)
  const shogoDir = join(templateDir, '.shogo')
  const skillsDir = join(shogoDir, 'skills')

  mkdirSync(skillsDir, { recursive: true })

  // Extract settings/config/integrations from the workspace object
  const settings = workspace.settings as Record<string, unknown> | undefined
  const integrations = workspace.integrations as Array<Record<string, unknown>> | undefined
  const config = workspace.config as Record<string, unknown> | undefined

  // template.json — lightweight metadata for the API
  const templateMeta = {
    id: group.templateId,
    name: group.name,
    description: group.description,
    category: group.category,
    icon: group.icon,
    tags: group.tags,
    settings: settings ?? {
      heartbeatInterval: 3600,
      heartbeatEnabled: true,
      modelProvider: 'anthropic',
      modelName: 'claude-sonnet-4-5',
    },
    integrations,
  }
  writeFileSync(join(templateDir, 'template.json'), JSON.stringify(templateMeta, null, 2) + '\n')

  // Workspace files — resolve keys flexibly
  for (const [key, value] of Object.entries(workspace)) {
    if (key === 'settings' || key === 'integrations' || key === 'config') continue
    const filename = resolveWorkspaceFile(key)
    if (filename && typeof value === 'string') {
      writeFileSync(join(shogoDir, filename), value)
    }
  }

  // config.json — write from the config object or build a default
  const configObj = config ?? {
    heartbeatInterval: 3600,
    heartbeatEnabled: true,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
    activeMode: 'canvas',
  }
  writeFileSync(join(shogoDir, 'config.json'), JSON.stringify(configObj, null, 2) + '\n')

  // Copy skills from bundled-skills into .shogo/skills/
  for (const skill of skills) {
    const srcDir = join(BUNDLED_SKILLS_DIR, skill.name)
    const destDir = join(skillsDir, skill.name)
    if (existsSync(srcDir)) {
      cpSync(srcDir, destDir, { recursive: true })
    }
  }

  console.log(`[generator] Wrote template "${group.templateId}" → ${templateDir}`)
}

/**
 * Generate all templates from a list of groups.
 */
export async function generateAllTemplates(
  groups: TemplateGroup[],
  allSkills: SkillSummary[],
  options?: { dryRun?: boolean },
): Promise<void> {
  for (const group of groups) {
    await generateTemplate(group, allSkills, options)
  }
}
