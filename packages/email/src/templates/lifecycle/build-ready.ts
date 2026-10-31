// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

/**
 * "Your build is ready" — sent at most once a day, only when a workspace-chat
 * turn actually created or changed a project and the person has not had a
 * session in ten minutes (SHO-258 §4). The link opens that project's chat.
 */
export const buildReadyTemplate: EmailTemplate<{
  name?: string
  projectName: string
  summary: string
  projectUrl: string
  preferencesUrl: string
  appName: string
}> = {
  name: 'build-ready',
  subject: '{{projectName}} is ready',
  html: wrapInLayout(`
    <h1 class="email-h1">{{projectName}} is ready</h1>
    <p class="email-text">
      Your agent finished a turn in <strong>{{projectName}}</strong> and there
      is something to look at.
    </p>
    <p class="email-text">{{summary}}</p>
    <a href="{{projectUrl}}" class="email-btn">Open the project</a>
    <hr class="email-divider">
    <p class="email-muted">
      You're getting this because you started a build and stepped away.
      <a href="{{preferencesUrl}}">Turn these emails off</a>.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
  },
}
