// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DB-backed signup risk assessment.
 *
 * Called from the Better Auth `user.create.after` hook (new signups) and from
 * `afterEmailVerification` (re-score once the mailbox is confirmed). It
 * gathers signals, scores them with the pure scorer, and stores the result in
 * `signup_risk_assessments`. Credit granting happens in
 * `signup-credit.service.ts`.
 *
 * Scope: signals are IP (or IPv6 /64), device id, canonical email, email
 * shape, disposable domain, and provider. A Turnstile token and a datacenter
 * ASN lookup are not included yet. See the plan's "deferred" notes.
 */

import { isIP } from 'node:net'
import { prisma } from '../lib/prisma'
import { canonicalizeEmail, emailDomain } from '../lib/email-canonical'
import {
  E2E_BOOTSTRAP_HEADER,
  isE2eBootstrapRequest,
} from '../lib/e2e-bootstrap-secret'
import {
  SIGNUP_RISK_BURST_MINUTES,
  SIGNUP_RISK_WINDOW_DAYS,
} from '../config/signup-risk-config'
import {
  scoreSignupRisk,
  type SignupProvider,
  type SignupRiskFeatures,
  type SignupRiskResult,
} from './signup-risk-scoring'

/** Headers as either a Fetch `Headers` or a plain record (tests, hooks). */
export type HeaderSource =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>
  | null
  | undefined

export interface SignupRequestInfo {
  ip: string | null
  /** IPv4 address, or the IPv6 /64 prefix as `a:b:c:d`. */
  ipPrefix: string | null
  country: string | null
  deviceId: string | null
  /** Request carried a valid e2e bootstrap secret (see `e2e-bootstrap-secret.ts`). */
  e2eAllowlisted: boolean
}

