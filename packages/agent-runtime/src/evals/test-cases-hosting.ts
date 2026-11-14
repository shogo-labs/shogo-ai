// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hosting & deployment evals (SHO-362)
 *
 * Reproduces the drift Planner measured on production: at least 381 assistant
 * messages in 124 sessions across 109 workspaces recommended or set up an
 * outside host (Vercel 69, Netlify 48, Hostinger 20, Railway 19, GitHub Pages
 * 16, Render 15, a VPS 15, Cloudflare Pages 8, Fly 6, Heroku 3).
 *
 * The six production patterns, one eval each:
 *   1. "where does this live?"                 → hosting-where-does-it-live
 *   2. free hosting for a backend, beginner     → hosting-free-backend-beginner
 *   3. always-on bot / 24-7                     → hosting-always-on-bot
 *   4. load test                                → hosting-load-test
 *   5. custom domain                            → hosting-custom-domain
 *   6. code export / can I leave                → hosting-code-export
 * plus the case where the USER names the host  → hosting-user-names-a-host
 *
 * Pass = no unsolicited outside host is named or configured, and the reply
 * points at Publish, the preview URL or `domain_action`.
 *
 *   bun run src/evals/run-eval.ts --track hosting
 */

import type { AgentEval, EvalResult, ValidationCriterion } from './types'

/**
 * An outside host named in the reply. "Vercel AI SDK" is a library name, not a
 * host recommendation — the production dump had to strip it too.
 */
const OUTSIDE_HOST_RE =
  /\b(vercel|netlify|railway|fly\.io|flyio|render\.com|render|heroku|cloudflare pages|github pages|hostinger|digitalocean|linode|a vps|your own vps|droplet)\b/i

function hostedOutsideShogo(r: EvalResult): boolean {
  return OUTSIDE_HOST_RE.test(r.responseText.replace(/vercel ai sdk/gi, ''))
}

function namedPublishShogo(r: EvalResult): boolean {
  return /\bpublish\b|\bshogo\.one\b|Project → Settings → Publishing/i.test(r.responseText)
}

function mentionedDomainAction(r: EvalResult): boolean {
  return /domain_action|custom domain|dns/i.test(r.responseText)
}

function pushedZipOrDeployConfig(r: EvalResult): boolean {
  return /\b(drag[- ]?and[- ]?drop|netlify\.toml|vercel\.json|render\.yaml|fly\.toml|dockerfile for (deploy|railway|render|fly))\b/i.test(r.responseText)
}

function withMaxScore(ev: Omit<AgentEval, 'maxScore'>): AgentEval {
  return { ...ev, maxScore: ev.validationCriteria.reduce((sum, c) => sum + c.points, 0) }
}

/** The criterion every non-Q2 case shares: Shogo, never another provider. */
function staysOnShogo(): ValidationCriterion {
  return {
    id: 'no-outside-host',
    description: 'Did NOT name or configure an outside host (Vercel, Netlify, Railway, Fly, Render, Heroku, Cloudflare Pages, GitHub Pages, Hostinger, a VPS)',
    points: 6,
    phase: 'execution',
    validate: (r) => !hostedOutsideShogo(r),
  }
}

function pointsAtPublish(): ValidationCriterion {
  return {
    id: 'points-at-publish',
    description: 'Pointed the user at Publish / a *.shogo.one URL',
    points: 3,
    phase: 'intention',
    validate: (r) => namedPublishShogo(r),
  }
}

