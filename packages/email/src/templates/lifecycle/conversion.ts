// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

// ─── C1: Usage Window Hit ────────────────────────────────────────────────────

export const conversionUsageLimitTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
  freeWindow: string
  proWindow: string
}> = {
  name: 'conversion-usage-limit',
  subject: 'You\'ve used up your {{appName}} session — here\'s what happens next',
  html: wrapInLayout(`
    <h1 class="email-h1">You hit your usage window</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      Your free session window is full. This resets automatically, but it means
      you're actually using {{appName}} — which is the point.
    </p>
    <p class="email-text">
      Here's the difference between free and Pro:
    </p>
    <div style="background:#f8f8f8;border-radius:8px;padding:16px 20px;margin:0 0 16px;">
      <div class="email-detail-row">
        <span class="email-detail-label">Free window (5h)</span>
        <span class="email-detail-value">{{freeWindow}}</span>
      </div>
      <div class="email-detail-row">
        <span class="email-detail-label">Pro window (5h)</span>
        <span class="email-detail-value">{{proWindow}}</span>
      </div>
      <div class="email-detail-row" style="border-bottom:none;">
        <span class="email-detail-label">Advanced AI models</span>
        <span class="email-detail-value">Pro only</span>
      </div>
    </div>
    <p class="email-text">
      Pro is $20/seat/month. If your agents are saving you more than an hour a
      week, that math works.
    </p>
    <a href="{{appUrl}}/billing?plan=pro" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Upgrade to Pro →
    </a>
    <hr class="email-divider">
    <p class="email-muted">
      Questions about what's included? Reply to this email.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
    freeWindow: '$0.20',
    proWindow: '$1.96',
  },
}

// ─── C2: Power User Recognition ──────────────────────────────────────────────

export const conversionPowerUserTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
  messageCount: string
}> = {
  name: 'conversion-power-user',
  subject: 'You\'re in the top tier of {{appName}} free users',
  html: wrapInLayout(`
    <h1 class="email-h1">You're a power user on the free plan</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      You've sent <strong>{{messageCount}} messages</strong> to your agents —
      you're one of the most active users on the free plan. That's worth
      acknowledging.
    </p>
    <p class="email-text">
      You're currently limited to economy AI models and small usage windows.
      Pro unlocks:
    </p>
    <div style="background:#f8f8f8;border-radius:8px;padding:16px 20px;margin:0 0 16px;">
      <div class="email-detail-row">
        <span class="email-detail-label">AI models</span>
        <span class="email-detail-value">Claude Sonnet, GPT-4o, and more</span>
      </div>
      <div class="email-detail-row">
        <span class="email-detail-label">Usage windows</span>
        <span class="email-detail-value">10× larger</span>
      </div>
      <div class="email-detail-row">
        <span class="email-detail-label">Always-on apps</span>
        <span class="email-detail-value">1 per seat</span>
      </div>
      <div class="email-detail-row" style="border-bottom:none;">
        <span class="email-detail-label">Annual pricing</span>
        <span class="email-detail-value">$200/yr (2 months free)</span>
      </div>
    </div>
    <p class="email-text">
      Annual is the smart move if you plan to stick around — same Pro features,
      billed once a year.
    </p>
    <a href="{{appUrl}}/billing?plan=pro&interval=annual" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Get Pro annual ($200/yr) →
    </a>
    <hr class="email-divider">
    <p class="email-muted">
      Monthly is also available at $20/seat/month if you prefer.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
    messageCount: 'several',
  },
}

// ─── C3: Win-Back ────────────────────────────────────────────────────────────

export const conversionWinBackTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
  agentName: string
}> = {
  name: 'conversion-win-back',
  subject: '{{agentName}} hasn\'t heard from you in a week',
  html: wrapInLayout(`
    <h1 class="email-h1">It's been a while</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      <strong>{{agentName}}</strong> hasn't heard from you in a week. That's
      fine — sometimes the timing isn't right.
    </p>
    <p class="email-text">
      If you left because something wasn't working, reply to this and tell me.
      I'd rather fix the issue than lose you.
    </p>
    <p class="email-text">
      If life just got busy: your agent is still there, still configured, still
      ready. One message and you're back up.
    </p>
    <a href="{{appUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Check in with {{agentName}} →
    </a>
    <hr class="email-divider">
    <p class="email-muted">
      Pro tip: enable the Heartbeat on your agent so it works even when you're
      not thinking about it — that's how people get the most value from
      {{appName}}.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
    agentName: 'your agent',
  },
}
