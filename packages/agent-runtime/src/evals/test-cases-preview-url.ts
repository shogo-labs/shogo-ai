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
]
