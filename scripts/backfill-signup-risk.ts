#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Read-only calibration of the signup risk scorer against historical signups.
 *
 * Input is a TSV exported from the production replica (read-only transaction):
 *   user_id  email  email_verified  created_at(ISO UTC)  first_session_ip  paid
 *
 *   kubectl --context <prod> exec -i -n shogo-production-system platform-pg-1 \
 *     -c postgres -- psql -U postgres -d shogo -X -q < query.sql > signups.tsv
 *
 * Usage:
 *   bun scripts/backfill-signup-risk.ts /tmp/signups-90d.tsv [--json]
 *
 * It rebuilds the features the live scorer would have seen at signup, using
 * only accounts created *before* each signup (the same rule the live path
 * applies), then reports:
 *   - band and decision distribution
 *   - paid conversion by band
 *   - false positives: paying accounts that fall in the high band
 *   - which signals fire on paying accounts
 *
 * Limitations (see the report header): historical device ids and provider
 * are unknown, so device links are 0 and every signup is scored as credential.
 * Emails are never printed; domains only.
 *
 * Writes nothing and calls no network service.
 */

import { readFileSync } from 'node:fs'
import { scoreSignupRisk, type SignupRiskFeatures, type SignupRiskResult } from '../apps/api/src/services/signup-risk-scoring'
import { canonicalizeEmail, emailDomain } from '../apps/api/src/lib/email-canonical'
import { SIGNUP_RISK_WINDOW_DAYS, SIGNUP_RISK_BURST_MINUTES } from '../apps/api/src/config/signup-risk-config'

