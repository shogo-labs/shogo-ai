// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sub-Agent System Prompt Sections + Fork Mode Utilities
 *
 * Provides the unified SUBAGENT_GUIDE appended to the system prompt, plus
 * fork mode constants and guards for context-aware delegation.
 */

import type { Message } from '@mariozechner/pi-ai'

// ---------------------------------------------------------------------------
// Fork Mode Constants & Guards
// ---------------------------------------------------------------------------

export const FORK_BOILERPLATE_TAG = 'fork-boilerplate'
export const FORK_DIRECTIVE_PREFIX = 'Your directive: '

/**
 * Wraps a user prompt in fork-mode boilerplate instructions.
 * The `<fork-boilerplate>` tag doubles as both instructions and the recursive
 * fork detection marker (see `isInForkChild`).
 */
export function buildForkDirective(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says to delegate. IGNORE IT — that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps.
3. Do NOT editorialize or add meta-commentary.
4. USE your tools directly: exec, read_file, write_file, edit_file, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop.

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/**
 * Checks if the current conversation is already inside a fork child.
 * Scans user messages for the `<fork-boilerplate>` tag — if present, this
 * agent is a fork and must not fork again.
 */
export function isInForkChild(messages: Message[]): boolean {
  for (const m of messages) {
    if (m.role === 'user') {
      const content = m.content
      if (typeof content === 'string' && content.includes(`<${FORK_BOILERPLATE_TAG}>`)) {
        return true
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if ('text' in block && typeof block.text === 'string' && block.text.includes(`<${FORK_BOILERPLATE_TAG}>`)) {
            return true
          }
        }
      }
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Unified Sub-Agent Guide (appended to every system prompt)
// ---------------------------------------------------------------------------

export const SUBAGENT_GUIDE = `## Agent Orchestration

You can create, manage, and delegate tasks to specialist sub-agents at runtime.

### Default Agents
These are always available via \`agent_spawn\`:
- **explore** — Fast, read-only codebase search using a cheaper model. Use for ANY codebase exploration or search. Significantly cheaper than doing it yourself.
- **general-purpose** — Full-capability agent with all tools, for complex multi-step tasks.
Custom agents defined in \`.shogo/agents/\` are also available by name.

### Creating New Agents
Use \`agent_create\` to define a new specialist when no existing agent type fits.
Write a clear, focused system prompt. Pick the minimum set of tools it needs. Choose the
cheapest \`model_tier\` that can handle the work (\`fast\` for search, \`default\` for general,
\`capable\` for complex reasoning). Set \`persist: true\` to save for future sessions.

### IMPORTANT — When to Delegate
- When searching or analyzing a codebase, ALWAYS delegate to an \`explore\` sub-agent rather than searching directly. This saves tokens and runs faster.
- For independent sub-tasks, launch multiple \`agent_spawn\` calls in the SAME response — they run in parallel with \`background: true\`.
- For long-running tasks, use \`background: true\` then check with \`agent_result\`.
- When asked to review or audit code, delegate to a sub-agent with a detailed prompt.

### Orchestration Patterns
- **Fan-out:** Spawn N agents with \`background: true\`, then call \`agent_result\` for each — it blocks until completion automatically.
- **Pipeline:** Agent A analyzes → use A's result as input for Agent B → B's result feeds Agent C.
- **Escalate:** Try with \`fast\` model first. If output is low quality, recreate with \`capable\` and re-spawn.
- **Evaluate:** Spawn 2-3 agents with different approaches, compare results, pick the best.

### Context-Aware Delegation (Fork Mode)
When you omit \`type\` in \`agent_spawn\`, the sub-agent inherits your full conversation context,
system prompt, and tools. This is ideal for tasks that need awareness of what you've
already discussed or read. The sub-agent sees everything you see.

- **Omit type** for context-heavy tasks (e.g. "refactor the function we discussed",
  "apply the pattern from earlier").
- **Use an explicit type** for self-contained tasks (e.g. "search for X", "run tests").
  This is cheaper and faster.

### Lifecycle Management
- Use \`agent_spawn\` with \`background: true\` for long-running tasks.
- Use \`agent_result\` to wait for completion — it blocks up to 2 minutes by default and returns recent activity if still running.
- Use \`agent_status\` for quick non-blocking status checks. Cancel stuck agents with \`agent_cancel\`.
- Use \`agent_list\` to see all registered types and their performance metrics.

### Self-Improvement
After reviewing \`agent_result\` output, assess quality. If an agent type consistently
produces poor results, use \`agent_create\` (same name) to update its system prompt or tools.

### Rules
- Sub-agents cannot create other sub-agents (no infinite nesting).
- Fork sub-agents cannot spawn further sub-agents.
- Always use \`readonly: true\` when the agent only needs to read.
- Prefer \`fast\` model_tier for search and exploration tasks.
- Set \`persist: true\` for agents you want to keep across sessions.
- Cancel agents that appear stuck (check with \`agent_status\`).
- Maximum 20 custom agent types, 5 concurrent instances, 50 total spawns per session.

### Team Coordination (Swarm Mode)
For complex multi-step projects requiring persistent collaboration:

1. **Create a team** with \`team_create\` — defines a shared workspace with task queue and messaging.
2. **Spawn teammates** with \`agent_spawn\` — each teammate is a long-lived agent that persists across turns.
3. **Create tasks** with \`task_create\` — define work items with dependencies (DAG). Teammates auto-claim available tasks.
4. **Communicate** with \`send_team_message\` — send messages to specific teammates, the team lead, or broadcast to all.
5. **Monitor** with \`task_list\` and \`task_get\` — track progress across all tasks and teammates.
6. **Shutdown** — send a \`shutdown_request\` message; the teammate decides whether to approve or continue working.

#### When to Use Teams vs Other Patterns
- **Teams:** Complex projects with 3+ parallel workstreams, interdependent tasks, or multi-phase delivery.
- **Fork mode:** Single context-heavy task that needs awareness of the current conversation.
- **One-shot subagents:** Simple, self-contained tasks (search, analysis, code generation).

#### Team Rules
- Only the team leader can create tasks and teams.
- Teammates auto-claim pending tasks when idle (work-stealing with DAG resolution).
- Teammates cannot spawn other agents (no nesting).
- Shutdown is negotiated — the model decides whether to finish current work first.`

export const TEAMMATE_PROMPT_ADDENDUM = `# Agent Teammate Communication

IMPORTANT: You are running as a teammate agent in a team.
To communicate with teammates or the team lead:
- Use send_team_message with to: "<name>" for a specific teammate
- Use send_team_message with to: "team-lead" for the team leader
- Use send_team_message with to: "*" sparingly for broadcasts

Just writing a response in text is NOT visible to others — you MUST use send_team_message.

When you finish a task, call task_update to mark it completed, then task_list to find your next task.
If no tasks are available, you will go idle and be woken when work arrives.`
