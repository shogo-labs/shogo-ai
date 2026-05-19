// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Plan Summary — generates a stakeholder-friendly summary of a technical
 * plan using the existing fast-tier model. Used by the create_plan and
 * update_plan tools when the user has the Dual Plan preference enabled.
 *
 * The summarizer is a one-shot, tool-less LLM call routed through the same
 * runAgentLoop primitive the main agent uses, so it inherits provider
 * resolution, retries, and the configured AI proxy / API key plumbing.
 */

import { inferProviderFromModel } from '@shogo/model-catalog'
import { runAgentLoop } from './agent-loop'
import { resolveModelTier } from './subagent'

export interface SummarizePlanOptions {
  /** Plan title (used to ground the summary). */
  name: string
  /** 1-2 sentence overview of the plan. */
  overview: string
  /** The full technical plan markdown. */
  planMarkdown: string
  /** The main turn's effective model id — used to fall back to the parent
   *  model if the fast tier mapping is unset for the current provider. */
  parentModel?: string
  /** AbortSignal forwarded to the underlying LLM call. */
  signal?: AbortSignal
}

const SUMMARY_SYSTEM_PROMPT = [
  'You translate engineering plans into clear, stakeholder-friendly summaries.',
  '',
  'Output rules:',
  '- Markdown only. No preamble, no apologies, no meta commentary.',
  '- Mirror the source plan\'s overall structure with H2 (##) section headings.',
  '- Focus on user/business outcomes, scope, risks, success criteria, and any user-visible behavior changes.',
  '- Avoid file paths, function names, code snippets, library names, and implementation jargon.',
  '- Keep it concise: aim for a tight executive read; bullets are fine.',
  '- Do not invent scope. If the source plan is short or vague, the summary stays short.',
].join('\n')

function buildSummaryPrompt(name: string, overview: string, planMarkdown: string): string {
  return [
    `Translate the following engineering plan into a stakeholder-friendly summary.`,
    ``,
    `Plan name: ${name}`,
    `Overview: ${overview}`,
    ``,
    `--- TECHNICAL PLAN ---`,
    planMarkdown,
    `--- END ---`,
    ``,
    `Respond with the summary in markdown only.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Summary section storage format
//
// We store the stakeholder summary as a delimited section at the END of the
// `.plan.md` file body (after the existing frontmatter and the technical
// markdown). The delimiter is an HTML comment so it never renders in any
// markdown viewer and never collides with normal plan content.
//
// We deliberately do NOT shoehorn this into the existing hand-rolled YAML
// frontmatter parser — multi-line scalars (`|` blocks) would force us to add
// indentation-aware parsing for what is essentially opaque markdown content,
// and any stray `---` inside the summary text would break round-tripping.
//
// Backward compatibility: the section was formerly written with
// `<!-- :::business-plan::: -->` / `<!-- :::end-business-plan::: -->`
// markers (the "Business" tab era). The read path accepts either marker
// pair so existing `.plan.md` files keep rendering; the write path always
// emits the new `:::summary:::` markers.
// ---------------------------------------------------------------------------

export const SUMMARY_SECTION_START = '<!-- :::summary::: -->'
export const SUMMARY_SECTION_END = '<!-- :::end-summary::: -->'
const LEGACY_SUMMARY_SECTION_START = '<!-- :::business-plan::: -->'
const LEGACY_SUMMARY_SECTION_END = '<!-- :::end-business-plan::: -->'

const SUMMARY_SECTION_RE = new RegExp(
  `\\n*(?:${escapeRegex(SUMMARY_SECTION_START)}|${escapeRegex(LEGACY_SUMMARY_SECTION_START)})\\n([\\s\\S]*?)\\n(?:${escapeRegex(SUMMARY_SECTION_END)}|${escapeRegex(LEGACY_SUMMARY_SECTION_END)})\\n*$`
)

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Returns the summary markdown body, or null if no section is present.
 *  Accepts either the current `:::summary:::` markers or the legacy
 *  `:::business-plan:::` markers (for backward compat with older plans). */
export function extractSummarySection(fileContent: string): string | null {
  const match = fileContent.match(SUMMARY_SECTION_RE)
  return match ? match[1].trim() : null
}

/** Returns the file content with any existing summary section removed
 *  (current or legacy markers). */
export function stripSummarySection(fileContent: string): string {
  return fileContent.replace(SUMMARY_SECTION_RE, '').trimEnd() + '\n'
}

/** Returns the file content with the summary section appended or replaced.
 *  Writes always use the current `:::summary:::` markers. */
export function upsertSummarySection(fileContent: string, summary: string): string {
  const base = stripSummarySection(fileContent).trimEnd()
  const body = summary.trim()
  return `${base}\n\n${SUMMARY_SECTION_START}\n${body}\n${SUMMARY_SECTION_END}\n`
}

export async function summarizePlan(opts: SummarizePlanOptions): Promise<string> {
  const { name, overview, planMarkdown, parentModel, signal } = opts

  const summarizerModel = resolveModelTier('fast', parentModel ?? '')
  if (!summarizerModel) {
    throw new Error('summarizePlan: fast-tier model is not configured')
  }
  const provider = inferProviderFromModel(summarizerModel, 'anthropic')

  const result = await runAgentLoop({
    provider,
    model: summarizerModel,
    system: SUMMARY_SYSTEM_PROMPT,
    history: [],
    prompt: buildSummaryPrompt(name, overview, planMarkdown),
    tools: [],
    maxIterations: 1,
    thinkingLevel: 'off',
    loopDetection: false,
    signal,
  })

  if (result.error) {
    throw result.error
  }

  const text = (result.text || '').trim()
  if (!text) {
    throw new Error('summarizePlan: empty response from model')
  }
  return text
}