export function readHeader(headers: HeaderSource, name: string): string | null {
  if (!headers) return null
  const value =
    typeof (headers as any).get === 'function'
      ? (headers as { get(n: string): string | null | undefined }).get(name)
      : (headers as Record<string, string | string[] | undefined>)[name]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** Expand an IPv6 address to eight 4-digit groups. Returns null if invalid. */
export function expandIPv6(ip: string): string[] | null {
  if (isIP(ip) !== 6) return null
  const [head, tail] = ip.split('::')
  if (ip.split('::').length > 2) return null
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const missing = 8 - h.length - t.length
  if (missing < 0) return null
  return [...h, ...Array(missing).fill('0'), ...t].map((g) => g.padStart(4, '0').toLowerCase())
}

/**
 * Prefix used for IP clustering: the address itself for IPv4, or the first
 * 64 bits for IPv6. Attackers rotate IPv6 addresses within one /64 cheaply.
 */
export function ipPrefixFor(ip: string): string | null {
  const version = isIP(ip)
  if (version === 4) return ip
  if (version === 6) {
    const groups = expandIPv6(ip)
    if (!groups) return null
    return groups.slice(0, 4).join(':')
  }
  return null
}

/** Client IP from Cloudflare, then a reverse proxy, then `x-forwarded-for`. */
export function readClientIp(headers: HeaderSource): string | null {
  for (const name of ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for']) {
    const raw = readHeader(headers, name)
    if (!raw) continue
    const candidate = raw.split(',')[0].trim()
    if (isIP(candidate)) return candidate
  }
  return null
}

const DEVICE_ID_HEADER = 'x-shogo-device-id'
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export function readSignupRequestInfo(headers: HeaderSource): SignupRequestInfo {
  const ip = readClientIp(headers)
  const rawDevice = readHeader(headers, DEVICE_ID_HEADER)
  const deviceId = rawDevice && DEVICE_ID_PATTERN.test(rawDevice) ? rawDevice : null
  return {
    ip,
    ipPrefix: ip ? ipPrefixFor(ip) : null,
    country: readHeader(headers, 'cf-ipcountry'),
    deviceId,
    e2eAllowlisted: isE2eBootstrapRequest(readHeader(headers, E2E_BOOTSTRAP_HEADER)),
  }
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/**
 * Gather the DB-backed features for one signup. Counts exclude the account
 * being scored. Rows older than the window are not counted.
 */
export async function collectSignupRiskFeatures(params: {
  userId: string
  email: string
  provider: SignupProvider
  emailVerified: boolean
  request: SignupRequestInfo
  now?: Date
}): Promise<SignupRiskFeatures> {
  const now = params.now ?? new Date()
  const windowStart = daysAgo(now, SIGNUP_RISK_WINDOW_DAYS)
  const burstStart = new Date(now.getTime() - SIGNUP_RISK_BURST_MINUTES * 60 * 1000)
  const canonical = canonicalizeEmail(params.email)
  const { ipPrefix, deviceId } = params.request

  const linkedByIp = ipPrefix
    ? prisma.signupRiskAssessment.count({
        where: { ipPrefix, userId: { not: params.userId }, createdAt: { gte: windowStart } },
      })
    : Promise.resolve(0)
  const linkedByDevice = deviceId
    ? prisma.signupRiskAssessment.count({
        where: { deviceId, userId: { not: params.userId }, createdAt: { gte: windowStart } },
      })
    : Promise.resolve(0)
  const burst =
    ipPrefix || deviceId
      ? prisma.signupRiskAssessment.count({
          where: {
            userId: { not: params.userId },
            createdAt: { gte: burstStart },
            OR: [
              ...(ipPrefix ? [{ ipPrefix }] : []),
              ...(deviceId ? [{ deviceId }] : []),
            ],
          },
        })
      : Promise.resolve(0)
  const collisions = prisma.user.count({
    where: { emailCanonical: canonical, id: { not: params.userId } },
  })

  const [ipLinkedAccounts, deviceLinkedAccounts, burstSignups, canonicalCollisions] =
    await Promise.all([linkedByIp, linkedByDevice, burst, collisions])

  return {
    email: params.email,
    provider: params.provider,
    emailVerified: params.emailVerified,
    allowlisted: params.request.e2eAllowlisted,
    canonicalCollisions,
    deviceLinkedAccounts,
    ipLinkedAccounts,
    burstSignups,
  }
}

/**
 * Plain JSON copy for Prisma `Json` columns. Interfaces (e.g. `SignupRiskSignal`)
 * don't satisfy Prisma's `InputJsonValue` index-signature check, and the stored
 * value is already JSON-safe.
 */
function toJsonValue(value: unknown): any {
  return JSON.parse(JSON.stringify(value))
}

/** Store the assessment and the canonical email on the user row. */
export async function recordSignupRiskAssessment(params: {
  userId: string
  email: string
  provider: SignupProvider
  request: SignupRequestInfo
  result: SignupRiskResult
  /** Overrides `result.decision` (used when verification changes the outcome). */
  decision?: string
}): Promise<void> {
  const emailCanonical = canonicalizeEmail(params.email)
  const payload = {
    score: params.result.score,
    band: params.result.band,
    decision: params.decision ?? params.result.decision,
    signals: toJsonValue({
      items: params.result.signals,
      provider: params.provider,
      disposableDomain: params.result.disposableDomain,
      blockedDomain: params.result.blockedDomain,
      randomLocalPart: params.result.randomLocalPart,
      allowlisted: params.result.allowlisted,
      domain: emailDomain(params.email),
      country: params.request.country,
    }),
    ip: params.request.ip,
    ipPrefix: params.request.ipPrefix,
    country: params.request.country,
    deviceId: params.request.deviceId,
    emailCanonical,
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: params.userId }, data: { emailCanonical } }),
    prisma.signupRiskAssessment.upsert({
      where: { userId: params.userId },
      create: { userId: params.userId, ...payload },
      update: payload,
    }),
  ])
}

/** Score a new signup end to end: collect, score, persist. */
export async function assessNewSignup(params: {
  userId: string
  email: string
  provider: SignupProvider
  emailVerified: boolean
  headers: HeaderSource
  now?: Date
}): Promise<SignupRiskResult> {
  const request = readSignupRequestInfo(params.headers)
  const features = await collectSignupRiskFeatures({
    userId: params.userId,
    email: params.email,
    provider: params.provider,
    emailVerified: params.emailVerified,
    request,
    now: params.now,
  })
  const result = scoreSignupRisk(features)
  await recordSignupRiskAssessment({
    userId: params.userId,
    email: params.email,
    provider: params.provider,
    request,
    result,
  })
  return result
}
