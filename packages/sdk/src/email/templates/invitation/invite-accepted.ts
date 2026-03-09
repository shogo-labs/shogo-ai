// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const inviteAcceptedTemplate: EmailTemplate<{
  inviteeName: string
  inviteeEmail: string
  resourceName: string
  resourceType?: string
  dashboardUrl: string
  appName: string
}> = {
  name: 'invite-accepted',
  subject: '{{inviteeName}} accepted your invitation to {{resourceName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Invitation Accepted</h1>
    <p class="email-text">
      <strong>{{inviteeName}}</strong> ({{inviteeEmail}}) has accepted your
      invitation to join <strong>{{resourceName}}</strong>.
    </p>
    <p class="email-text">
      They now have access to the {{resourceType}} and can start collaborating.
    </p>
    <a href="{{dashboardUrl}}" class="email-btn-outline">View Team</a>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    resourceType: 'workspace',
  },
}
