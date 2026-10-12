// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Single source of truth for whether the `browser` tool is available to the
 * main agent, and whether browsing is reached directly or via the browser
 * subagent.
 *
 * Personal-companion workspaces disable the whole `orchestration` capability
 * group (no `agent_spawn`), so they cannot delegate browsing to a subagent.
 * Historically `browser` was stripped from the personal main agent
 * (`SUBAGENT_ONLY_TOOLS`) while the prompt still inlined `BROWSER_TOOL_GUIDE`
 * and the Capabilities Index told the model to
 * `agent_spawn({ type: "browser" })` — a self-contradiction that produced the
 * "I can browse" / "I cannot open it" bug (issue #1044).
 *
 * `personalBrowserEnabled` (default OFF) is the single flag that re-admits the
 * browser tool to the personal main agent. Every advertisement/registration
 * surface (tool filtering, the inlined guide, the Capabilities Index browser
 * line and `subagentTypes`) reads one of these predicates so the surfaces can
 * never disagree.
 *
 * NOTE: flipping `personalBrowserEnabled` on ships an UNGUARDED personal
 * browser — there is no domain policy, per-turn budget,
 * confirmation-before-side-effect, or activity log yet (issue #1044 option 4).
 * The flag is rolled out gradually and defaults off for exactly that reason.
 *
 * This module deliberately has ZERO runtime imports (a local structural config
 * type only) so the predicates stay unit-testable without the agent-runtime
 * dependency graph.
 */

/** The subset of `GatewayConfig` these predicates read. */
export interface BrowserCapabilityConfig {
  capabilityProfile?: string
  browserEnabled?: boolean
  personalBrowserEnabled?: boolean
}

/**
 * Whether the personal-companion browser capability is explicitly enabled —
 * either via the `personalBrowserEnabled` config flag or the
 * `SHOGO_PERSONAL_BROWSER=1` rollout override. Defaults to off.
 */
export function isPersonalBrowserEnabled(config: BrowserCapabilityConfig): boolean {
  return config.personalBrowserEnabled === true || process.env.SHOGO_PERSONAL_BROWSER === '1'
}

/**
 * Whether the main agent's tool list should include `browser` — the single
 * gate shared by the tool filter, the inlined browser guide and the
 * Capabilities Index.
 * - Non-personal (team/enterprise): available unless `browserEnabled === false`.
 * - Personal: available only when `personalBrowserEnabled` (or the env
 *   override) is on.
 */
export function mainAgentBrowserAvailable(config: BrowserCapabilityConfig): boolean {
  return config.browserEnabled !== false && (config.capabilityProfile !== 'personal' || isPersonalBrowserEnabled(config))
}

/**
 * Whether browsing is reached via the browser subagent (team workspaces)
 * rather than called directly. Personal workspaces have no orchestration at
 * all, so this is always false there.
 */
export function browserIsDelegated(config: BrowserCapabilityConfig): boolean {
  return config.capabilityProfile !== 'personal'
}
