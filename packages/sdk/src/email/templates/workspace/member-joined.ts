// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const memberJoinedTemplate: EmailTemplate<{
  memberName: string
  memberEmail: string
  workspaceName: string
  role?: string
  dashboardUrl: string
  appName: string
}> = {
  name: 'member-joined',
  subject: '{{memberName}} joined {{workspaceName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">New Team Member</h1>
    <p class="email-text">
      <strong>{{memberName}}</strong> ({{memberEmail}}) has joined
      <strong>{{workspaceName}}</strong> as
      <span class="email-badge">{{role}}</span>.
    </p>
    <a href="{{dashboardUrl}}" class="email-btn-outline">View Team</a>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    role: 'Editor',
  },
}
