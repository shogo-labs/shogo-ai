// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Server-side DNS check for a bring-your-own custom domain.
 *
 * Cloudflare's custom-hostname status tells us whether IT can see the
 * records, but when a domain is stuck we want to know — independently and
 * authoritatively — whether the CUSTOMER's records are actually correct, so
 * we can (a) tell them precisely what's still missing and (b) gate the
 * "Retrigger" button / auto-heal on "DNS is correct, the CA is just slow"
 * rather than re-triggering against records that were never added.
 *
 * Two things must be true for issuance to succeed:
 *   1. Routing — `<hostname>` CNAMEs at our fallback origin (apex domains may
 *      use CNAME-flattening, surfacing as A/AAAA records instead).
 *   2. SSL DV — `_acme-challenge.<hostname>` TXT contains every DCV token
 *      Cloudflare issued (there can be more than one; a partial set is the
 *      single most common cause of a wedged cert — see the rewire.sh case).
 *
 * All lookups are best-effort and fully isolated: a resolver throwing
 * (NXDOMAIN/ENODATA/timeout) maps to `missing`/`wrong`, never an exception.
 */

import { promises as dnsPromises } from 'node:dns'

/** Per-record result. `wrong` = present but pointing somewhere unexpected. */
export type DnsRecordStatus = 'ok' | 'wrong' | 'missing'
/** TXT can be `partial` when only some of the expected DCV tokens are seen. */
export type TxtRecordStatus = 'ok' | 'partial' | 'missing'

export interface CustomDomainDnsCheck {
  /** Routing CNAME (or flattened A/AAAA) at the apex/host. */
  cname: DnsRecordStatus
  /** `_acme-challenge` TXT coverage of the expected DCV tokens. */
  txt: TxtRecordStatus
  /** True only when routing resolves AND every expected TXT token is present. */
  ok: boolean
  /** The CNAME target we observed (for diagnostics / UI copy). */
  cnameTarget?: string
  /** How many of the expected DCV tokens were found in TXT. */
  txtFound: number
  /** How many DCV tokens Cloudflare expects (0 ⇒ none required yet). */
  txtExpected: number
  /** When this check ran (epoch ms). */
  checkedAt: number
}

/**
 * Pluggable resolver surface — defaults to `node:dns/promises`, overridable
 * in tests so we never hit the network. Each resolves an array (CNAME
 * targets, A addresses, or TXT chunk-arrays) or throws on NXDOMAIN/ENODATA.
 */
export interface DnsResolver {
  resolveCname(hostname: string): Promise<string[]>
  resolve4(hostname: string): Promise<string[]>
  resolveTxt(hostname: string): Promise<string[][]>
}

const defaultResolver: DnsResolver = {
  resolveCname: (h) => dnsPromises.resolveCname(h),
  resolve4: (h) => dnsPromises.resolve4(h),
  resolveTxt: (h) => dnsPromises.resolveTxt(h),
}

/** Normalise a hostname for comparison: lowercase, strip a trailing dot. */
function norm(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, '')
}

async function checkCname(
  resolver: DnsResolver,
  hostname: string,
  fallbackOrigin: string,
): Promise<{ status: DnsRecordStatus; target?: string }> {
  const want = norm(fallbackOrigin)
  try {
    const targets = (await resolver.resolveCname(hostname)).map(norm)
    if (targets.length === 0) {
      // No CNAME data — fall through to the A-record (flattening) check.
    } else if (targets.includes(want)) {
      return { status: 'ok', target: targets[0] }
    } else {
      return { status: 'wrong', target: targets[0] }
    }
  } catch {
    // No CNAME (NXDOMAIN/ENODATA) — try apex CNAME-flattening below.
  }
  // Apex domains can't host a CNAME, so providers flatten it to A/AAAA
  // records pointing at the edge. We can't re-derive the exact IPs, so any
  // resolvable A record is treated as correctly routed (Cloudflare's own
  // hostname status is the authoritative issuance signal regardless).
  try {
    const a = await resolver.resolve4(hostname)
    if (a.length > 0) return { status: 'ok', target: a[0] }
  } catch {
    // Nothing resolvable at all.
  }
  return { status: 'missing' }
}

async function checkTxt(
  resolver: DnsResolver,
  hostname: string,
  expectedValues: string[],
): Promise<{ status: TxtRecordStatus; found: number }> {
  const expected = expectedValues.map((v) => v.trim()).filter(Boolean)
  if (expected.length === 0) {
    // No DCV tokens required (e.g. http method, or cert already issued).
    return { status: 'ok', found: 0 }
  }
  let present: Set<string>
  try {
    const records = await resolver.resolveTxt(`_acme-challenge.${hostname}`)
    // Each TXT record is an array of string chunks; join chunks, trim quotes.
    present = new Set(records.map((chunks) => chunks.join('').trim()))
  } catch {
    return { status: 'missing', found: 0 }
  }
  const found = expected.filter((v) => present.has(v)).length
  if (found === 0) return { status: 'missing', found }
  if (found < expected.length) return { status: 'partial', found }
  return { status: 'ok', found }
}

/**
 * Resolve the routing CNAME + `_acme-challenge` TXT for a custom hostname and
 * report whether the customer's DNS is correct. `expectedTxtValues` are the
 * DCV tokens Cloudflare returned in its validation records.
 */
export async function checkCustomDomainDns(
  hostname: string,
  fallbackOrigin: string,
  expectedTxtValues: string[],
  resolver: DnsResolver = defaultResolver,
): Promise<CustomDomainDnsCheck> {
  const host = norm(hostname)
  const [cnameRes, txtRes] = await Promise.all([
    checkCname(resolver, host, fallbackOrigin),
    checkTxt(resolver, host, expectedTxtValues),
  ])
  return {
    cname: cnameRes.status,
    txt: txtRes.status,
    ok: cnameRes.status === 'ok' && txtRes.status === 'ok',
    cnameTarget: cnameRes.target,
    txtFound: txtRes.found,
    txtExpected: expectedTxtValues.filter((v) => v.trim()).length,
    checkedAt: Date.now(),
  }
}
