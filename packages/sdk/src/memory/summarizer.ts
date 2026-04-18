// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { Summarizer } from './types.js'

/** Passthrough summarizer — returns input unchanged (useful for testing or storing raw summaries). */
export const identitySummarizer: Summarizer = {
  summarize(text: string): Promise<string> {
    return Promise.resolve(text)
  },
}

export interface LlmSummarizerOptions {
  /** Given a prompt, return model completion text */
  complete: (prompt: string) => Promise<string>
  /** Optional override for the extraction prompt */
  buildPrompt?: (transcript: string) => string
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

/** Factory for a summarizer backed by any LLM `complete` function */
export function createLlmSummarizer(options: LlmSummarizerOptions): Summarizer {
  const build = options.buildPrompt ?? DEFAULT_PROMPT
  return {
    async summarize(text: string): Promise<string> {
      const prompt = build(text)
      return options.complete(prompt)
    },
  }
}
