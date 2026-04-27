// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ConsolidateInput, Summarizer } from './types.js'

/**
 * Passthrough summarizer — useful for testing or storing raw summaries.
 *
 * `summarize` returns the input unchanged. `consolidate` emits one bullet per
 * existing entry followed by the transcript as a final bullet; this keeps the
 * consolidation codepath deterministic without requiring an LLM.
 */
export const identitySummarizer: Summarizer = {
  summarize(text: string): Promise<string> {
    return Promise.resolve(text)
  },
  consolidate(input: ConsolidateInput): Promise<string> {
    const lines: string[] = []
    for (const b of input.existingBullets) {
      const trimmed = b.trim()
      if (trimmed) lines.push(`- ${trimmed}`)
    }
    const transcript = input.transcript.trim()
    if (transcript) lines.push(`- ${transcript}`)
    return Promise.resolve(lines.join('\n'))
  },
}

export interface LlmSummarizerOptions {
  /** Given a prompt, return model completion text */
  complete: (prompt: string) => Promise<string>
  /** Optional override for the extraction prompt used by {@link Summarizer.summarize} */
  buildPrompt?: (transcript: string) => string
  /**
   * Optional override for the consolidation prompt used by {@link Summarizer.consolidate}.
   * Receives existing bullets (timestamp-stripped) plus the new transcript.
   */
  buildConsolidationPrompt?: (input: ConsolidateInput) => string
}

const DEFAULT_PROMPT = (transcript: string) => `You extract durable user facts from a conversation transcript for long-term memory.

Rules:
- Output ONLY bullet lines starting with "- " (markdown bullets).
- Each bullet is ONE canonical fact (preferences, decisions, constraints, names, dates).
- No preamble, no closing, no JSON.
- Merge duplicates; prefer stable phrasing (e.g. "prefers_window_seat: true").

Transcript:
---
${transcript}
---

Bullets:`

const DEFAULT_CONSOLIDATION_PROMPT = (input: ConsolidateInput) => {
  const existing = input.existingBullets.length
    ? input.existingBullets.map(b => `- ${b}`).join('\n')
    : '(none)'
  return `You maintain a long-term memory about a user. You are given (a) the existing memory as bullet lines and (b) a new conversation transcript. Produce the UPDATED COMPLETE set of memory bullets that should persist going forward.

Rules:
- Merge duplicates and near-duplicates into a single bullet.
- When facts conflict, keep ONLY the most recent value (e.g. if favorite color changed from cerulean to turquoise, keep turquoise).
- Drop small talk, greetings, agent replies, and anything transient.
- Keep durable facts: preferences, personal details, relationships, decisions, open follow-ups.
- Use canonical short forms: "favorite color: turquoise", "lives in Honolulu", "friend: Lindsay".
- Output ONLY the bullets, one per line, each prefixed with "- ". No preamble, no headers, no commentary.
- If there is nothing durable to remember, output nothing.

# Existing memory
${existing}

# New conversation transcript
${input.transcript}

# Task
Produce the updated complete memory bullet list.`
}

/** Factory for a summarizer backed by any LLM `complete` function */
export function createLlmSummarizer(options: LlmSummarizerOptions): Summarizer {
  const buildExtract = options.buildPrompt ?? DEFAULT_PROMPT
  const buildConsolidate = options.buildConsolidationPrompt ?? DEFAULT_CONSOLIDATION_PROMPT
  return {
    async summarize(text: string): Promise<string> {
      return options.complete(buildExtract(text))
    },
    async consolidate(input: ConsolidateInput): Promise<string> {
      return options.complete(buildConsolidate(input))
    },
  }
}
