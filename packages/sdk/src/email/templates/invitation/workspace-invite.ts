// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const workspaceInviteTemplate: EmailTemplate<{
  inviterName: string
  workspaceName: string
  role?: string
  acceptUrl: string
  appName: string
}> = {
  name: 'workspace-invite',
  subject: '{{inviterName}} invited you to {{workspaceName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">You're Invited!</h1>
    <p class="email-text">
      <strong>{{inviterName}}</strong> has invited you to join the
      <strong>{{workspaceName}}</strong> workspace as
      <span class="email-badge">{{role}}</span>.
    </p>
    <p class="email-text">
      Accept the invitation to start collaborating on projects, share
      resources, and build together.
    </p>
    <a href="{{acceptUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">Accept Invitation</a>
    <hr class="email-divider">
    <p class="email-muted">
      If you weren't expecting this, you can safely ignore this email.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    role: 'Editor',
  },
}
