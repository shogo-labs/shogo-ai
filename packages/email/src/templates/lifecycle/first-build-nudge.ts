// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

/**
 * "Your idea is still waiting" — a once-only nudge, 24h after signup with no
 * project, that quotes the idea the person typed in onboarding and links straight
 * back into that chat session (SHO-615).
 *
 * Two templates rather than one with a conditional, because this template system
 * has no conditionals: when the job recovered a prompt it uses
 * `firstBuildNudgeTemplate`; otherwise it uses `firstBuildNudgeExamplesTemplate`
 * with the example prompts a person can start from.
 */
export const firstBuildNudgeTemplate: EmailTemplate<{
  prompt: string
  continueUrl: string
  unsubscribeUrl: string
  appName: string
}> = {
  name: 'first-build-nudge',
  subject: 'Your idea is still waiting',
  html: wrapInLayout(`
    <h1 class="email-h1">Your idea is still waiting</h1>
    <p class="email-text">
      You told us you wanted to build:
    </p>
    <p class="email-text"><strong>{{prompt}}</strong></p>
    <p class="email-text">
      It's still here whenever you're ready. Your agent will build a first version
      you can open, then ask a few questions to shape the next one.
    </p>
    <a href="{{continueUrl}}" class="email-btn">Continue building</a>
    <hr class="email-divider">
    <p class="email-muted">
      You're getting this because you signed up for Shogo but haven't built a
      project yet. <a href="{{unsubscribeUrl}}">Unsubscribe from these emails</a>.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
  },
}

/**
 * The no-session variant: no recoverable onboarding prompt, so offer the same
 * kinds of one-line ideas the onboarding step suggests. Each links into the app.
 */
export const firstBuildNudgeExamplesTemplate: EmailTemplate<{
  example1: string
  example2: string
  example3: string
  continueUrl: string
  unsubscribeUrl: string
  appName: string
}> = {
  name: 'first-build-nudge-examples',
  subject: 'Still thinking about what to build?',
  html: wrapInLayout(`
    <h1 class="email-h1">Your first build is one sentence away</h1>
    <p class="email-text">
      Describe an agent, app, business idea or workflow and Shogo builds a first
      version you can open. A few ways to start:
    </p>
    <p class="email-text"><a href="{{continueUrl}}">{{example1}}</a></p>
    <p class="email-text"><a href="{{continueUrl}}">{{example2}}</a></p>
    <p class="email-text"><a href="{{continueUrl}}">{{example3}}</a></p>
    <a href="{{continueUrl}}" class="email-btn">Start building</a>
    <hr class="email-divider">
    <p class="email-muted">
      You're getting this because you signed up for Shogo but haven't built a
      project yet. <a href="{{unsubscribeUrl}}">Unsubscribe from these emails</a>.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
  },
}
