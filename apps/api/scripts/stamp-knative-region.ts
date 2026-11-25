// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * stamp-knative-region.ts
 *
 * Backfill the home region into the SERVER_BACKED KV value of existing
 * server-backed published apps (SHO-588).
 *
 * Before SHO-588 the value was a bare `knative`, so the `*.shogo.one`
 * subdomain-router Worker sent every Knative app to its single default Kourier
 * (the US one). A Knative app's ksvc + DomainMappings only exist in its
 * workspace's home region's cluster, so an EU-homed app got US Kourier, which
 * has no DomainMapping for it, and every `/api/*` call returned 404. The API now
 * writes `knative:<code>` itself; this script fixes the entries written before
 * that, so those apps are routed by region instead of by America.
 *
 * It never guesses. For each entry it asks every region's Kourier whether it
 * knows the app — `GET /ready` over plain HTTP with `Host: <subdomain>`, the same
 * check used to diagnose the bug — and writes the code only when exactly one
 * region answers and that region is the workspace's home region. Anything
 * ambiguous (both answer, neither answers, probe disagrees with homeRegion) is
 * printed and left alone, because a wrong write would break a working app.
 *
 * Required env (same vars the api ksvc reads):
 *   DATABASE_URL                        — to resolve each app's home region.
 *   CF_API_TOKEN (or CF_CUSTOM_HOSTNAMES_TOKEN), CF_ACCOUNT_ID,
 *   CF_SERVER_BACKED_KV_NAMESPACE_ID    — to list and rewrite the KV entries.
 *
 * Usage (run from a prod API pod, which has the CF + DB env):
 *   bun apps/api/scripts/stamp-knative-region.ts            # dry run (default)
 *   bun apps/api/scripts/stamp-knative-region.ts --yes
 *   bun apps/api/scripts/stamp-knative-region.ts --subdomain play-samsara-api --yes
 *
 * Flags:
 *   --yes                 Actually write (a bare run only prints the table).
 *   --subdomain <name>    Limit to one subdomain (repeatable).
 *
 * Exit code 0 when every entry was decided (written, already stamped, or
 * deliberately left alone), 1 when a KV read/write failed.
 */

import { prisma } from '../src/lib/prisma'
import {
  getServerBackedKvConfig,
  listServerBackedEntries,
  setServerBackedFlag,
} from '../src/lib/cloudflare-server-backed-kv'
import { PRIMARY_REGION, regionCodeForId } from '../src/lib/region'

/**
 * Kourier LoadBalancer addresses by region code. Mirrors the stable
 * OCI-assigned addresses the terraform uses for the same LBs:
 * `terraform/environments/edge-global/variables.tf` (`us_lb_ip` / `eu_lb_ip`)
 * and `terraform/environments/production-us/main.tf`
 * (`prod_us_kourier_lb_ip` / `prod_eu_kourier_lb_ip`). Not terraform-managed —
 * the Services live in the clusters. Override with KNATIVE_KOURIER_LBS
 * (`{"us":"1.2.3.4"}`) when a region is added or an address changes.
 */
const DEFAULT_KOURIER_LBS: Record<string, string> = {
  us: '152.70.192.220',
  eu: '79.76.126.115',
}

function kourierLbs(): Record<string, string> {
  const raw = process.env.KNATIVE_KOURIER_LBS
  if (!raw) return DEFAULT_KOURIER_LBS
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : DEFAULT_KOURIER_LBS
  } catch {
    return DEFAULT_KOURIER_LBS
  }
}

const PROBE_TIMEOUT_MS = 8000

/**
 * Ask one region's Kourier whether it serves `host`. `null` means we could not
 * get an answer (timeout / connection error) — not "it does not have it".
 */
export async function probeKourierReady(
  lbIp: string,
  host: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`http://${lbIp}/ready`, {
      // Keep the app's own host (the DomainMapping resolves off it) and only
      // aim the connection at one region's LB.
      headers: { Host: host, 'User-Agent': 'shogo-stamp-knative-region' },
      redirect: 'manual',
      signal: ctrl.signal,
    })
    return res.status
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface StampInput {
  /** The current raw KV value (`knative`, `1`, `knative:eu`, `metal`, …). */
  value: string
  /** `workspace.homeRegion`, or null for a legacy row (→ PRIMARY_REGION). */
  homeRegion: string | null
  /** Region code → the HTTP status its Kourier answered with (null = no answer). */
  probes: Record<string, number | null>
}

export type StampDecision =
  /** Nothing to do (metal, static, already stamped) — `reason` says why. */
  | { action: 'skip'; reason: string }
  /** Ambiguous or contradictory evidence: leave the entry alone and report it. */
  | { action: 'report'; reason: string }
  /** Write `value` (always `knative:<code>`). */
  | { action: 'write'; region: string; value: string; reason: string }

/**
 * The whole decision, pure: current value × home region × which Kouriers
 * answered → write / skip / report. `404` means "this region has no
 * DomainMapping for the app"; any other status means it does.
 */