interface Row {
  userId: string
  email: string
  emailVerified: boolean
  createdAt: number
  ip: string
  paid: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_MS = SIGNUP_RISK_WINDOW_DAYS * DAY_MS
const BURST_MS = SIGNUP_RISK_BURST_MINUTES * 60 * 1000

function parseRows(path: string): Row[] {
  const rows: Row[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const [userId, email, verified, createdAt, ip, paid] = line.split('\t')
    if (!userId || !email) continue
    rows.push({
      userId,
      email,
      emailVerified: verified === 't',
      createdAt: Date.parse(createdAt),
      ip: ip ?? '',
      paid: paid === 't',
    })
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

/** Live-path IPv6 /64 grouping, IPv4 as-is. Mirrors signup-risk.service ipPrefixFor. */
function ipKey(ip: string): string {
  if (!ip) return ''
  if (!ip.includes(':')) return ip
  return ip.split(':').slice(0, 4).join(':')
}

/**
 * Two views per signup:
 *  - `signup`: what the live path decides at creation. Credential accounts start
 *    unverified; only earlier accounts count (no look-ahead).
 *  - `final`: what the verification re-score decides. Uses the recorded email
 *    verification state and counts accounts on both sides of the window, since
 *    the re-score runs after later signups have already happened.
 */
function scoreAll(rows: Row[]) {
  const byIp = new Map<string, number[]>()
  for (const r of rows) {
    const key = ipKey(r.ip)
    if (!key) continue
    const list = byIp.get(key) ?? []
    list.push(r.createdAt)
    byIp.set(key, list)
  }
  const canonicalTotal = new Map<string, number>()
  for (const r of rows) {
    const c = canonicalizeEmail(r.email)
    canonicalTotal.set(c, (canonicalTotal.get(c) ?? 0) + 1)
  }

  const priorByIp = new Map<string, number[]>()
  const seenCanonical = new Map<string, number>()
  const out: Array<{ row: Row; signup: SignupRiskResult; final: SignupRiskResult }> = []

  for (const row of rows) {
    const key = ipKey(row.ip)
    const priors = key ? (priorByIp.get(key) ?? []) : []
    const canonical = canonicalizeEmail(row.email)
    const collisionsBefore = seenCanonical.get(canonical) ?? 0

    const signupFeatures: SignupRiskFeatures = {
      email: row.email,
      provider: 'credential',
      emailVerified: false,
      allowlisted: false,
      canonicalCollisions: collisionsBefore,
      deviceLinkedAccounts: 0,
      ipLinkedAccounts: priors.filter((t) => row.createdAt - t <= WINDOW_MS).length,
      burstSignups: priors.filter((t) => row.createdAt - t <= BURST_MS).length,
    }

    const all = key ? (byIp.get(key) ?? []) : []
    const others = all.filter((t) => t !== row.createdAt)
    const finalFeatures: SignupRiskFeatures = {
      email: row.email,
      provider: 'credential',
      emailVerified: row.emailVerified,
      allowlisted: false,
      canonicalCollisions: (canonicalTotal.get(canonical) ?? 1) - 1,
      deviceLinkedAccounts: 0,
      ipLinkedAccounts: others.filter((t) => Math.abs(row.createdAt - t) <= WINDOW_MS).length,
      burstSignups: others.filter((t) => Math.abs(row.createdAt - t) <= BURST_MS).length,
    }
    out.push({ row, signup: scoreSignupRisk(signupFeatures), final: scoreSignupRisk(finalFeatures) })

    if (key) priorByIp.set(key, [...priors, row.createdAt])
    seenCanonical.set(canonical, collisionsBefore + 1)
  }
  return out
}

type View = 'signup' | 'final'

function summarize(scored: ReturnType<typeof scoreAll>, view: View) {
  const byBand: Record<string, { total: number; paid: number }> = {}
  const decisions: Record<string, { total: number; paid: number }> = {}
  const signalHits: Record<string, { paid: number; unpaid: number }> = {}
  const highDomains: Record<string, number> = {}
  let payingTotal = 0
  let payingHigh = 0
  let payingMedium = 0
  let highTotal = 0
  let highUnpaid = 0

  for (const entry of scored) {
    const row = entry.row
    const result = view === 'signup' ? entry.signup : entry.final
    const band = (byBand[result.band] ??= { total: 0, paid: 0 })
    band.total += 1
    if (row.paid) band.paid += 1

    const dec = (decisions[result.decision] ??= { total: 0, paid: 0 })
    dec.total += 1
    if (row.paid) dec.paid += 1

    for (const sig of result.signals) {
      const hit = (signalHits[sig.name] ??= { paid: 0, unpaid: 0 })
      if (row.paid) hit.paid += 1
      else hit.unpaid += 1
    }

    if (row.paid) {
      payingTotal += 1
      if (result.band === 'high') payingHigh += 1
      if (result.band === 'medium') payingMedium += 1
    }
    if (result.band === 'high') {
      highTotal += 1
      if (!row.paid) highUnpaid += 1
      const d = emailDomain(row.email)
      highDomains[d] = (highDomains[d] ?? 0) + 1
    }
  }

  return {
    byBand,
    decisions,
    signalHits,
    payingAccounts: payingTotal,
    payingInHighBand: payingHigh,
    payingInMediumBand: payingMedium,
    falsePositiveRateAmongPaying: payingTotal ? payingHigh / payingTotal : 0,
    highBandCount: highTotal,
    highBandUnpaidShare: highTotal ? highUnpaid / highTotal : 0,
    topHighBandDomains: Object.entries(highDomains).sort((a, b) => b[1] - a[1]).slice(0, 15),
  }
}

function printView(title: string, v: ReturnType<typeof summarize>, total: number) {
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')
  console.log(`\n=== ${title} ===`)
  console.log('Band distribution (paid conversion):')
  for (const [band, x] of Object.entries(v.byBand)) {
    console.log(`  ${band.padEnd(7)} ${String(x.total).padStart(6)}  paid ${x.paid} (${pct(x.paid, x.total)})`)
  }
  console.log('Credit decisions:')
  for (const [dec, x] of Object.entries(v.decisions)) {
    console.log(`  ${dec.padEnd(14)} ${String(x.total).padStart(6)}  paid ${x.paid} (${pct(x.paid, x.total)})`)
  }
  console.log('Signal hits (paid vs unpaid accounts):')
  for (const [name, x] of Object.entries(v.signalHits).sort((a, b) => b[1].paid + b[1].unpaid - (a[1].paid + a[1].unpaid))) {
    console.log(`  ${name.padEnd(28)} paid ${String(x.paid).padStart(5)}  unpaid ${String(x.unpaid).padStart(6)}`)
  }
  console.log(`Paying accounts: ${v.payingAccounts} of ${total} signups`)
  console.log(`  in high band:   ${v.payingInHighBand} (false-positive rate ${pct(v.payingInHighBand, v.payingAccounts)})`)
  console.log(`  in medium band: ${v.payingInMediumBand} (${pct(v.payingInMediumBand, v.payingAccounts)})`)
  console.log(`High-band accounts that never paid: ${pct(Math.round(v.highBandUnpaidShare * v.highBandCount), v.highBandCount)} of ${v.highBandCount}`)
  console.log('Top high-band email domains (count):')
  for (const [domain, count] of v.topHighBandDomains) {
    console.log(`  ${domain.padEnd(28)} ${count}`)
  }
}

function main() {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: bun scripts/backfill-signup-risk.ts <signups.tsv> [--json]')
    process.exit(2)
  }
  const asJson = process.argv.includes('--json')
  const rows = parseRows(path)
  const scored = scoreAll(rows)
  const signup = summarize(scored, 'signup')
  const final = summarize(scored, 'final')

  if (asJson) {
    console.log(JSON.stringify({ signups: scored.length, windowDays: 90, signup, final }, null, 2))
    return
  }
  console.log(`Signups scored: ${scored.length} (last 90 days, read-only replica export)`)
  console.log('Limitations: device ids unavailable historically (device signal = 0); all rows scored as credential provider.')
  printView('Signup-time decision (unverified, no look-ahead)', signup, scored.length)
  printView('Final decision after verification (both sides of window)', final, scored.length)
}

main()
