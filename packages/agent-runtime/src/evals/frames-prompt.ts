// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prompt builder for the FRAMES benchmark.
 *
 * FRAMES (Factuality, Retrieval, And reasoning MEasurement Set) tasks are
 * multi-hop questions requiring information from 2-15 Wikipedia articles.
 * The agent must search, retrieve, integrate facts across sources, and
 * produce a single concise final answer for exact-match scoring.
 */

export function buildFRAMESPrompt(opts: {
  question: string
  index: number
  reasoningTypes?: string
  numHops?: number
}): string {
  const { question, index, reasoningTypes, numHops } = opts

  const parts = [
    `You are an expert research assistant. Answer the following question accurately and concisely.`,
    `This is a multi-hop question that requires integrating information from multiple sources.`,
    '',
    '## Question',
    '',
    question,
    '',
    '## Instructions',
    '',
    '1. This question requires combining facts from multiple sources. Break it into sub-questions.',
    '2. Use your tools extensively:',
    '   - `web` with a `query` to search for factual information.',
    '   - `web` with a `url` to read specific web pages (especially Wikipedia articles).',
    '   - `exec` to run calculations or process data.',
    '3. Cross-reference multiple sources — do not rely on a single search result.',
    '4. After completing your research, provide your final answer.',
    '',
    '## Answer Format',
    '',
    'Report your reasoning, then finish with exactly:',
    '',
    '```',
    'FINAL ANSWER: <answer>',
    '```',
    '',
    'CRITICAL — your FINAL ANSWER must be the shortest possible correct response:',
    '',
    '- Give ONLY the answer itself — a name, number, place, or short phrase.',
    '- Do NOT write a full sentence. "Paris" not "The answer is Paris."',
    '- Do NOT include articles like "The" or "A" unless they are part of a proper noun (e.g. "The Hague").',
    '- Do NOT include trailing periods or punctuation.',
    '- If the answer is a number, give just the number with no units, commas, or suffixes (e.g. "37" not "37th", "1000" not "1,000").',
    '- If the answer is a name, give just the name (e.g. "Dmitri Mendeleev" not "Mendelevium is named after Dmitri Mendeleev").',
    '- If asked for a list, give a comma-separated list with the above rules applied to each element.',
    '- Do NOT include explanations, hedging, or "approximately" in the FINAL ANSWER line.',
    '',
  ]

  const meta: string[] = []
  meta.push(`#${index + 1}`)
  if (reasoningTypes) meta.push(`reasoning: ${reasoningTypes}`)
  if (numHops) meta.push(`hops: ${numHops}`)
  parts.push(meta.join(' | '))

  return parts.join('\n')
}
