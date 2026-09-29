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
    ? body.modelDisplayName.replace(/[\r\n`*]/g, ' ').trim().slice(0, 80)
    : ''
  const plan = typeof body.planId === 'string' && /^[a-z_]{1,24}$/.test(body.planId) ? body.planId : undefined
  return {
    ...(name ? { modelDisplayName: name } : {}),
    ...(plan ? { planId: plan } : {}),
    ...(typeof body.canPublishSubdomain === 'boolean' ? { canPublishSubdomain: body.canPublishSubdomain } : {}),
  }
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
        `- Workspace plan: **${plan}**. Publishing to a \`*.shogo.one\` subdomain requires Pro or higher, which this workspace does not have. Say so BEFORE starting any deploy/publish work, and offer what works on this plan instead: the preview URL for the app, or **share_file** for a single file.`,
      )
    } else if (ctx.canPublishSubdomain === true) {
      lines.push(`- Workspace plan: **${plan}**. Publishing to a \`*.shogo.one\` subdomain is available.`)
    } else {
      lines.push(`- Workspace plan: **${plan}**.`)
    }
  }
  return lines.length > 0 ? `## Account\n${lines.join('\n')}` : null
}
