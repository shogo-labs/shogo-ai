// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-sentence summaries for #activity lines, using the same platform model
 * as chat titles. The call is internal (not billed to the user). A short
 * source is used as-is, and a failed call leaves the line's preview in place.
 */

/** Shown under an #activity line. Long enough to say what happened. */
export const ACTIVITY_SUMMARY_MAX = 140
/** Below this, the source text is already the summary. */
export const ACTIVITY_SUMMARY_SHORT = 160

const FALLBACK_MODEL = 'claude-haiku-4-5-20251001'
const SYSTEM_PROMPT = [
  'In one past-tense sentence of at most 140 characters, say what the agent did or found.',
  'Plain text, no markdown, no preamble. Do not repeat the agent\'s name.',
].join(' ')

export interface ActivitySummaryInput {
  kind: string
  actor: string
  where?: string | null
  text: string
  /** What a thread reply is answering. */
  context?: string | null
}

/** Drop wrapping quotes and markdown, then fit the sentence on one line. */
export function cleanActivitySummary(raw: string): string {
  let text = raw.trim().replace(/^["'`“”]+|["'`“”]+$/g, '')
  text = text.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim()
  if (text.length <= ACTIVITY_SUMMARY_MAX) return text
  return `${text.slice(0, ACTIVITY_SUMMARY_MAX - 1).trimEnd()}…`
}

type Summarizer = (input: ActivitySummaryInput) => Promise<string | null>

async function modelSummarizer(input: ActivitySummaryInput): Promise<string | null> {
  const { generateTitleCompletion } = await import('../lib/title-model')
  const prompt = [
    `Kind: ${input.kind}`,
    `Agent: ${input.actor}`,
    input.where ? `Where: ${input.where}` : '',
    input.context ? `Replying to: ${input.context}` : '',
    `Text:\n${input.text.slice(0, 4_000)}`,
  ].filter(Boolean).join('\n')
  const result = await generateTitleCompletion({
    system: SYSTEM_PROMPT,
    prompt,
    maxTokens: 80,
    fallbackModelIds: [FALLBACK_MODEL],
  })
  return cleanActivitySummary(result.text) || null
}

let summarizer: Summarizer = modelSummarizer

/** Test seam: replace the model call. Pass null to restore it. */
export function setActivitySummarizer(next: Summarizer | null): void {
  summarizer = next ?? modelSummarizer
}

/**
 * A sentence describing what happened, or null when there is nothing to say
 * or the model call fails. Short text with no thread context skips the model.
 */
export async function summarizeActivity(input: ActivitySummaryInput): Promise<string | null> {
  const text = input.text.trim()
  if (!text) return null
  if (text.length < ACTIVITY_SUMMARY_SHORT && !input.context?.trim()) return cleanActivitySummary(text)
  try {
    return await summarizer({ ...input, text })
  } catch (err) {
    console.warn('[ConversationActivity] summary failed:', err instanceof Error ? err.message : err)
    return null
  }
}
