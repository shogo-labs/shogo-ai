// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Email Templates
 *
 * All Shogo-branded transactional email templates.
 * Uses <style> blocks with CSS classes — no inline styles.
 */

export { wrapInLayout, EMAIL_CONSTANTS } from './_layout.js'

// Auth
export { welcomeTemplate } from './auth/welcome.js'
export { passwordResetTemplate } from './auth/password-reset.js'
export { emailVerificationTemplate } from './auth/email-verification.js'

// Invitations
export { workspaceInviteTemplate } from './invitation/workspace-invite.js'
export { projectInviteTemplate } from './invitation/project-invite.js'
export { inviteAcceptedTemplate } from './invitation/invite-accepted.js'

// Billing
export { planUpgradedTemplate } from './billing/plan-upgraded.js'
export { paymentReceiptTemplate } from './billing/payment-receipt.js'
export { paymentFailedTemplate } from './billing/payment-failed.js'

// Workspace
export { memberJoinedTemplate } from './workspace/member-joined.js'
export { memberRemovedTemplate } from './workspace/member-removed.js'
export { accountDeletedTemplate } from './workspace/account-deleted.js'

// ─── Registry ────────────────────────────────────────────

import type { EmailTemplate } from '../types.js'
import { EmailTemplateRegistry } from '../templates.js'

import { welcomeTemplate } from './auth/welcome.js'
import { passwordResetTemplate } from './auth/password-reset.js'
import { emailVerificationTemplate } from './auth/email-verification.js'
import { workspaceInviteTemplate } from './invitation/workspace-invite.js'
import { projectInviteTemplate } from './invitation/project-invite.js'
import { inviteAcceptedTemplate } from './invitation/invite-accepted.js'
import { planUpgradedTemplate } from './billing/plan-upgraded.js'
import { paymentReceiptTemplate } from './billing/payment-receipt.js'
import { paymentFailedTemplate } from './billing/payment-failed.js'
import { memberJoinedTemplate } from './workspace/member-joined.js'
import { memberRemovedTemplate } from './workspace/member-removed.js'
import { accountDeletedTemplate } from './workspace/account-deleted.js'

export const allTemplates: EmailTemplate[] = [
  welcomeTemplate,
  passwordResetTemplate,
  emailVerificationTemplate,
  workspaceInviteTemplate,
  projectInviteTemplate,
  inviteAcceptedTemplate,
  planUpgradedTemplate,
  paymentReceiptTemplate,
  paymentFailedTemplate,
  memberJoinedTemplate,
  memberRemovedTemplate,
  accountDeletedTemplate,
]

/**
 * Create a template registry pre-loaded with all Shogo templates.
 */
export function createShogoTemplateRegistry(): EmailTemplateRegistry {
  const registry = new EmailTemplateRegistry()
  for (const template of allTemplates) {
    registry.register(template)
  }
  return registry
}
