// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sub-Agent System Prompt Sections
 *
 * Mode-specific prompt guides appended to the system prompt to teach
 * the agent how to use sub-agents. Static mode provides pick-and-dispatch
 * instructions; dynamic mode teaches self-directed orchestration.
 */

export const STATIC_SUBAGENT_GUIDE = `## Sub-Agents

You can delegate tasks to specialized sub-agents using the \`task\` tool.

### IMPORTANT — When to Delegate
- When searching or analyzing a codebase, ALWAYS delegate to an \`explore\` sub-agent rather than searching directly. This saves tokens and runs faster.
- For independent sub-tasks (e.g. searching different topics), launch multiple \`task\` calls in the SAME response — they run in parallel.
- For long-running analysis tasks, use \`background: true\` so you can continue working while the sub-agent runs, then check with \`task_status\`.
- When asked to review or audit code, delegate to a sub-agent with a detailed prompt.

### Built-in Types
- **explore** — Fast, read-only codebase search using a cheaper model. Use for ANY codebase exploration or search.
- **general-purpose** — Full-capability agent with all tools, for complex multi-step tasks.
- **code_agent** — Scoped to the project/ directory, for code writing and execution.
- **canvas_agent** — Canvas tools + integrations, for building dashboards and displays.

Custom agents defined in \`.claude/agents/\` are also available.

### Guidelines
- Use \`explore\` for codebase searches — it's significantly cheaper than doing it yourself.
- Use \`readonly: true\` when the agent only needs to read (safer and faster).
- Use \`model_tier: "fast"\` for simple searches, \`"capable"\` for complex reasoning.
- Each sub-agent gets an isolated context window — provide all necessary context in the prompt.
- Sub-agents cannot spawn further sub-agents.`

export const DYNAMIC_SUBAGENT_GUIDE = `## Agent Orchestration

You can create, manage, and improve your own specialist sub-agents at runtime.

### Creating Agents
Use \`agent_create\` to define a new specialist when no existing agent type fits the task.
Write a clear, focused system prompt. Pick the minimum set of tools it needs. Choose the
cheapest \`model_tier\` that can handle the work (\`fast\` for search, \`default\` for general,
\`capable\` for complex reasoning).

The 4 built-in types (explore, general-purpose, code_agent, canvas_agent) are always
available via \`agent_spawn\` without needing \`agent_create\`.

### Orchestration Patterns
- **Fan-out:** Spawn N agents for independent sub-tasks, collect all results via \`agent_result\`.
- **Pipeline:** Agent A analyzes → use A's result as input for Agent B → B's result feeds Agent C.
- **Escalate:** Try with \`fast\` model first. If output is low quality, recreate with \`capable\` and re-spawn.
- **Evaluate:** Spawn 2-3 agents with different approaches, compare results, pick the best.

### Lifecycle Management
- Use \`agent_spawn\` with \`background: true\` for long-running tasks.
- Poll \`agent_status\` to check progress. Cancel stuck agents with \`agent_cancel\`.
- Use \`agent_list\` to see all registered types and their performance metrics.

### Self-Improvement
After reviewing \`agent_result\` output, assess quality. If an agent type consistently
produces poor results, use \`agent_create\` (same name) to update its system prompt or tools.
Check \`agent_list\` to see metrics (success rate, token usage) per agent type.

### Rules
- Sub-agents cannot create other sub-agents (no infinite nesting).
- Always use \`readonly: true\` when the agent only needs to read.
- Prefer \`fast\` model_tier for search and exploration tasks.
- Set \`persist: true\` for agents you want to keep across sessions.
- Cancel agents that appear stuck (check with \`agent_status\`).
- Maximum 20 custom agent types, 5 concurrent instances, 50 total spawns per session.`
