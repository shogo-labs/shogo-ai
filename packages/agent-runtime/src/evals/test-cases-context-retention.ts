// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Context-Retention Evals (prod reproduction — Hoshi / MiMo v2.5)
 *
 * Reproduces the top user-frustration signature in the AI-Insights digests:
 * "AI repeatedly asks for already-provided information (Stripe API keys,
 * webhook secrets) due to context loss across conversation turns, causing
 * extreme user frustration."
 *
 * Each eval scripts a prior turn where the user ALREADY supplied a value and
 * the assistant confirmed storing it (the runner replays user→assistant pairs
 * from `conversationHistory` verbatim). The final turn asks the agent to USE
 * that value. Failure = the agent asks the user to provide it again instead of
 * using what it was already given.
 *
 * Run against the production model for a faithful signal:
 *   bun run src/evals/run-eval.ts --track context-retention \
 *     --model 38e6339d-9135-4aff-8641-eba3ae7bebe5   # Hoshi 1.0 / mimo-v2.5
 *
 * Track: --track context-retention
 */

import type { AgentEval, EvalResult } from './types'
import { responseContains } from './eval-helpers'

/**
 * True if the FINAL reply asks the user to hand over (again) a secret/key it
 * was already given, e.g. "please provide your webhook signing secret",
 * "what is your Stripe key", "paste your token".
 *
 * Deliberately does NOT fire on:
 *  - the *encouraged* rotation/exposure warning ("since you shared your Twilio
 *    credentials in chat … rotate them once we're done") — the word "shared"
 *    and the noun "credentials" would otherwise look like a re-ask. We use
 *    word-boundary verbs (so "shared" ≠ "share") and skip warning sentences.
 *  - asking for a genuinely *new*, not-yet-provided value (e.g. the Twilio
 *    "from" phone number), which is correct behavior, not a re-ask.
 */
function reaskedForProvidedSecret(r: EvalResult): boolean {
  // Imperative asks for a value NOW. Word boundaries keep "share" from matching
  // "shared" (past tense, used in the rotation warning).
  const requestVerb =
    /\b(?:provide|paste|resend|re-?enter|share)\b your|(?:send|give) me your|enter your|what(?:'s| is) your|i(?:'| )?ll need your|please (?:provide|paste|enter|re-?enter|share)|could you (?:provide|paste|share|send)|can you (?:provide|paste|send)/
  const credentialNoun =
    /(secret|signing secret|whsec|api ?key|access token|auth token|account sid|stripe key|sk_live|private key|credential)/
  // Sentences that are exposure/rotation warnings — encouraged, not a re-ask.
  const warningContext =
    /(rotate|revoke|expose|exposed|in the transcript|in chat|once (?:we|you|setup|we'?re|you'?re)|heads[- ]?up|shared (?:your|the))/
  return r.responseText.split(/[\n.!?]/).some(s => {
    const seg = s.toLowerCase()
    if (warningContext.test(seg)) return false
    return requestVerb.test(seg) && credentialNoun.test(seg)
  })
}

export const CONTEXT_RETENTION_EVALS: AgentEval[] = [
  {
    id: 'context-retention-webhook-secret-not-reasked',
    name: 'Context retention — must not re-ask for a webhook secret already provided',
    category: 'multiturn',
    level: 3,
    useRuntimeTemplate: true,
    conversationHistory: [
      {
        role: 'user',
        content:
          "I'm adding Stripe to my store. My Stripe secret key is sk_live_51EVALxxFAKEkey0000onlyForEvalsDoNotUse and my webhook signing secret is whsec_EVALxxFAKEwebhook0000onlyForEvals. Set them up so the app can use them.",
      },
      {
        role: 'assistant',
        content:
          "Got it — I've stored your Stripe secret key as STRIPE_SECRET_KEY and your webhook signing secret as STRIPE_WEBHOOK_SECRET in the environment, and the code reads both from process.env. (Heads up: since these were pasted in chat you should rotate them once we're done.)",
      },
    ],
    input:
      'Great. Now finish the POST /api/webhook route so it verifies the Stripe signature and handles the checkout.session.completed event.',
    validationCriteria: [
      {
        id: 'did-not-reask-for-secret',
        description: 'Does not ask the user to provide the webhook secret / key again',
        points: 6,
        phase: 'interaction',
        validate: (r) => !reaskedForProvidedSecret(r),
      },
      {
        id: 'used-provided-env-var',
        description: 'Verifies the signature using the already-stored STRIPE_WEBHOOK_SECRET env var',
        points: 4,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'STRIPE_WEBHOOK_SECRET') ||
          r.toolCalls.some(
            t =>
              (t.name === 'write_file' || t.name === 'edit_file') &&
              /STRIPE_WEBHOOK_SECRET/.test(
                String((t.input as any).content ?? (t.input as any).new_string ?? ''),
              ),
          ),
      },
    ],
    antiPatterns: ['Asked again for an already-provided secret'],
    maxScore: 10,
  },
  {
    id: 'context-retention-integration-keys-not-reasked',
    name: 'Context retention — must not re-ask for integration credentials already provided',
    category: 'multiturn',
    level: 3,
    useRuntimeTemplate: true,
    conversationHistory: [
      {
        role: 'user',
        content:
          'Set up Twilio SMS for my app. My Account SID is ACeval00FAKEsid0000onlyForEvals and my Auth Token is evalFAKEauthtoken0000onlyForEvals.',
      },
      {
        role: 'assistant',
        content:
          "Done — I've saved your Twilio Account SID as TWILIO_ACCOUNT_SID and Auth Token as TWILIO_AUTH_TOKEN in the environment, and the client is initialized from process.env.",
      },
    ],
    input: 'Perfect. Now add a /api/send-sms route that sends a text to a phone number from the request body.',
    validationCriteria: [
      {
        id: 'did-not-reask-for-credentials',
        description: 'Does not ask the user to provide the Twilio SID / auth token again',
        points: 6,
        phase: 'interaction',
        validate: (r) => !reaskedForProvidedSecret(r),
      },
      {
        id: 'used-provided-env-vars',
        description: 'Initializes the Twilio client from the already-stored env vars',
        points: 4,
        phase: 'execution',
        validate: (r) =>
          responseContains(r, 'TWILIO_ACCOUNT_SID') ||
          responseContains(r, 'TWILIO_AUTH_TOKEN') ||
          r.toolCalls.some(
            t =>
              (t.name === 'write_file' || t.name === 'edit_file') &&
              /TWILIO_(ACCOUNT_SID|AUTH_TOKEN)/.test(
                String((t.input as any).content ?? (t.input as any).new_string ?? ''),
              ),
          ),
      },
    ],
    antiPatterns: ['Asked again for already-provided credentials'],
    maxScore: 10,
  },
]
