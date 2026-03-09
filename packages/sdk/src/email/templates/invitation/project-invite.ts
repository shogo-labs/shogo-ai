// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const projectInviteTemplate: EmailTemplate<{
  inviterName: string
  projectName: string
  workspaceName?: string
  role?: string
  acceptUrl: string
  appName: string
}> = {
  name: 'project-invite',
  subject: '{{inviterName}} invited you to {{projectName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Project Invitation</h1>
    <p class="email-text">
      <strong>{{inviterName}}</strong> has invited you to the
      <strong>{{projectName}}</strong> project as
      <span class="email-badge">{{role}}</span>.
    </p>
    <a href="{{acceptUrl}}" class="email-btn">Accept Invitation</a>
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
