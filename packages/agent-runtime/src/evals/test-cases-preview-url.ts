// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Preview-URL Discipline Evals (P0 reproduction)
 *
 * Reproduces the Subliminal regression where the agent, running inside a
 * cloud pod, repeatedly handed the user `http://localhost:PORT/...` URLs and
 * guessed broken external links instead of returning the real public preview
 * URL — and never tested a link before sending it.
 *
 * Root cause: `buildPreviewUrlContext()` is only injected into the system
 * prompt when `activeMode === 'canvas'` (gateway.ts). In normal `app`/build
 * mode the agent has no preview URL at all, so it falls back to the localhost
 * address it can see from `PORT`.
 *
 * How to run (the localhost bug needs a *public* URL to exist):
 *   EVAL_PUBLIC_PREVIEW_URL=https://preview--evalproj.shogo.dev \
 *     bun run src/evals/run-eval.ts --track preview-url --vm --workers 1
 *
 * The runner threads EVAL_PUBLIC_PREVIEW_URL → PUBLIC_PREVIEW_URL inside the
 * VM (see run-eval.ts vmWorkerConfig.envOverrides). Pre-fix the agent answers
 * with localhost (RED); post-fix it returns the public preview URL and
 * verifies it before sharing (GREEN).
 *
 * Track: --track preview-url
 */

import type { AgentEval, EvalResult } from './types'
import { usedTool } from './eval-helpers'

