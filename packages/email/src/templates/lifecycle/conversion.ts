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
  subject: 'You maxed out your free {{appName}} window — Pro is 10× bigger',
  html: wrapInLayout(`
    <span class="email-badge">Time to upgrade</span>
    <h1 class="email-h1" style="margin-top:16px;">You're outgrowing the free plan</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      You just hit your free usage window — which means your agents are doing
      real work for you. The free tier is capped low on purpose. Pro takes the
      brakes off.
    </p>
    <p class="email-text">
      Here's what changes the moment you upgrade:
    </p>
    <div style="background:#f8f8f8;border-radius:8px;padding:16px 20px;margin:0 0 16px;">
      <div class="email-detail-row">
        <span class="email-detail-label">Usage window (5h)</span>
        <span class="email-detail-value">{{freeWindow}} → {{proWindow}} (10×)</span>
      </div>
      <div class="email-detail-row">
        <span class="email-detail-label">Advanced AI models</span>
        <span class="email-detail-value">Claude Sonnet, GPT-4o &amp; more</span>
      </div>
      <div class="email-detail-row">
        <span class="email-detail-label">Always-on apps</span>
        <span class="email-detail-value">1 per seat</span>
      </div>
      <div class="email-detail-row" style="border-bottom:none;">
        <span class="email-detail-label">Waiting on window resets</span>
        <span class="email-detail-value">Rarely — 10× more headroom</span>
      </div>
    </div>
    <p class="email-text">
      Pro is <strong>$20/seat/month</strong>. If your agents save you more than
      an hour a week, it's already paid for itself — and you stop losing momentum
      every time the free window fills up.
    </p>
    <a href="{{appUrl}}/billing?plan=pro" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Upgrade to Pro →
    </a>
    <p class="email-muted">
      Prefer to save 2 months? <a href="{{appUrl}}/billing?plan=pro&amp;interval=annual" style="color:#e8853d;text-decoration:none;font-weight:600;">Get Pro annual for $200/yr →</a>
    </p>
    <hr class="email-divider">
    <p class="email-muted">
      Not ready yet? Your free window resets automatically — no action needed.
      Questions about what's included? Just reply to this email.
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
