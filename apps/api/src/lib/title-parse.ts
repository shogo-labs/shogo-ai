// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export type TitleSource = 'ai' | 'heuristic'

export interface ParsedTitle {
  name: string
  description: string
  source: TitleSource
}

const MAX_TITLE_LENGTH = 50
const MAX_DESCRIPTION_LENGTH = 100

/**
 * Generate a deterministic title when the model is unavailable or returns
 * malformed output. This must remain safe to display as a project/session
 * title: never use raw model output as a fallback.
 */
export function fallbackGenerateProjectName(prompt: string): string {
  const fillerWords = new Set([
    'a', 'an', 'the', 'to', 'for', 'with', 'that', 'this', 'is', 'are',
    'my', 'me', 'its', 'it', 'our', 'your', 'their',
    'create', 'build', 'make', 'design', 'develop', 'implement', 'add', 'include',
    'show', 'showing', 'display', 'have', 'has', 'using', 'use',
    'please', 'can', 'you', 'i', 'want', 'need', 'would', 'like',
    'simple', 'basic', 'web', 'app', 'application', 'website', 'page',
    'where', 'when', 'how', 'what', 'which', 'each', 'every', 'some',
    'and', 'but', 'also', 'then', 'from', 'into', 'about', 'just',
    'nice', 'good', 'new', 'should', 'could',
  ])

  const words = prompt.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !fillerWords.has(word))
    .slice(0, 3)

  if (words.length === 0) return 'New Project'
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function cleanModelText(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function validTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const title = value.trim()
  return title.length > 0
    && title.length <= MAX_TITLE_LENGTH
    && !/[{}\[\]":]/.test(title)
}

function validDescription(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length <= MAX_DESCRIPTION_LENGTH
}

function findJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : null
}

/**
 * Parse the title model's response without ever persisting malformed model
 * text. Older models occasionally return unquoted/truncated JSON such as
 * `{title: App Development, description:`; that is intentionally treated as
 * a heuristic fallback rather than a displayable title.
 */
export function parseTitleResponse(text: string, prompt: string): ParsedTitle {
  const cleaned = cleanModelText(text)
  let parsed: { title?: unknown; description?: unknown } | null = null

  const jsonText = findJsonObject(cleaned)
  if (jsonText) {
    try {
      const value = JSON.parse(jsonText)
      if (value && typeof value === 'object') parsed = value
    } catch {
      // Try the conservative quoted-title recovery below.
    }
  }

  if (!parsed) {
    const titleMatch = cleaned.match(/["']title["']\s*:\s*["']([^"']+)["']/i)
    if (titleMatch) {
      const descriptionMatch = cleaned.match(/["']description["']\s*:\s*["']([^"']*)["']/i)
      parsed = {
        title: titleMatch[1],
        description: descriptionMatch?.[1] ?? '',
      }
    }
  }

  if (parsed && validTitle(parsed.title)) {
    return {
      name: parsed.title.trim(),
      description: validDescription(parsed.description) ? parsed.description.trim() : '',
      source: 'ai',
    }
  }

  return {
    name: fallbackGenerateProjectName(prompt),
    description: '',
    source: 'heuristic',
  }
}
