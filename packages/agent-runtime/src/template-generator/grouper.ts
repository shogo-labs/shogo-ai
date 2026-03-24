// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Grouping Pass
 *
 * Uses Claude to cluster bundled skills into coherent template groups.
 * Each group becomes a template directory.
 */

import { sendMessageJSON } from '@shogo/shared-runtime'
import type { SkillSummary } from './skill-reader'
import type { TemplateCategory } from '../agent-templates'

export interface TemplateGroup {
  templateId: string
  name: string
  category: TemplateCategory
  description: string
  icon: string
  tags: string[]
  skillNames: string[]
}

const VALID_CATEGORIES: TemplateCategory[] = [
  'personal', 'development', 'business', 'research', 'operations', 'marketing', 'sales',
]

const SYSTEM_PROMPT = `You are an expert at organizing AI agent skills into coherent template groups.

Given a list of skills (name + description), group them into 4-8 templates. Each template should:
- Combine 2-4 related skills into a focused, real-world use case
- Have a clear kebab-case id (e.g. "sales-revenue", "support-ops")
- Have a human-friendly name
- Be assigned exactly one category from: ${VALID_CATEGORIES.join(', ')}
- Have a single emoji icon
- Have 3-6 relevant tags
- Have a compelling 1-2 sentence description

A skill can appear in at most ONE group. Not every skill must be assigned — only group skills that naturally cluster. Prefer fewer, tighter groups over loose catch-alls.

Respond with ONLY valid JSON matching this schema:
{
  "groups": [
    {
      "templateId": "string (kebab-case)",
      "name": "string",
      "category": "string (one of the valid categories)",
      "description": "string",
      "icon": "string (single emoji)",
      "tags": ["string"],
      "skillNames": ["string (exact skill names from input)"]
    }
  ]
}`

export async function groupSkills(
  skills: SkillSummary[],
  options?: { dryRun?: boolean },
): Promise<TemplateGroup[]> {
  const skillList = skills
    .map(s => `- **${s.name}**: ${s.description}`)
    .join('\n')

  const prompt = `Group these ${skills.length} agent skills into template categories:\n\n${skillList}`

  if (options?.dryRun) {
    console.log('[grouper] DRY RUN — would send prompt:')
    console.log(prompt.slice(0, 500) + '...')
    return []
  }

  console.log(`[grouper] Clustering ${skills.length} skills into template groups...`)

  const { data, usage } = await sendMessageJSON<{ groups: TemplateGroup[] }>(prompt, {
    system: SYSTEM_PROMPT,
    maxTokens: 4096,
    temperature: 0,
  })

  console.log(`[grouper] Got ${data.groups.length} groups (${usage.inputTokens}+${usage.outputTokens} tokens)`)

  // Validate skill names match input
  const validNames = new Set(skills.map(s => s.name))
  for (const group of data.groups) {
    group.skillNames = group.skillNames.filter(n => {
      if (!validNames.has(n)) {
        console.warn(`[grouper] Dropping unknown skill "${n}" from group "${group.templateId}"`)
        return false
      }
      return true
    })
  }

  return data.groups.filter(g => g.skillNames.length > 0)
}
