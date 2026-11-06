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
 * A build on the Shogo account with **no `NativeBuild` row** is an ops alert, not
 * a silent drop: it means either a hand-started build (we are paying for someone
 * else's work) or a `createBuild` response we lost, and both need a human.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { prisma } from '../../lib/prisma'
import { meterBuild } from './usage.service'
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

export interface EasWebhookPayload {
  id?: string
  platform?: 'ios' | 'android'
  status?: string
  event?: 'BUILD' | 'SUBMIT'
  buildDetails?: {
    buildId?: string
    buildProfile?: string
    resourceClass?: string
    artifactUrl?: string
  }
  submissionDetails?: {
    submissionId?: string
    status?: string
  }
  [key: string]: unknown
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

  const event = payload.event ?? (payload.buildDetails ? 'BUILD' : 'SUBMIT')
  const memberId = opts.memberId ?? payload['actorId']?.toString?.() ?? 'eas-webhook'

  if (event === 'SUBMIT') {
    const submissionId = payload.submissionDetails?.submissionId ?? payload.id
    const status = payload.submissionDetails?.status ?? payload.status
    if (!submissionId) return { status: 400, body: { error: { code: 'missing_submission', message: 'No submission id.' } } }

    const build = await db.nativeBuild.findFirst({ where: { submissionId } })
    if (!build) {
      await alertOps('native_submission_failed', { submissionId, status, reason: 'no_build_row' })
      return { status: 202, body: { ok: true, matched: false } }
    }
    await db.nativeBuild.update({ where: { id: build.id }, data: { submissionStatus: status } })
    const done = status === 'finished'
    await db.nativeRelease.update({
      where: { id: build.releaseId },
      data: done
        ? { status: 'done', step: 'live' }
        : status === 'errored'
          ? { status: 'failed', step: 'submission', error: 'The store submission failed.' }
          : { status: 'submitting', step: 'store_submission' },
    })
    return { status: 200, body: { ok: true } }
  }

  const easBuildId = payload.buildDetails?.buildId ?? payload.id
  if (!easBuildId) return { status: 400, body: { error: { code: 'missing_build', message: 'No build id.' } } }

  const build = await db.nativeBuild.findUnique({ where: { easBuildId } })
  if (!build) {
    await alertOps('native_build_unknown', { easBuildId, status: payload.status })
    return { status: 202, body: { ok: true, matched: false } }
  }

  const status = String(payload.status ?? 'in_progress')
  await db.nativeBuild.update({
    where: { id: build.id },
    data: {
      status,
      resourceClass: payload.buildDetails?.resourceClass ?? build.resourceClass,
      artifactKey: payload.buildDetails?.artifactUrl ?? build.artifactKey,
      finishedAt: status === 'finished' || status === 'errored' ? (opts.now ?? new Date()) : build.finishedAt,
    },
  })

  if (status !== 'finished') {
    if (status === 'errored' || status === 'canceled') {
      await db.nativeRelease.update({
        where: { id: build.releaseId },
        data: { status: 'failed', step: build.purpose === 'test' ? 'test_build' : 'store_build' },
      })
    }
    return { status: 200, body: { ok: true } }
  }

  // Charge first, then submit: a build we cannot bill is still a build the
  // customer asked for, but the meter has to see it before anything else claims it.
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
