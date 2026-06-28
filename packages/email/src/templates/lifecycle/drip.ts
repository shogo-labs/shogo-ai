// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

// ─── Drip 1: Welcome ─────────────────────────────────────────────────────────

export const dripWelcomeTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
}> = {
  name: 'drip-welcome',
  subject: 'Welcome to {{appName}} — your first agent is one message away',
  html: wrapInLayout(`
    <h1 class="email-h1">Hey {{name}},</h1>
    <p class="email-text">
      You just signed up for {{appName}} — a place where you build AI agents
      by chatting with them. No YAML, no config files, just describe what you
      want the agent to do.
    </p>
    <p class="email-text">
      In the next 5 minutes you can have an agent that checks your GitHub PRs,
      tracks your revenue, or manages your support queue — whatever you actually
      need. Start with a template.
    </p>
    <a href="{{appUrl}}/templates" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Build your first agent →
    </a>
    <hr class="email-divider">
    <p class="email-muted">
      Reply to this email any time — I read every one.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
  },
}

// ─── Drip 2: Quick Win Prompt ─────────────────────────────────────────────────

export const dripQuickWinTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
}> = {
  name: 'drip-quick-win',
  subject: 'Start here: the Research Assistant takes 2 minutes',
  html: wrapInLayout(`
    <h1 class="email-h1">Your first agent in 2 minutes</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      The fastest way to see what {{appName}} does is the Research Assistant.
      It's pre-configured to search the web, summarize findings, and send you
      a digest — no setup required beyond pointing it at a topic.
    </p>
    <p class="email-text">Three steps:</p>
    <p class="email-text">
      <strong>1.</strong> Open the template gallery<br>
      <strong>2.</strong> Install Research Assistant (one click)<br>
      <strong>3.</strong> Chat with it: <em>"Summarize the top AI news from this week"</em>
    </p>
    <a href="{{appUrl}}/templates" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Install Research Assistant →
    </a>
    <hr class="email-divider">
    <p class="email-muted">
      Takes 2 minutes. No integrations needed to start.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
  },
}

// ─── Drip 3: Stuck Nudge ─────────────────────────────────────────────────────

export const dripStuckNudgeTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
}> = {
  name: 'drip-stuck-nudge',
  subject: 'Most people get stuck at this exact step',
  html: wrapInLayout(`
    <h1 class="email-h1">Stuck on setup?</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      I checked and you haven't created your first agent yet. The most common
      friction point is figuring out what to ask — it feels open-ended.
    </p>
    <p class="email-text">
      Here's the simplest starting prompt that works every time:
    </p>
    <p class="email-text" style="background:#f8f8f8;border-left:3px solid #e8853d;padding:12px 16px;border-radius:4px;font-style:italic;">
      "I want an agent that checks my GitHub for open pull requests each morning
       and sends me a Slack message with a summary."
    </p>
    <p class="email-text">
      Paste that, swap GitHub/Slack for your tools, and you have an agent in
      under 60 seconds.
    </p>
    <a href="{{appUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Resume setup →
    </a>
    <hr class="email-divider">
    <p class="email-muted">
      Or just reply here — tell me what you're trying to automate and I'll help
      you set it up.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
  },
}

// ─── Drip 4: First Action ─────────────────────────────────────────────────────

export const dripFirstActionTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
  agentName: string
}> = {
  name: 'drip-first-action',
  subject: 'Your agent is configured — now talk to it',
  html: wrapInLayout(`
    <h1 class="email-h1">{{agentName}} is ready</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      You created <strong>{{agentName}}</strong> — nice work. The last step is
      sending it a message so it knows what to do first.
    </p>
    <p class="email-text">
      Open the chat panel and try something like:
    </p>
    <p class="email-text" style="background:#f8f8f8;border-left:3px solid #e8853d;padding:12px 16px;border-radius:4px;font-style:italic;">
      "Check my GitHub for any open PRs that haven't been reviewed in 2+ days."
    </p>
    <p class="email-text">
      The first message is always the most satisfying — watch it actually go do
      something.
    </p>
    <a href="{{appUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Open {{agentName}} →
    </a>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
    agentName: 'your agent',
  },
}

// ─── Drip 5: Social Proof ─────────────────────────────────────────────────────

