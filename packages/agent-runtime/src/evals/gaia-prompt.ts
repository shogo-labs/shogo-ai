// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prompt builder for the GAIA benchmark.
 *
 * GAIA tasks are multi-step questions that require web search, file parsing,
 * calculation, and reasoning. The agent must produce a single concise final
 * answer that can be exact-matched against the gold label.
 */

export function buildGAIAPrompt(opts: {
  taskId: string
  question: string
  level: number
  hasAttachment: boolean
  attachmentPath?: string
}): string {
  const { taskId, question, level, hasAttachment, attachmentPath } = opts

  const parts = [
    `You are an expert research assistant. Answer the following question accurately and concisely.`,
    '',
    '## Question',
    '',
    question,
    '',
  ]

  if (hasAttachment && attachmentPath) {
    parts.push(
      '## Attached File',
      '',
      `A file relevant to this question has been placed in your workspace at: \`${attachmentPath}\``,
      'Read and analyze this file as needed to answer the question.',
      '',
    )
  }

  parts.push(
    '## Instructions',
    '',
    '1. **Plan first.** Before using any tools, write a brief plan listing the sub-questions you need to answer.',
    '2. Use your tools extensively:',
    '   - `web` with `query` parameter to search for factual information online.',
    '   - `web` with `url` parameter to read specific web pages.',
    '   - `exec` to run calculations, parse data, or process files.',
    '   - `read_file` to examine attached files.',
    '   - `browser` for interactive web pages that require navigation.',
    '   - `transcribe_audio` for audio file analysis.',
    '3. Cross-reference multiple sources when possible.',
    '4. **Verify before answering.** After completing your research, double-check your answer against the formatting rules below.',
    '',
    '## Answer Format',
    '',
    'YOUR FINAL ANSWER should be a number OR as few words as possible OR a comma separated list of numbers and/or strings.',
    '',
    '- If you are asked for a number, don\'t use comma to write your number neither use units such as $ or percent sign unless specified otherwise.',
    '- If you are asked for a string, don\'t use articles, neither abbreviations (e.g. for cities), and write the digits in plain text unless specified otherwise.',
    '- If you are asked for a comma separated list, apply the above rules depending on whether the element to be put in the list is a number or a string.',
    '- Do NOT include explanations or reasoning in the FINAL ANSWER line.',
    '- Do NOT hedge or say "approximately" — commit to a specific answer.',
    '',
    'Report your thoughts, then finish with:',
    '',
    '```',
    'FINAL ANSWER: [YOUR FINAL ANSWER]',
    '```',
    '',
    '## Self-Improvement',
    '',
    'After answering, if you learned something reusable — a formatting rule, a tool strategy, a recovery approach, or a common pitfall — write it as a skill to `.shogo/skills/<name>/SKILL.md` so future tasks benefit from your experience. Check existing skills first to avoid duplicates.',
    '',
    `Task ID: ${taskId} | Level: ${level}`,
  )

  return parts.join('\n')
}
