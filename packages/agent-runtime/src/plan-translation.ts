// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Plan Translation — generates a stakeholder-friendly business summary of a
 * technical plan using the existing fast-tier model. Used by the create_plan
 * and update_plan tools when the user has the Dual Plan preference enabled.
 *
 * The translator is a one-shot, tool-less LLM call routed through the same
 * runAgentLoop primitive the main agent uses, so it inherits provider
 * resolution, retries, and the configured AI proxy / API key plumbing.
 */

import { inferProviderFromModel } from '@shogo/model-catalog'
import { runAgentLoop } from './agent-loop'
import { resolveModelTier } from './subagent'

export interface TranslateToBusinessOptions {
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

const TRANSLATION_SYSTEM_PROMPT = [
  'You translate engineering plans into clear, stakeholder-friendly business summaries.',
  '',
  'Output rules:',
  '- Markdown only. No preamble, no apologies, no meta commentary.',
  '- Mirror the source plan\'s overall structure with H2 (##) section headings.',
  '- Focus on user/business outcomes, scope, risks, success criteria, and any user-visible behavior changes.',
  '- Avoid file paths, function names, code snippets, library names, and implementation jargon.',
  '- Keep it concise: aim for a tight executive read; bullets are fine.',
  '- Do not invent scope. If the source plan is short or vague, the summary stays short.',
].join('\n')

function buildTranslationPrompt(name: string, overview: string, planMarkdown: string): string {
  return [
    `Translate the following engineering plan into a business-language summary.`,
    ``,
    `Plan name: ${name}`,
    `Overview: ${overview}`,
    ``,
    `--- TECHNICAL PLAN ---`,
    planMarkdown,
    `--- END ---`,
    ``,
    `Respond with the business summary in markdown only.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Business section storage format
//
// We store the business translation as a delimited section at the END of the
// `.plan.md` file body (after the existing frontmatter and the technical
// markdown). The delimiter is an HTML comment so it never renders in any
// markdown viewer and never collides with normal plan content.
//
// We deliberately do NOT shoehorn this into the existing hand-rolled YAML
// frontmatter parser — multi-line scalars (`|` blocks) would force us to add
// indentation-aware parsing for what is essentially opaque markdown content,
// and any stray `---` inside the business text would break round-tripping.
// ---------------------------------------------------------------------------

export const BUSINESS_SECTION_START = '<!-- :::business-plan::: -->'
export const BUSINESS_SECTION_END = '<!-- :::end-business-plan::: -->'

const BUSINESS_SECTION_RE = new RegExp(
  `\\n*${escapeRegex(BUSINESS_SECTION_START)}\\n([\\s\\S]*?)\\n${escapeRegex(BUSINESS_SECTION_END)}\\n*$`
)

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Returns the business markdown body, or null if no section is present. */
export function extractBusinessSection(fileContent: string): string | null {
  const match = fileContent.match(BUSINESS_SECTION_RE)
  return match ? match[1].trim() : null
}

/** Returns the file content with any existing business section removed. */
export function stripBusinessSection(fileContent: string): string {
  return fileContent.replace(BUSINESS_SECTION_RE, '').trimEnd() + '\n'
}

/** Returns the file content with the business section appended or replaced. */
export function upsertBusinessSection(fileContent: string, business: string): string {
  const base = stripBusinessSection(fileContent).trimEnd()
  const body = business.trim()
  return `${base}\n\n${BUSINESS_SECTION_START}\n${body}\n${BUSINESS_SECTION_END}\n`
}

export async function translateToBusiness(opts: TranslateToBusinessOptions): Promise<string> {
  const { name, overview, planMarkdown, parentModel, signal } = opts

  const translatorModel = resolveModelTier('fast', parentModel ?? '')
  if (!translatorModel) {
    throw new Error('translateToBusiness: fast-tier model is not configured')
  }
  const provider = inferProviderFromModel(translatorModel, 'anthropic')

  const result = await runAgentLoop({
    provider,
    model: translatorModel,
    system: TRANSLATION_SYSTEM_PROMPT,
    history: [],
    prompt: buildTranslationPrompt(name, overview, planMarkdown),
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
    throw new Error('translateToBusiness: empty response from model')
  }
  return text
}
