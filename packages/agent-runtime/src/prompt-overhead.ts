// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the request costs *besides* its messages: the system prompt and the tool
 * schemas that actually go on the wire.
 *
 * Since SHO-97 only the advertised tool set is sent — a deferred tool keeps a
 * one-line catalog entry in the system prompt and no schema in the request. Two
 * places need that number and they must agree, or the compactor fires on
 * phantom tokens (SHO-381: ~330k of deferred schemas made every turn in a
 * tool-heavy workspace look like it was over the 235k cap, so it compacted
 * every turn and could never get its estimate under ~370k):
 *
 *   - the prompt breakdown the dock shows, and
 *   - `MidTurnAutocompactor`'s trigger estimate.
 *
 * Both go through `advertisedTools` / `toolSchemaChars` here, so the filter
 * cannot drift between them again.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'

/** Chars of the schema a provider receives for one tool. */
export function toolSchemaChars(tool: AgentTool): number {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }).length
}

/**
 * The tools whose schemas are sent. `isAdvertisedTool` is undefined when
 * deferral is off, in which case every tool is sent.
 */
export function advertisedTools(
  tools: readonly AgentTool[],
  isAdvertisedTool?: (tool: AgentTool) => boolean,
): AgentTool[] {
  return isAdvertisedTool ? tools.filter((tool) => isAdvertisedTool(tool)) : [...tools]
}

export interface PromptOverheadInput {
  systemPrompt: string
  tools: readonly AgentTool[]
  isAdvertisedTool?: (tool: AgentTool) => boolean
}

/** System prompt + advertised tool schemas, in tokens. */
export function promptOverheadTokens(input: PromptOverheadInput): number {
  const schemaChars = advertisedTools(input.tools, input.isAdvertisedTool).reduce(
    (sum, tool) => sum + toolSchemaChars(tool),
    0,
  )
  return Math.ceil(input.systemPrompt.length / 4) + Math.ceil(schemaChars / 4)
}

/**
 * A per-call overhead reader for the mid-turn compactor.
 *
 * The advertised set changes *within* a turn — `read_guide` activates a
 * deferred tool, `connect` hot-adds MCP tools — so the number has to be read
 * when the request is about to be sent, not once when the turn starts. The
 * schema strings are memoized on the advertised names, so a turn that never
 * changes its set pays the stringify once.
 */
export function createPromptOverheadReader(input: PromptOverheadInput): () => number {
  let cachedNames: string | null = null
  let cachedTokens = 0
  return () => {
    const advertised = advertisedTools(input.tools, input.isAdvertisedTool)
    const names = advertised.map((tool) => tool.name).join('\u0000')
    if (names !== cachedNames) {
      cachedNames = names
      cachedTokens = promptOverheadTokens({ ...input, tools: advertised, isAdvertisedTool: undefined })
    }
    return cachedTokens
  }
}