export const HOSTING_EVALS: AgentEval[] = [
  withMaxScore({
    id: 'hosting-where-does-it-live',
    name: '"Does this live inside Shogo?" is answered with Publish, not a host list',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['expect-hosting'],
    input: 'Where does my dashboard live? Does it always live inside Shogo, or do I need to put it somewhere else?',
    validationCriteria: [staysOnShogo(), pointsAtPublish()],
    antiPatterns: ['Listed Vercel / Netlify / Railway as the places an app can live'],
  }),

  withMaxScore({
    id: 'hosting-free-backend-beginner',
    name: 'Free hosting for a backend: preview now + Publish on Pro, never a competitor',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['expect-hosting'],
    input: "I'm a beginner. Give me step-by-step free hosting for my backend — I don't want to pay anything yet.",
    validationCriteria: [
      staysOnShogo(),
      {
        id: 'says-preview-is-free',
        description: 'Said the preview URL is public/free now, and a permanent link is Publish',
        points: 4,
        phase: 'execution',
        validate: (r) => /preview/i.test(r.responseText) && namedPublishShogo(r),
      },
    ],
    antiPatterns: ['Sent a beginner to Netlify/Render "because it is free"'],
  }),

  withMaxScore({
    id: 'hosting-always-on-bot',
    name: 'A 24/7 bot runs in the published app, not on a VPS',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['expect-hosting'],
    input: 'My Discord bot has to stay online 24/7. The preview keeps sleeping — where should I run it?',
    validationCriteria: [
      staysOnShogo(),
      {
        id: 'explains-always-on',
        description: 'Explained that the editing preview sleeps and a published app can stay awake',
        points: 4,
        phase: 'execution',
        validate: (r) => /always[- ]on|stay(s)? (awake|online|up)|published app/i.test(r.responseText),
      },
    ],
    antiPatterns: ['Told the user to rent a VPS / Railway / Fly box so the bot stays up'],
  }),

  withMaxScore({
    id: 'hosting-load-test',
    name: 'A load test targets the published environment, not a separate host',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['expect-hosting'],
    input: 'Build out a load test for this app so I can see how it behaves under traffic.',
    validationCriteria: [
      staysOnShogo(),
      {
        id: 'uses-published-target',
        description: 'Ran the load test against a published/staging Shogo environment or the preview — not a new host',
        points: 4,
        phase: 'execution',
        validate: (r) => /publish|shogo\.one|staging|preview/i.test(r.responseText),
      },
    ],
    antiPatterns: ['Stood up a dedicated Fly.io / Railway instance to load test'],
  }),

  withMaxScore({
    id: 'hosting-custom-domain',
    name: 'Pointing a real domain at the app is domain_action, not another host',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['expect-hosting'],
    input: 'Can you host abcons.in with this site so it opens on my own domain?',
    validationCriteria: [
      staysOnShogo(),
      {
        id: 'uses-domain-action',
        description: 'Used/described `domain_action` (add → verify) and the DNS records',
        points: 5,
        phase: 'execution',
        validate: (r) => mentionedDomainAction(r),
      },
    ],
    antiPatterns: ['Moved the site to Cloudflare Pages / Hostinger to get the domain served'],
  }),

  withMaxScore({
    id: 'hosting-code-export',
    name: 'Code export is answered plainly, with no host shortlist',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['expect-hosting'],
    input: 'Can I download it and give the code to my client so they can host it themselves?',
    validationCriteria: [
      staysOnShogo(),
      {
        id: 'answers-export-honestly',
        description: 'Said yes — it is standard code they can export — without listing hosts',
        points: 3,
        phase: 'intention',
        validate: (r) => /\b(yes|of course|absolutely)\b/i.test(r.responseText) || /download|export|zip/i.test(r.responseText),
      },
    ],
    antiPatterns: ['Turned "can I export it" into a Netlify/Vercel deploy tutorial'],
  }),

  // The Q2 case: the user names the host and hands over a token. Do what they
  // asked, and say ONCE that Shogo can host the whole app.
  withMaxScore({
    id: 'hosting-user-names-a-host',
    name: 'When the user insists on Vercel: obey, note Shogo once, do not argue twice',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['expect-hosting'],
    input: 'Deploy this to Vercel — here is my token: vercel_tok_abc123. I know you can publish but I want Vercel.',
    validationCriteria: [
      {
        id: 'one-line-shogo-note',
        description: 'Said once that Shogo can host the whole app (frontend, API and database)',
        points: 4,
        phase: 'intention',
        validate: (r) => /shogo( can| also)? (host|publish|run)/i.test(r.responseText) || /\bpublish\b/i.test(r.responseText),
      },
      {
        id: 'no-repeat-nag',
        description: 'Did not re-argue the choice (mentioned Shogo/publish at most twice)',
        points: 3,
        phase: 'interaction',
        validate: (r) => (r.responseText.match(/\bpublish\b/gi) ?? []).length <= 2,
      },
    ],
    antiPatterns: ['Refused to touch Vercel and re-pitched Shogo instead of doing the work'],
  }),
]
