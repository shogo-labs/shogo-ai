// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Prompt sections shared between the coordinator and worker sub-agents.
 *
 * A worker should inherit the platform/project rules that make it safe and
 * effective, but not coordinator-only instructions such as delegation or chat
 * UX guidance.
 */
export type PromptAudience = 'all' | 'main' | 'worker'

export interface PromptSection {
  label: string
  zone: 'stable' | 'dynamic'
  content: string
  audience: PromptAudience
  requiresTools?: string[]
}

export interface WorkerPromptBuild {
  prompt: string
  sectionLabels: string[]
  estimatedTokens: number
}

export const PROMPT_SECTION_SEPARATOR = '\n\n---\n\n'
export const PROMPT_CACHE_BOUNDARY = '\n\n<|CACHE_BOUNDARY|>\n\n'

export function buildWorkerPrompt(
  sections: PromptSection[],
  toolNames: string[],
  restrictionPrompt?: string,
  includeSections = true,
): WorkerPromptBuild {
  const available = new Set(toolNames)
  const included = includeSections ? sections.filter((section) => {
    if (section.audience === 'main') return false
    return !section.requiresTools?.some((tool) => !available.has(tool))
  }) : []
  const stable = included.filter((section) => section.zone === 'stable').map((section) => section.content)
  const dynamic = included.filter((section) => section.zone === 'dynamic').map((section) => section.content)
  const parts = [
    ...(restrictionPrompt?.trim() ? [restrictionPrompt.trim()] : []),
    stable.join(PROMPT_SECTION_SEPARATOR),
    ...(dynamic.length > 0
      ? [PROMPT_CACHE_BOUNDARY, dynamic.join(PROMPT_SECTION_SEPARATOR)]
      : []),
  ].filter(Boolean)

  return {
    prompt: parts.join(PROMPT_SECTION_SEPARATOR),
    sectionLabels: included.map((section) => section.label),
    estimatedTokens: Math.ceil(parts.reduce((total, part) => total + part.length, 0) / 4),
  }
}
