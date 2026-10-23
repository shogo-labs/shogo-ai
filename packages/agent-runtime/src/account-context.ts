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
export interface AccountContext {
  modelDisplayName?: string
  planId?: string
  canPublishSubdomain?: boolean
}

export function parseAccountContext(body: Record<string, unknown>): AccountContext {
  const name = typeof body.modelDisplayName === 'string'
    ? sanitizeModelDisplayName(body.modelDisplayName)
    : ''
  const plan = typeof body.planId === 'string' && /^[a-z_]{1,24}$/.test(body.planId) ? body.planId : undefined
  return {
    ...(name ? { modelDisplayName: name } : {}),
    ...(plan ? { planId: plan } : {}),
    ...(typeof body.canPublishSubdomain === 'boolean' ? { canPublishSubdomain: body.canPublishSubdomain } : {}),
  }
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
        `- Workspace plan: **${plan}**. Publishing to a \`*.shogo.one\` subdomain requires Pro or higher, which this workspace does not have. Say so BEFORE starting any deploy/publish work, and also at the start of building something the user clearly means to put online (a website, landing page, portfolio, or app to share) — mention it once, briefly, then carry on. Offer what works on this plan instead: the preview URL for the app, or **share_file** for a single file. If \`publish\` returns \`plan_not_allowed\`, the chat shows the user an Upgrade button; tell them their work is saved and they can publish once they upgrade.`,
      )
    } else if (ctx.canPublishSubdomain === true) {
      lines.push(`- Workspace plan: **${plan}**. Publishing to a \`*.shogo.one\` subdomain is available.`)
    } else {
      lines.push(`- Workspace plan: **${plan}**.`)
    }
  }
  return lines.length > 0 ? `## Account\n${lines.join('\n')}` : null
}
