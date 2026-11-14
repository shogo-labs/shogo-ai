// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-turn "who am I / what can this account do" facts, stamped onto the chat
 * request by the API server (see apps/api/src/lib/stamp-model-provider.ts and
 * stamp-workspace-plan.ts).
 *
 * Two production failure modes this addresses:
 *   - The agent denies its own model ("Hoshi 2.0 doesn't exist") because the
 *     product name is newer than the backing model's training data.
 *   - The agent promises "I'll deploy it now", does the work, and only then
 *     hits the Pro-plan gate on `publish`.
 */
/**
 * What publishing can actually do for this workspace, stamped by the API
 * (apps/api/src/lib/stamp-workspace-plan.ts) from the SAME sources the publish
 * route enforces: the plan's published-app caps and the substrate seam. The
 * agent otherwise fills this gap with guesses ("the pod sleeps, use a VPS",
 * "Vercel can't run a backend") — see SHO-362.
 */
export interface PublishHosting {
  /** Where published apps are provisioned. Metal runs one instance, no staging. */
  substrate: 'metal' | 'knative'
  /** The plan has at least one always-on slot, so a published app can stay awake. */
  alwaysOn: boolean
  /** Replica ceiling per environment; `null` = unlimited. */
  maxReplicas: number | null
  /** A staging environment can be created at `{sub}.shogo.one--staging`. */
  staging: boolean
}

export interface AccountContext {
  modelDisplayName?: string
  planId?: string
  canPublishSubdomain?: boolean
  publishHosting?: PublishHosting
  /**
   * Names of the caller's Team workspaces, stamped only on a Personal-workspace
   * chat (see apps/api/src/lib/stamp-team-workspace-names.ts). Software work
   * happens in a Team workspace, so the companion has to be able to say which
   * one to switch to (SHO-221). Present-but-empty means "this account has no
   * Team workspace yet"; absent means the field was never stamped.
   */
  teamWorkspaceNames?: string[]
}

const MAX_TEAM_WORKSPACE_NAMES = 5

export function parseAccountContext(body: Record<string, unknown>): AccountContext {
  const name = typeof body.modelDisplayName === 'string'
    ? sanitizeModelDisplayName(body.modelDisplayName)
    : ''
  const plan = typeof body.planId === 'string' && /^[a-z_]{1,24}$/.test(body.planId) ? body.planId : undefined
  const teamWorkspaceNames = parseTeamWorkspaceNames(body.teamWorkspaceNames)
  const publishHosting = parsePublishHosting(body.publishHosting)
  return {
    ...(name ? { modelDisplayName: name } : {}),
    ...(plan ? { planId: plan } : {}),
    ...(typeof body.canPublishSubdomain === 'boolean' ? { canPublishSubdomain: body.canPublishSubdomain } : {}),
    ...(publishHosting ? { publishHosting } : {}),
    ...(teamWorkspaceNames ? { teamWorkspaceNames } : {}),
  }
}

/**
 * The hosting stamp decides what the agent may claim about a published app, so
 * a malformed one is dropped entirely rather than half-rendered: an unrecognised
 * substrate must not silently read as "knative, scales".
 */
export function parsePublishHosting(raw: unknown): PublishHosting | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (r.substrate !== 'metal' && r.substrate !== 'knative') return undefined
  if (typeof r.alwaysOn !== 'boolean' || typeof r.staging !== 'boolean') return undefined
  const maxReplicas = r.maxReplicas
  if (maxReplicas !== null && (typeof maxReplicas !== 'number' || !Number.isFinite(maxReplicas) || maxReplicas < 1)) {
    return undefined
  }
  return { substrate: r.substrate, alwaysOn: r.alwaysOn, maxReplicas, staging: r.staging }
}

/** One sentence of what hosting does here, from the stamp — never more than it says. */
export function describePublishHosting(h: PublishHosting): string {
  const parts = ['full-stack hosting — the frontend, its server and its database — on a `*.shogo.one` URL or a domain the user owns']
  parts.push(h.alwaysOn ? 'always-on available' : 'no always-on on this plan, so a published app can sleep when idle')
  if (h.substrate === 'metal' || h.maxReplicas === 1) parts.push('one instance (no replicas)')
  else if (h.maxReplicas === null) parts.push('unlimited replicas')
  else parts.push(`up to ${h.maxReplicas} replicas`)
  parts.push(h.staging ? 'staging available' : 'no staging environment')
  return parts.join('; ')
}

/**
 * Workspace names come from a DB row the user named, and get printed in the
 * prompt in bold — so they go through the same flattening as the model name,
 * and the list is bounded (five names, each 80 chars).
 */
export function parseTeamWorkspaceNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const names: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const name = sanitizeModelDisplayName(entry)
    if (name) names.push(name)
    if (names.length >= MAX_TEAM_WORKSPACE_NAMES) break
  }
  return names
}

/**
 * A model name goes into the system prompt as markdown, in bold. Anything that
 * could break out of that line — a newline, a stray backtick or asterisk — is
 * flattened, and the name is bounded. One rule for every path that prints it:
 * the value the API stamps on the request, and the name the runtime resolves
 * for the turn (which can come from a DB row an admin typed into).
 */
export function sanitizeModelDisplayName(raw: string): string {
  return raw.replace(/[\r\n`*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}

export function buildAccountContextPrompt(ctx: AccountContext): string | null {
  const lines: string[] = []
  if (ctx.modelDisplayName) {
    lines.push(
      `- You are running on the **${ctx.modelDisplayName}** model. If the user asks which model you are, that is the answer — it is a real Shogo model even if you don't recognize the name.`,
    )
  }
  if (ctx.planId) {
    const plan = ctx.planId.charAt(0).toUpperCase() + ctx.planId.slice(1)
    if (ctx.canPublishSubdomain === false) {
      lines.push(
        `- Workspace plan: **${plan}**. This plan cannot publish to a \`*.shogo.one\` subdomain. Mention that only when the user asks to publish/deploy or when \`publish\` is called — not when they say they want to share their work. Sharing means the preview URL from \`preview_project\`, which anyone can open. If \`publish\` returns \`plan_not_allowed\`, the chat shows the user an Upgrade button; tell them their work is saved and they can publish once they upgrade.`,
      )
    } else if (ctx.canPublishSubdomain === true) {
      lines.push(`- Workspace plan: **${plan}**. Publishing to a \`*.shogo.one\` subdomain is available.`)
    } else {
      lines.push(`- Workspace plan: **${plan}**.`)
    }
  }
  if (ctx.publishHosting) {
    lines.push(`- Publishing: ${describePublishHosting(ctx.publishHosting)}. Say only this when the user asks about hosting, deploying, scaling, load testing or keeping something online; the Hosting section explains what you may not say.`)
  }
  if (ctx.teamWorkspaceNames) {
    const names = ctx.teamWorkspaceNames
    if (names.length > 0) {
      lines.push(
        `- The user's Team workspace${names.length > 1 ? 's' : ''} for building: ${names.map((n) => `**${n}**`).join(', ')}. Software work happens there, not in this Personal workspace — when they ask for an app, site, dashboard, tool or script, name the workspace to switch to.`,
      )
    } else {
      lines.push(
        `- The user has no Team workspace yet. Building happens in a Team workspace, which they can create from the workspace switcher in the sidebar.`,
      )
    }
  }
  return lines.length > 0 ? `## Account\n${lines.join('\n')}` : null
}
