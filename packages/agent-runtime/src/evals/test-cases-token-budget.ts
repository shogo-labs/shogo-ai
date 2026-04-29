// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Token Budget Eval
 *
 * Sends "this is a test just respond back with test" on a fresh session and
 * validates that the total token cost stays within the expected budget. This
 * catches prompt bloat regressions — if someone accidentally inlines a 10k-token
 * guide in the system prompt, this eval will fail.
 *
 * Token accounting:
 *   Pi Agent Core adds cache_control to both the system prompt and the last
 *   user message. Anthropic reports:
 *     - cache_creation_input_tokens: tokens entering cache for the first time
 *     - cache_read_input_tokens: tokens read from cache (subsequent calls)
 *     - input_tokens: non-cached input (dynamic zone, new messages)
 *
 *   sumUsage (pi-adapter.ts) sums across ALL iterations in a single turn.
 *   If the agent makes a tool call, the second iteration reads the cached
 *   prefix while also writing new messages to cache, roughly doubling
 *   the total reported tokens.
 *
 *   Verified baseline (April 2026, Haiku, fresh session, eval workspace):
 *     - System prompt (stable + dynamic): ~4,400 tokens
 *     - Tool definitions (~32 tools):     ~4,600 tokens
 *     - Dynamic workspace content:        ~1,400 tokens
 *       (AGENTS.md, workspace file tree, skills, etc.)
 *     - STACK.md preview (~200 words):    ~300 tokens
 *       (full STACK.md available via read_file; saves ~5,900 tok/turn)
 *     - User message overhead:            ~350 tokens
 *     Total first message:                ~12,500 tokens (cache_write)
 *
 *   17 tools are now delegated to subagents (browser, tool_*, mcp_*,
 *   channel_*, send_message, generate_image, transcribe_audio, heartbeat_*,
 *   server_sync), saving ~4,000 schema tokens vs the original 53 tools.
 *   The `web` tool stays on the main agent for direct HTTP fetching.
 *
 *   Ceiling of 16,000 accounts for the eval workspace's seeded content
 *   while still catching regressions.
 *   Floor of 5,000 catches accidentally gutted prompts.
 */

import type { AgentEval } from './types'

const TOKEN_CEILING = 16_000
const TOKEN_FLOOR = 5_000

function totalInputTokens(r: { metrics: { tokens: { input: number; cacheRead: number; cacheWrite: number } } }): number {
  return r.metrics.tokens.input + r.metrics.tokens.cacheWrite + r.metrics.tokens.cacheRead
}

export const TOKEN_BUDGET_EVALS: AgentEval[] = [
  {
    id: 'token-budget-baseline',
    name: 'Token Budget: first message on fresh session stays under budget',
    category: 'tool-system',
    level: 1,
    input: 'this is a test just respond back with test',
    maxScore: 100,

    validationCriteria: [
      {
        id: 'total-tokens-under-ceiling',
        description: `Total input tokens (input + cache_write + cache_read) <= ${TOKEN_CEILING.toLocaleString()}`,
        points: 40,
        phase: 'execution',
        validate: (r) => {
          const total = totalInputTokens(r)
          return total > 0 && total <= TOKEN_CEILING
        },
      },
      {
        id: 'total-tokens-above-floor',
        description: `Total input tokens >= ${TOKEN_FLOOR.toLocaleString()} (prompt not accidentally gutted)`,
        points: 20,
        phase: 'execution',
        validate: (r) => {
          return totalInputTokens(r) >= TOKEN_FLOOR
        },
      },
      {
        id: 'output-tokens-reasonable',
        description: 'Output tokens < 500 (simple echo, no runaway generation)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          return r.metrics.tokens.output > 0 && r.metrics.tokens.output < 500
        },
      },
      {
        id: 'no-tool-calls',
        description: 'No tool calls for a simple echo request',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length === 0,
      },
      {
        id: 'single-iteration',
        description: 'Completed in a single LLM iteration',
        points: 10,
        phase: 'execution',
        validate: (r) => r.metrics.iterations <= 1,
      },
    ],

    antiPatterns: [
      'Agent called tools on a simple echo request',
      'Agent generated an excessively long response',
    ],
  },
]
