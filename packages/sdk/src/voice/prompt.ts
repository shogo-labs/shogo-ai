// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * System-prompt composer for the voice agent.
 *
 * Layers three concerns on top of the caller's base prompt:
 *   1. Expressivity block   (audio tags allow-list + usage rules)
 *   2. Memory block         (`{{user_context}}` placeholder + `add_memory` tool doc)
 *
 * Each block is wrapped in a delimiter comment so repeated calls remain
 * idempotent — calling `composeAgentPrompt` on an already-composed prompt
 * produces the same output because the old blocks are stripped first.
 */

import {
  composeExpressivityBlock,
  stripExpressivityBlock,
  type Expressivity,
} from './audioTags.js'

/** Default memory guidance appended when memory tools are enabled. */
export const DEFAULT_MEMORY_BLOCK = `# Memory

Known context about this user from past conversations:
{{user_context}}

Memory retrieval is automatic — the top matching facts are already injected above. Never say "let me check my memory" or "searching memories."

You have one tool:
- add_memory(fact): save a concise, canonical fact about the user — preferences, decisions, personal details, follow-ups. Use short normalized phrasings like "favorite color: green" or "lives in Honolulu". Always call it when the user explicitly asks you to remember something.`

/**
 * Strip a previously-appended memory block from a prompt so we can re-append
 * cleanly. Handles both the exact heading we emit and the older `<!-- zix-memory-vN -->`
 * marker for backwards compatibility.
 */
export function stripMemoryBlock(prompt: string): string {
  if (!prompt) return prompt
  return prompt
    .replace(/\n*<!-- zix-memory-v\d+ -->[\s\S]*$/m, '')
    .replace(/\n*# Memory\s*\n\s*Known context about this user[\s\S]*$/m, '')
    .trimEnd()
}

export interface ComposeAgentPromptOptions {
  /** `off` disables the expressivity block entirely. Default: `subtle`. */
  expressivity?: Expressivity
  /** Allowed audio tags. `null` ⇒ use DEFAULT_ALLOWED_TAGS. */
  audioTags?: string[] | null
  /**
   * Memory guidance appended to the end of the prompt. Pass `null` to omit
   * the memory block entirely (useful for agents that don't use memory tools).
   * Default: {@link DEFAULT_MEMORY_BLOCK}.
   */
  memoryBlock?: string | null
}

/**
 * Strip the expressivity + memory blocks from an arbitrary prompt, returning
 * the base prompt the app originally supplied.
 */
export function extractBasePrompt(prompt: string): string {
  return stripExpressivityBlock(stripMemoryBlock(prompt))
}

/**
 * Compose the final system prompt that gets sent to ElevenLabs. Idempotent:
 * passing an already-composed prompt back in produces the same output.
 */
export function composeAgentPrompt(
  basePrompt: string,
  options: ComposeAgentPromptOptions = {},
): string {
  const { expressivity = 'subtle', audioTags = null, memoryBlock = DEFAULT_MEMORY_BLOCK } = options
  const stripped = extractBasePrompt(basePrompt)
  const expr = composeExpressivityBlock(expressivity, audioTags)
  const parts: string[] = [stripped]
  if (expr) parts.push(expr)
  if (memoryBlock) parts.push(memoryBlock)
  return parts.join('\n\n')
}
