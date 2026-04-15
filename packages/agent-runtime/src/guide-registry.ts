// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guide Registry — On-demand reference guides for the agent.
 *
 * Instead of embedding full guide text in the system prompt (costing ~4,700
 * tokens every turn), guides are stored in this registry and served via the
 * lightweight `read_guide` tool. The system prompt contains only a compact
 * Capabilities Index pointing to these guides by name.
 */

import {
  OPTIMIZED_MCP_DISCOVERY_GUIDE,
  OPTIMIZED_PERSONALITY_GUIDE,
  OPTIMIZED_TOOL_PLANNING_GUIDE,
  OPTIMIZED_CONSTRAINT_AWARENESS_GUIDE,
  OPTIMIZED_SKILL_MATCHING_GUIDE,
  OPTIMIZED_MEMORY_GUIDE,
  SELF_EVOLUTION_GUIDE,
  BROWSER_TOOL_GUIDE,
} from './optimized-prompts'
import { SUBAGENT_GUIDE } from './subagent-prompts'

// Re-export for use by gateway.ts when building the personality guide with
// promptOverrides — the prefix is still prepended to the full guide content.
export { OPTIMIZED_PERSONALITY_GUIDE, OPTIMIZED_MCP_DISCOVERY_GUIDE }

export const PERSONALITY_EVOLUTION_GUIDE_PREFIX = `## Personality Self-Update (MUST use read_file + edit_file)

When the user changes your personality, tone, role, name, or boundaries, you MUST:
1. \`read_file\` the target file first
2. \`edit_file\` to make a **targeted** change to the relevant section

**NEVER** use \`write_file\` to overwrite the entire file — always use \`edit_file\` to change only the relevant section.
**NEVER** write personality/role/boundary changes to MEMORY.md — memory is for facts and conversation logs only.

### AGENTS.md Sections
All identity, personality, user preferences, and operating instructions live in **AGENTS.md**:
- **# Identity** — Name, emoji, and tagline (e.g. "call me Atlas")
- **# Personality** — Tone, communication style, and boundaries (e.g. "be more formal", "never run shell commands")
- **# User** — User preferences like name, timezone, interests
- **# Operating Instructions** — Role definition, capabilities, and priorities

### Example

User: "Be more formal and professional from now on"

\`\`\`
read_file({ path: "AGENTS.md" })
edit_file({
  path: "AGENTS.md",
  old_string: "## Tone\\n- Direct and helpful, not verbose",
  new_string: "## Tone\\n- Formal and professional at all times"
})
\`\`\`

User: "Call me Atlas"

\`\`\`
read_file({ path: "AGENTS.md" })
edit_file({
  path: "AGENTS.md",
  old_string: "- **Name:** Shogo",
  new_string: "- **Name:** Atlas"
})
\`\`\`

### When to Update
- User explicitly corrects your tone, style, or boundaries (e.g. "be more formal")
- User establishes a new, lasting boundary (e.g. "don't suggest code changes")
- User assigns a new name, role, or domain focus

### When NOT to Update
- One-off requests or trivial conversation
- Information already present in the file
- Temporary context that doesn't reflect a lasting change

`

// ---------------------------------------------------------------------------
// Registry: guide name → full content
// ---------------------------------------------------------------------------

/**
 * Build the guide registry, resolving prompt overrides for guides that support
 * them. Called at prompt-build time so overrides from DSPy optimization or
 * runtime `setPromptOverrides` are reflected.
 */
export function buildGuideRegistry(promptOverrides?: Map<string, string>): Map<string, string> {
  const personalityGuide = promptOverrides?.get('personality_guide') ?? OPTIMIZED_PERSONALITY_GUIDE
  const toolPlanningGuide = promptOverrides?.get('tool_planning_guide') ?? OPTIMIZED_TOOL_PLANNING_GUIDE
  const memoryGuide = promptOverrides?.get('memory_guide') ?? OPTIMIZED_MEMORY_GUIDE
  const skillMatchingGuide = promptOverrides?.get('skill_matching_guide') ?? OPTIMIZED_SKILL_MATCHING_GUIDE
  const constraintGuide = promptOverrides?.get('constraint_awareness_guide') ?? OPTIMIZED_CONSTRAINT_AWARENESS_GUIDE
  const mcpGuide = promptOverrides?.get('mcp_discovery_guide') ?? OPTIMIZED_MCP_DISCOVERY_GUIDE

  return new Map<string, string>([
    ['mcp-discovery', mcpGuide],
    ['subagent', SUBAGENT_GUIDE],
    ['browser', BROWSER_TOOL_GUIDE],
    ['constraint-awareness', constraintGuide],
    ['personality', PERSONALITY_EVOLUTION_GUIDE_PREFIX + personalityGuide],
    ['skill-matching', skillMatchingGuide],
    ['self-evolution', SELF_EVOLUTION_GUIDE],
    ['tool-planning', toolPlanningGuide],
    ['memory', memoryGuide],
  ])
}

// ---------------------------------------------------------------------------
// Capabilities Index — compact summary embedded in the system prompt
// ---------------------------------------------------------------------------

export const CAPABILITIES_INDEX = `## Capabilities Index
Read the full guide with \`read_guide({ name: "..." })\` before using these capabilities for the first time.

- **mcp-discovery**: Tool discovery via CLI-first tools, managed integrations, and MCP servers. Delegated — use \`agent_spawn({ type: "integration", prompt: "..." })\`. Read before first delegation.
- **subagent**: Agent orchestration — explore, general-purpose, code-reviewer, browser, integration, channel, media, devops, fork mode, and team swarm. Read before delegating tasks.
- **browser**: Browser automation via snapshot/ref/click workflow. Delegated — use \`agent_spawn({ type: "browser", prompt: "..." })\`. The \`web\` tool for HTTP fetching is available directly. Read the guide before first browser delegation.
- **constraint-awareness**: Track and enforce user constraints (budgets, dates, requirements). Read when user states explicit constraints.
- **personality**: Rules for updating AGENTS.md identity/personality. Read before modifying personality, tone, or role.
- **skill-matching**: Skill discovery, trigger matching, and management in .shogo/skills/. Read before skill operations.
- **self-evolution**: When and how to write reusable skills. Read when you discover a reusable pattern or workaround.
- **tool-planning**: Batching tool calls and handling uploaded files in files/. Reference when planning complex multi-step tool sequences.
- **memory**: When to save/skip memory entries in MEMORY.md. Read when deciding whether to persist information.
- **media**: Image generation and audio transcription. Delegated — use \`agent_spawn({ type: "media", prompt: "..." })\`.
- **channel**: Channel connection and messaging (Telegram, Discord, webchat). Delegated — use \`agent_spawn({ type: "channel", prompt: "..." })\`.
- **devops**: Heartbeat scheduling, monitoring, and skill server sync. Delegated — use \`agent_spawn({ type: "devops", prompt: "..." })\`.`