/** True if the response hands the user a localhost / loopback / bare-port URL. */
function sharedLocalhostUrl(r: EvalResult): boolean {
  return /(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(r.responseText)
}

/** True if the response contains an https URL on the public preview host. */
function sharedPublicPreviewUrl(r: EvalResult): boolean {
  return /https:\/\/[a-z0-9.-]*preview[a-z0-9.-]*/i.test(r.responseText)
}

/** True if the agent fetched/opened a URL (web or browser) before answering — test-before-share. */
function testedUrlBeforeSharing(r: EvalResult): boolean {
  return r.toolCalls.some(t =>
    (t.name === 'web' || t.name === 'browser') &&
    /https?:\/\//i.test(JSON.stringify(t.input)),
  )
}

/** True if the agent actually created/served a page (wrote an .html file or edited the app). */
function builtSomethingToServe(r: EvalResult): boolean {
  return r.toolCalls.some(t =>
    (t.name === 'write_file' || t.name === 'edit_file') &&
    /\.(html|tsx|jsx)$/i.test(String((t.input as any).path ?? '')),
  )
}

/** True if the agent dismissed a reachability complaint with "works on my end". */
function claimedWorksOnMyEnd(r: EvalResult): boolean {
  return /works (on|from|at) my end|works for me|it'?s working (on my|fine)|seems? fine on my/i.test(r.responseText)
}

/** True if the agent steered the user to Publish / a shogo.one URL. */
function mentionedPublish(r: EvalResult): boolean {
  return /\bpublish\b|shogo\.one/i.test(r.responseText)
}

/** True if the agent pushed a local-export / download / run-it-yourself path. */
function pushedLocalExport(r: EvalResult): boolean {
  return /\b(download|export|\.zip\b|run (it )?locally|npm (run|install)|git clone|unzip)\b/i.test(r.responseText)
}

export const PREVIEW_URL_EVALS: AgentEval[] = [
  {
    id: 'preview-url-share-working-link',
    name: 'Share a working public preview URL (not localhost)',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['expect-preview-reachable'],
    input: [
      'Add a simple "Pricing" page to this app that shows three plan cards (Free, Pro, Team).',
      'When it is live, give me a URL I can open in my browser right now to see it.',
      'Make sure the link actually works before you send it.',
    ].join('\n'),
    validationCriteria: [
      {
        id: 'built-the-page',
        description: 'Agent created/edited a page to serve (html/tsx)',
        points: 3,
        phase: 'execution',
        validate: (r) => builtSomethingToServe(r),
      },
      {
        id: 'no-localhost-url',
        description: 'Agent did NOT hand the user a localhost / loopback URL',
        points: 4,
        phase: 'execution',
        validate: (r) => !sharedLocalhostUrl(r),
      },
      {
        id: 'shared-public-preview-url',
        description: 'Agent returned the public https preview URL',
        points: 4,
        phase: 'execution',
        validate: (r) => sharedPublicPreviewUrl(r),
      },
      {
        id: 'tested-before-sharing',
        description: 'Agent fetched/opened the URL (web/browser) before sharing it',
        points: 4,
        phase: 'execution',
        validate: (r) => testedUrlBeforeSharing(r),
      },
    ],
    antiPatterns: [
      'Shared a localhost URL from a cloud pod',
      'Tool loop or repeated identical calls',
    ],
    maxScore: 15,
  },

  {
    id: 'preview-url-cant-be-reached-diagnose',
    name: '"Can\'t be reached" → re-verify public URL, not "works on my end"',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['expect-preview-reachable', 'vm', 'prod:preview-cant-be-reached'],
    input: [
      'I opened the preview link you gave me and it says "this site can\'t be reached".',
      'Can you check what\'s going on and get me a link that actually loads?',
    ].join('\n'),
    validationCriteria: [
      {
        id: 'reverified-url',
        description: 'Agent actually re-fetched/opened the preview URL to verify it',
        points: 5,
        phase: 'execution',
        validate: (r) => testedUrlBeforeSharing(r),
      },
      {
        id: 'no-works-on-my-end',
        description: 'Did NOT dismiss it with "works on my end"',
        points: 4,
        phase: 'execution',
        validate: (r) => !claimedWorksOnMyEnd(r),
      },
      {
        id: 'no-localhost',
        description: 'Did not respond with a localhost URL',
        points: 3,
        phase: 'execution',
        validate: (r) => !sharedLocalhostUrl(r),
      },
      {
        id: 'shared-public-url',
        description: 'Re-shared a public https preview URL',
        points: 3,
        phase: 'execution',
        validate: (r) => sharedPublicPreviewUrl(r),
      },
    ],
    antiPatterns: [
      'Replied "works on my end" without re-checking the public URL',
      'Handed back a localhost link',
    ],
    maxScore: 15,
  },

  {
    id: 'preview-url-route-to-publish',
    name: 'Route "save/host this" to Publish, not a local-export odyssey',
    category: 'code-agent',
    level: 2,
    tags: ['prod:save-host-local-export'],
    initialMode: 'app',
    input: 'This looks great! How do I save this so I can share it with people permanently?',
    validationCriteria: [
      {
        id: 'mentioned-publish',
        description: 'Agent pointed the user to Publish / a shogo.one URL',
        points: 7,
        phase: 'execution',
        validate: (r) => mentionedPublish(r),
      },
      {
        id: 'did-not-push-local-export',
        description: 'Did not walk the user through downloading / running it locally',
        points: 5,
        phase: 'execution',
        validate: (r) => !pushedLocalExport(r),
      },
    ],
    antiPatterns: [
      'Told the user to download a zip / run it locally instead of Publishing',
    ],
    maxScore: 12,
  },

  {
    // Companion to `preview-url-share-working-link`, which only asserts
    // no-localhost when a PUBLIC url exists. Here the user explicitly INVITES a
    // localhost link — the agent must still refuse to hand out a cloud pod's
    // localhost (it's unreachable for the user), regardless of whether a public
    // URL is configured.
    id: 'preview-url-never-localhost-when-asked',
    name: 'Never hand the user a localhost / bare-port link, even when asked directly',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['expect-preview-reachable'],
    input: 'Just give me a URL to open the app in my browser — a localhost link is totally fine for me.',
    validationCriteria: [
      {
        id: 'no-localhost-url',
        description: 'Did NOT hand the user a localhost / 127.0.0.1 / bare-port URL',
        points: 6,
        phase: 'execution',
        validate: (r) => !sharedLocalhostUrl(r),
      },
    ],
    antiPatterns: ['Handed back a localhost link from a cloud pod'],
    maxScore: 6,
  },

  {
    // "Host/share this" should actually DEPLOY via the publish tool and return
    // the live shogo.one URL — not just tell the user where to click. A
    // subdomain is given so the agent can complete the publish in one turn
    // (first publish otherwise requires confirming a subdomain).
    id: 'preview-url-publish-tool-hosts',
    name: '"Host this" -> invoke the publish tool and return a shogo.one URL',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    useRuntimeTemplate: true,
    tags: ['prod:save-host-local-export'],
    input: 'This looks great — please publish and host it at the subdomain "demo-store" so I can share the link with people.',
    validationCriteria: [
      {
        id: 'used-publish-tool',
        description: 'Agent invoked the publish tool',
        points: 6,
        phase: 'execution',
        validate: (r) => usedTool(r, 'publish'),
      },
      {
        id: 'returned-shogo-one-url',
        description: 'Agent returned a {subdomain}.shogo.one URL',
        points: 4,
        phase: 'execution',
        validate: (r) => /https?:\/\/[a-z0-9-]+\.shogo\.one/i.test(r.responseText),
      },
      {
        id: 'did-not-push-local-export',
        description: 'Did not walk the user through downloading / running it locally',
        points: 3,
        phase: 'execution',
        validate: (r) => !pushedLocalExport(r),
      },
    ],
    antiPatterns: [
      'Told the user where to click instead of publishing',
      'Handed back a localhost link',
    ],
    maxScore: 13,
  },
]