export const dripSocialProofTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
}> = {
  name: 'drip-social-proof',
  subject: 'What a 3-person startup is doing with Shogo',
  html: wrapInLayout(`
    <h1 class="email-h1">A real example</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      A small eng team uses three {{appName}} agents in production:
    </p>
    <p class="email-text">
      <strong>GitHub Ops</strong> — runs every morning, reviews all PRs opened
      in the last 24h, flags anything stale, and posts a summary to their
      #engineering Slack channel. Replaced a 15-minute standup ritual.
    </p>
    <p class="email-text">
      <strong>Revenue Tracker</strong> — pulls MRR from Stripe each Monday,
      compares it to the prior week, and sends a one-paragraph summary to the
      founder. Takes 8 seconds.
    </p>
    <p class="email-text">
      <strong>Incident Commander</strong> — watches their Sentry error feed,
      auto-groups similar errors, and creates Linear tickets with severity tags.
      Zero manual triage.
    </p>
    <p class="email-text">
      Every one of these started with a single chat message. None required any
      code.
    </p>
    <a href="{{appUrl}}/templates" class="email-btn" style="color:#ffffff;text-decoration:none;">
      See all templates →
    </a>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
  },
}

// ─── Drip 6: Re-engagement ────────────────────────────────────────────────────

export const dripReEngagementTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
  agentName: string
}> = {
  name: 'drip-re-engagement',
  subject: '{{agentName}} hasn\'t heard from you yet',
  html: wrapInLayout(`
    <h1 class="email-h1">Still there?</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      You set up <strong>{{agentName}}</strong> a few days ago but haven't sent
      it a message yet. That's the one missing step before it's actually useful.
    </p>
    <p class="email-text">
      Takes 30 seconds — open the agent, type one request, and see what happens.
      If it does something useful, great. If it doesn't, reply to this email and
      tell me what it got wrong — that's useful feedback too.
    </p>
    <a href="{{appUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Open {{agentName}} →
    </a>
    <hr class="email-divider">
    <p class="email-muted">
      If {{appName}} isn't the right fit right now, no hard feelings — just reply
      and let me know what you were hoping it would do.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
    agentName: 'your agent',
  },
}

// ─── Drip 7: Power Up ────────────────────────────────────────────────────────

export const dripPowerUpTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
}> = {
  name: 'drip-power-up',
  subject: 'Your agent just did something useful — here\'s the next level',
  html: wrapInLayout(`
    <h1 class="email-h1">Nice — your agent is working</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      Your agent just executed its first tool call. That's the real milestone —
      it's not just chatting, it's actually doing things.
    </p>
    <p class="email-text">
      The next level is connecting more tools. {{appName}} has 250+ integrations
      — GitHub, Slack, Linear, Stripe, Sentry, Google Sheets, Notion, and more.
      Each one you connect makes your agent more capable.
    </p>
    <p class="email-text">
      Go to <strong>Settings → Integrations</strong> and connect the tools your
      agent should be able to use.
    </p>
    <a href="{{appUrl}}/integrations" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Connect your first tool →
    </a>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
  },
}

// ─── Drip 8: Heartbeat ───────────────────────────────────────────────────────

export const dripHeartbeatTemplate: EmailTemplate<{
  name: string
  appName: string
  appUrl: string
}> = {
  name: 'drip-heartbeat',
  subject: 'Your agent can work while you sleep',
  html: wrapInLayout(`
    <h1 class="email-h1">Set it on autopilot</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      You've been chatting with your agent — now let it run on a schedule
      without you having to ask.
    </p>
    <p class="email-text">
      The <strong>Heartbeat</strong> feature wakes your agent on a timer —
      every hour, every morning at 8am, every Monday — whatever makes sense.
      When it wakes up, it checks in, looks for work, and acts.
    </p>
    <p class="email-text">
      Example: "Every morning at 8am, check GitHub for PRs that need review and
      post a summary to Slack." That's one heartbeat. Your agent does it
      automatically, every day, without you touching it.
    </p>
    <p class="email-text">
      Go to your agent's settings and enable the Heartbeat. Pick an interval
      and a schedule. That's it.
    </p>
    <a href="{{appUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">
      Set your first heartbeat →
    </a>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    appUrl: EMAIL_CONSTANTS.APP_URL,
  },
}
