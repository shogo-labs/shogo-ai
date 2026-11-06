// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `POST /api/webhooks/eas` — how a build's outcome reaches us.
 *
 * Expo signs the raw body with the per-webhook secret in `expo-signature`
 * (HMAC-SHA1). Two properties matter here:
 *
 * 1. **A bad signature is a 401**, verified over the raw bytes before anything is
 *    parsed, so a forged `finished` cannot charge a customer.
 * 2. **A redelivery charges once.** The meter claims `NativeBuild.meteredAt`
 *    before it bills, so an Expo retry, an overlapping sweep and a duplicate
 *    delivery all collapse onto one charge.
 *
 * ## The payload has no `event` field
 *
 * `WebhookType` (`BUILD` | `SUBMIT`) selects *which webhook you subscribe to*; it
 * is not repeated in the body. The two documented payloads are told apart by
 * shape only — a build carries `artifacts`/`metadata`/`resourceClass`, a
 * submission carries `submissionInfo`/`archiveUrl` — so we register **one
 * webhook per event with its own URL** (`?event=build` / `?event=submit`) and
 * treat the query as the authority. Shape detection is the fallback for a
 * webhook an older revision created on the account (both events pointed at the
 * bare path), where guessing from fields is better than dropping every delivery.
 * Do not reintroduce a `payload.event`/`payload.buildDetails` read: neither
 * exists, and reading them silently routed every build into the submit branch.
 *
 * A build on the Shogo account with **no `NativeBuild` row** is an ops alert, not
 * a silent drop: it means either a hand-started build (we are paying for someone
 * else's work) or a `createBuild` response we lost, and both need a human.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { prisma } from '../../lib/prisma'
import { meterBuild, normalizeResourceClass } from './usage.service'
import { submitStoreBuild } from './release.service'
import { alertOps } from './alerts'

const db = prisma as any

/**
 * Verify an `expo-signature` header against the raw body.
 *
 * Accepts `sha1=<hex>` and a bare hex digest, because both shapes are in the
 * wild and rejecting one silently drops every real delivery.
 */
export function verifyEasSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false
  const provided = signature.trim().replace(/^sha1=/i, '').toLowerCase()
  if (!/^[0-9a-f]+$/.test(provided)) return false

  const expected = createHmac('sha1', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(provided, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type EasWebhookEvent = 'build' | 'submit'

/**
 * The documented EAS **build** webhook body (`docs.expo.dev/eas/webhooks/`).
 * `id` is the build id — not a generic row id — and the class EAS actually ran
 * on is `actualResourceClass` (what the invoice is keyed by); `resourceClass` is
 * what was requested.
 */
export interface EasBuildWebhookPayload {
  id?: string
  status?: string
  platform?: 'ios' | 'android'
  appId?: string
  accountName?: string
  projectName?: string
  buildDetailsPageUrl?: string
  parentBuildId?: string | null
  initiatingUserId?: string | null
  cancelingUserId?: string | null
  resourceClass?: string
  actualResourceClass?: string
  artifacts?: { buildUrl?: string; logsS3KeyPrefix?: string }
  metadata?: {
    buildProfile?: string
    distribution?: string
    appVersion?: string
    appBuildVersion?: string
    runtimeVersion?: string
    [key: string]: unknown
  }
  metrics?: Record<string, unknown>
  error?: { message?: string; errorCode?: string }
  createdAt?: string
  completedAt?: string
  updatedAt?: string
  [key: string]: unknown
}

/** The documented EAS **submit** webhook body. `id` is the submission id. */
export interface EasSubmitWebhookPayload {
  id?: string
  status?: string
  platform?: 'ios' | 'android'
  appId?: string
  accountName?: string
  projectName?: string
  submissionDetailsPageUrl?: string
  parentSubmissionId?: string | null
  archiveUrl?: string
  turtleBuildId?: string
  initiatingUserId?: string | null
  cancelingUserId?: string | null
  submissionInfo?: { error?: { message?: string; errorCode?: string }; logsUrl?: string }
  error?: { message?: string; errorCode?: string }
  createdAt?: string
  completedAt?: string
  updatedAt?: string
  [key: string]: unknown
}

export type EasWebhookPayload = EasBuildWebhookPayload & EasSubmitWebhookPayload

/**
 * Which event a delivery is. The URL wins; the body is the fallback.
 *
 * A submission always has `submissionInfo` or `submissionDetailsPageUrl` and
 * never has `artifacts`/`metadata`; a build is the opposite. `turtleBuildId` and
 * `archiveUrl` are submit-only too. Nothing here reads a field Expo does not
 * send.
 */
export function detectWebhookEvent(payload: EasWebhookPayload, hint?: string | null): EasWebhookEvent | null {
  const normalised = typeof hint === 'string' ? hint.trim().toLowerCase() : ''
  if (normalised === 'build' || normalised === 'submit') return normalised

  const looksLikeSubmit =
    payload.submissionInfo !== undefined ||
    payload.submissionDetailsPageUrl !== undefined ||
    payload.archiveUrl !== undefined ||
    payload.turtleBuildId !== undefined
  const looksLikeBuild =
    payload.artifacts !== undefined ||
    payload.metadata !== undefined ||
    payload.buildDetailsPageUrl !== undefined ||
    payload.actualResourceClass !== undefined ||
    payload.resourceClass !== undefined

  if (looksLikeSubmit && !looksLikeBuild) return 'submit'
  if (looksLikeBuild && !looksLikeSubmit) return 'build'
  return null
}

export interface HandleWebhookResult {
  status: number
  body: Record<string, unknown>
}

/** The whole webhook, from raw body to response. Kept out of the route so a test
 * can drive it without an HTTP server. */
export async function handleEasWebhook(opts: {
  rawBody: string
  signature: string | undefined
  secret: string | undefined
  /** `?event=build|submit` from the registered webhook's URL. */
  event?: string | null
  memberId?: string
  now?: Date
}): Promise<HandleWebhookResult> {
  if (!opts.secret) {
    return { status: 503, body: { error: { code: 'native_webhook_unconfigured', message: 'EAS_WEBHOOK_SECRET is not set.' } } }
  }
  if (!verifyEasSignature(opts.rawBody, opts.signature, opts.secret)) {
    return { status: 401, body: { error: { code: 'invalid_signature', message: 'Bad expo-signature.' } } }
  }

  let payload: EasWebhookPayload
  try {
    payload = JSON.parse(opts.rawBody) as EasWebhookPayload
  } catch {
    return { status: 400, body: { error: { code: 'invalid_json', message: 'Body is not JSON.' } } }
  }

  const event = detectWebhookEvent(payload, opts.event)
  if (!event) {
    // Neither shape: log the keys rather than the body (a build body carries a
    // signed artifact URL) and refuse, so an Expo format change is visible.
    await alertOps('native_webhook_unrecognised', { keys: Object.keys(payload).slice(0, 20) })
    return {
      status: 202,
      body: { ok: true, matched: false, reason: 'unrecognised_payload' },
    }
  }

  const memberId = opts.memberId ?? payload.initiatingUserId?.toString?.() ?? 'eas-webhook'

  if (event === 'submit') {
    const submissionId = payload.id
    const status = payload.status
    if (!submissionId) return { status: 400, body: { error: { code: 'missing_submission', message: 'No submission id.' } } }

    const build = await db.nativeBuild.findFirst({ where: { submissionId } })
    if (!build) {
      await alertOps('native_submission_failed', { submissionId, status, reason: 'no_build_row' })
      return { status: 202, body: { ok: true, matched: false } }
    }
    await db.nativeBuild.update({ where: { id: build.id }, data: { submissionStatus: status ?? null } })
    const done = status === 'finished'
    const errored = status === 'errored' || status === 'canceled'
    const reason = payload.submissionInfo?.error?.message ?? payload.error?.message
    await db.nativeRelease.update({
      where: { id: build.releaseId },
      data: done
        ? { status: 'done', step: 'live' }
        : errored
          ? { status: 'failed', step: 'submission', error: reason ?? 'The store submission failed.' }
          : { status: 'submitting', step: 'store_submission' },
    })
    return { status: 200, body: { ok: true } }
  }

  const easBuildId = payload.id
  if (!easBuildId) return { status: 400, body: { error: { code: 'missing_build', message: 'No build id.' } } }

  const build = await db.nativeBuild.findUnique({ where: { easBuildId } })
  if (!build) {
    // A test-stage build is started by the workflow, not by us, so it has no row
    // until the poller adopts it (`adoptWorkflowBuilds`) — that can lag a
    // delivery by up to one poll interval. Alerting on those made every release
    // raise a false "unknown build" (the alert that exists to catch a build
    // someone started by hand), so: while *this app* has a release in its test
    // stage the build is logged, and the alert only fires when no release of that
    // app could own it. The scope is the payload's `appId` — account-wide, one
    // busy release would hide a hand-started build on any other project.
    const app = payload.appId
      ? await db.nativeApp.findFirst({ where: { easAppId: payload.appId } })
      : null
    const openTests = app
      ? await db.nativeRelease.count({ where: { projectId: app.projectId, status: 'testing' } })
      : 0
    if (openTests > 0) {
      console.warn('[native-release] build arrived before its workflow was polled', { easBuildId, appId: payload.appId })
      return { status: 202, body: { ok: true, matched: false, pending_adoption: true } }
    }
    await alertOps('native_build_unknown', { easBuildId, status: payload.status, appId: payload.appId ?? null })
    return { status: 202, body: { ok: true, matched: false } }
  }

  const status = String(payload.status ?? 'in_progress')
  // `actualResourceClass` is what ran (and what the invoice names), so it wins —
  // but only once it is a class the price table can name. Expo reports these as
  // builder-machine slugs (`android-n2-1.3-12`), and writing one straight into
  // the row made every real build price as `null` and charge nothing. Unparseable
  // stays what we requested, which EAS honours, and the raw report goes in the
  // alert detail rather than into a column we bill from.
  const reportedRaw = payload.actualResourceClass ?? payload.resourceClass
  const reportedClass =
    normalizeResourceClass(reportedRaw, payload.platform === 'android' ? 'android' : 'ios') ?? null
  await db.nativeBuild.update({
    where: { id: build.id },
    data: {
      status,
      resourceClass: reportedClass ?? build.resourceClass,
      artifactKey: payload.artifacts?.buildUrl ?? build.artifactKey,
      finishedAt: status === 'finished' || status === 'errored' || status === 'canceled'
        ? (opts.now ?? new Date())
        : build.finishedAt,
    },
  })

  if (status !== 'finished') {
    if (status === 'errored' || status === 'canceled') {
      await db.nativeRelease.update({
        where: { id: build.releaseId },
        data: {
          status: 'failed',
          step: build.purpose === 'test' ? 'test_build' : 'store_build',
          error: payload.error?.message ?? null,
        },
      })
    }
    return { status: 200, body: { ok: true } }
  }

  // Charge first, then submit: a build we cannot bill is still a build the
  // customer asked for, but the meter has to see it before anything else claims it.
  if (!reportedClass && reportedRaw) {
    console.warn('[native-release] build reported a class we cannot price', {
      easBuildId,
      reported: reportedRaw,
      billing: build.resourceClass,
    })
  }

  const metered = await meterBuild({ easBuildId, memberId })

  if (build.purpose === 'store') {
    try {
      await submitStoreBuild({ easBuildId })
    } catch (err) {
      await alertOps('native_submission_failed', {
        easBuildId,
        reason: err instanceof Error ? err.message : String(err),
      })
      await db.nativeRelease.update({
        where: { id: build.releaseId },
        data: {
          status: 'failed',
          step: 'submission',
          error: err instanceof Error ? err.message : 'The store submission could not be started.',
        },
      })
      return { status: 200, body: { ok: true, metered, submitted: false } }
    }
  }

  await db.nativeRelease.update({
    where: { id: build.releaseId },
    data: build.purpose === 'test' ? { step: 'test_finished' } : { status: 'submitting', step: 'store_submission' },
  })

  return { status: 200, body: { ok: true, metered } }
}