export function decideStamp(input: StampInput): StampDecision {
  const raw = input.value.trim().toLowerCase()
  if (!raw) return { action: 'skip', reason: 'no flag (static app)' }
  if (raw.startsWith('metal')) return { action: 'skip', reason: 'metal backend' }
  const colon = raw.indexOf(':')
  const base = colon === -1 ? raw : raw.slice(0, colon)
  const stamped = colon === -1 ? null : raw.slice(colon + 1).trim() || null
  if (base !== 'knative' && base !== '1') {
    return { action: 'skip', reason: `unrecognised value "${raw}"` }
  }
  if (stamped) return { action: 'skip', reason: `already stamped knative:${stamped}` }

  const homeCode = regionCodeForId(input.homeRegion ?? PRIMARY_REGION)
  if (!homeCode) {
    return {
      action: 'report',
      reason: `home region ${input.homeRegion ?? PRIMARY_REGION} has no edge anchor`,
    }
  }

  const answered = Object.entries(input.probes)
    .filter(([, status]) => status !== null && status !== 404)
    .map(([code]) => code)
  if (answered.length === 0) {
    return { action: 'report', reason: 'no Kourier answered for this app' }
  }
  if (answered.length > 1) {
    return { action: 'report', reason: `more than one Kourier answered (${answered.join(', ')})` }
  }
  if (answered[0] !== homeCode) {
    return {
      action: 'report',
      reason: `probe says ${answered[0]}, home region is ${homeCode} — not writing`,
    }
  }
  return {
    action: 'write',
    region: homeCode,
    value: `knative:${homeCode}`,
    reason: `only ${homeCode} Kourier knows this app, matching home region`,
  }
}

interface Cli {
  apply: boolean
  subdomains: string[]
}

function parseArgs(argv: string[]): Cli {
  const subdomains: string[] = []
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '--apply') apply = true
    else if (a === '--subdomain') {
      const next = argv[++i]
      if (!next) throw new Error('--subdomain needs a value')
      subdomains.push(next)
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: stamp-knative-region.ts [--yes] [--subdomain <name>]...')
      process.exit(0)
    } else {
      throw new Error(`Unknown arg: ${a}`)
    }
  }
  return { apply, subdomains }
}

async function main(): Promise<boolean> {
  const cli = parseArgs(process.argv.slice(2))
  const publishDomain = process.env.PUBLISH_DOMAIN || 'shogo.one'
  const lbs = kourierLbs()

  console.log('\n=== stamp SERVER_BACKED with the Knative home region (SHO-588) ===\n')
  console.log(cli.apply ? '  MODE: APPLY (writes KV)\n' : '  MODE: DRY-RUN (no writes)\n')

  if (!getServerBackedKvConfig()) {
    console.error(
      '  ✗ SERVER_BACKED KV is not configured — set CF_API_TOKEN (or CF_CUSTOM_HOSTNAMES_TOKEN) ' +
        '+ CF_ACCOUNT_ID + CF_SERVER_BACKED_KV_NAMESPACE_ID',
    )
    return false
  }

  const all = await listServerBackedEntries()
  if (!all) {
    console.error('  ✗ could not list the SERVER_BACKED namespace')
    return false
  }
  const entries = cli.subdomains.length
    ? all.filter((e) => cli.subdomains.includes(e.subdomain))
    : all
  console.log(`  ${all.length} KV entr${all.length === 1 ? 'y' : 'ies'}, ${entries.length} to examine\n`)

  const rows: Array<{
    subdomain: string
    homeRegion: string
    value: string
    probes: string
    action: string
  }> = []
  let failed = false
  let stamped = 0
  let stampable = 0

  for (const entry of entries) {
    const project = await prisma.project
      .findUnique({
        where: { publishedSubdomain: entry.subdomain },
        select: { id: true, workspace: { select: { homeRegion: true } } },
      })
      .catch(() => null)
    const homeRegion = project?.workspace?.homeRegion ?? PRIMARY_REGION
    const customDomains = project
      ? await prisma.customDomain
          .findMany({ where: { projectId: project.id }, select: { hostname: true, status: true } })
          .catch(() => [])
      : []

    const probes: Record<string, number | null> = {}
    for (const [code, ip] of Object.entries(lbs)) {
      probes[code] = await probeKourierReady(ip, `${entry.subdomain}.${publishDomain}`)
    }

    const decision = decideStamp({ value: entry.value, homeRegion, probes })
    for (const domain of customDomains) {
      const hits: string[] = []
      for (const [code, ip] of Object.entries(lbs)) {
        const status = await probeKourierReady(ip, domain.hostname)
        if (status !== null && status !== 404) hits.push(code)
      }
      console.log(
        `  custom domain ${domain.hostname} (${domain.status}): ` +
          (hits.length ? `DomainMapping in ${hits.join(', ')}` : 'no Kourier has a DomainMapping'),
      )
    }

    const probeLabel = Object.entries(probes)
      .map(([code, status]) => `${code}=${status === null ? 'no-answer' : status}`)
      .join(' ')
    let action: string = decision.action
    if (decision.action === 'write') {
      if (cli.apply) {
        const ok = await setServerBackedFlag(entry.subdomain, 'knative', decision.region)
        if (!ok) {
          failed = true
          action = 'write FAILED'
        } else {
          action = `wrote ${decision.value}`
          stamped++
        }
      } else {
        action = `would write ${decision.value}`
        stampable++
      }
    }
    console.log(
      `  ${entry.subdomain.padEnd(32)} value=${entry.value.padEnd(10)} ` +
        `home=${homeRegion.padEnd(16)} ${probeLabel.padEnd(28)} ${action} — ${decision.reason}`,
    )
    rows.push({
      subdomain: entry.subdomain,
      homeRegion,
      value: entry.value,
      probes: probeLabel,
      action: `${action} (${decision.reason})`,
    })
  }

  console.log('\n=== summary ===')
  console.log(`  entries examined:        ${rows.length}`)
  console.log(`  entries written:         ${stamped}`)
  console.log(`  entries to write:        ${stampable}`)
  if (!cli.apply) console.log('\n  (dry run — re-run with --yes to write)')
  return !failed
}

if (import.meta.main) {
  main()
    .then(async (success) => {
      await prisma.$disconnect().catch(() => {})
      process.exit(success ? 0 : 1)
    })
    .catch(async (err) => {
      console.error('\nFATAL', err)
      await prisma.$disconnect().catch(() => {})
      process.exit(1)
    })
}
