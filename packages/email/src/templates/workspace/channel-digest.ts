// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const channelDigestTemplate: EmailTemplate<{
  workspaceName: string
  countLabel: string
  summary: string
  channelsUrl: string
  settingsUrl: string
  appName: string
}> = {
  name: 'channel-digest',
  subject: '{{countLabel}} waiting in {{workspaceName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">You have {{countLabel}}</h1>
    <p class="email-text">Here's what you missed in <strong>{{workspaceName}}</strong>:</p>
    <p class="email-text" style="white-space: pre-line;">{{summary}}</p>
    <a href="{{channelsUrl}}" class="email-btn-outline">Open channels</a>
    <p class="email-text" style="font-size: 12px; color: #888;">
      You get this daily summary because email digests are on.
      <a href="{{settingsUrl}}">Change notification settings</a>.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
  },
}
