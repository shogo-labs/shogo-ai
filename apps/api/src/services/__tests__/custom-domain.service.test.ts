// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the custom-domain pairing logic that drives the apex<->www
 * UX: `domainCompanion` decides what gets auto-created and which side is
 * canonical, and `canonicalForRow` resolves the redirect target (so flipping
 * `primary` flips the redirect). `cfStateToStatus` maps Cloudflare state to
 * our DB status enum.
 */
import { describe, test, expect } from 'bun:test'
import {
  domainCompanion,
  canonicalForRow,
  cfStateToStatus,
  deriveStage,
  evaluateRetrigger,
  shouldAutoRetrigger,
  isDueForPoll,
  parseDiagnostics,
  prettyCertAuthority,
  expectedTxtTokens,
  STALL_THRESHOLD_MS,
  MANUAL_COOLDOWN_MS,
  AUTO_RETRIGGER_INTERVAL_MS,
  MAX_RETRIGGERS,
  SLOW_POLL_AFTER_MS,
  SLOW_POLL_INTERVAL_MS,
  type CustomDomainRowLike,
} from '../custom-domain.service'
import type { CustomHostnameState } from '../../lib/cloudflare-custom-hostnames'

describe('domainCompanion', () => {
  test('apex pairs with www, www is primary', () => {
    expect(domainCompanion('acme.com')).toEqual({
      companion: 'www.acme.com',
      primaryHostname: 'www.acme.com',
    })
  })

  test('www pairs with its apex, www stays primary', () => {
    expect(domainCompanion('www.acme.com')).toEqual({
      companion: 'acme.com',
      primaryHostname: 'www.acme.com',
    })
  })

  test('deeper subdomains are not auto-paired', () => {
    expect(domainCompanion('app.acme.com')).toBeNull()
    expect(domainCompanion('www.app.acme.com')).toBeNull()
  })
})

describe('canonicalForRow', () => {
  const apex = { hostname: 'acme.com', groupId: 'g1', primary: false }
  const www = { hostname: 'www.acme.com', groupId: 'g1', primary: true }
  const group = [apex, www]

  test('standalone domain is its own canonical', () => {
    const solo = { hostname: 'app.acme.com', groupId: null, primary: true }
    expect(canonicalForRow(solo, [solo])).toBe('app.acme.com')
  })

  test('both members resolve to the primary (www) hostname', () => {
    expect(canonicalForRow(apex, group)).toBe('www.acme.com')
    expect(canonicalForRow(www, group)).toBe('www.acme.com')
  })

  test('flipping primary to the apex flips the canonical', () => {
    const flippedApex = { ...apex, primary: true }
    const flippedWww = { ...www, primary: false }
    const flipped = [flippedApex, flippedWww]
    expect(canonicalForRow(flippedApex, flipped)).toBe('acme.com')
    expect(canonicalForRow(flippedWww, flipped)).toBe('acme.com')
  })
})

describe('cfStateToStatus', () => {
  const base: CustomHostnameState = {
    id: 'ch-1',
    hostname: 'acme.com',
    status: 'pending',
    sslStatus: 'pending_validation',
    active: false,
    instructions: [],
    errors: [],
    certAuthority: null,
    validation: [],
  }

  test('active when CF reports active', () => {
    expect(cfStateToStatus({ ...base, active: true })).toBe('active')
  })

  test('failed when there are errors', () => {
    expect(cfStateToStatus({ ...base, errors: ['CNAME missing'] })).toBe('failed')
  })

  test('verifying once the cert moves past pending_validation', () => {
    expect(cfStateToStatus({ ...base, sslStatus: 'pending_issuance' })).toBe('verifying')
  })

  test('pending while awaiting DNS', () => {
    expect(cfStateToStatus(base)).toBe('pending')
  })
})

// A fixed clock so age = now - createdAt is deterministic.
const T0 = 1_000_000_000_000
function mkRow(overrides: Partial<CustomDomainRowLike> = {}): CustomDomainRowLike {
  return {
    id: 'd1',
    projectId: 'p1',
    hostname: 'acme.com',
    status: 'pending',
    cfCustomHostnameId: 'ch-1',
    sslStatus: 'pending_validation',
    lastError: null,
    groupId: null,
    primary: true,
    verifiedAt: null,
    certAuthority: null,
    lastCheckedAt: null,
    lastRetriggerAt: null,
    retriggerCount: 0,
    dnsOk: null,
    diagnostics: null,
    createdAt: new Date(T0),
    ...overrides,
  }
}

describe('deriveStage', () => {
  test('active → live', () => {
    expect(deriveStage(mkRow({ status: 'active' }), T0).stage).toBe('active')
  })

  test('failed surfaces the lastError', () => {
    const r = mkRow({ status: 'failed', lastError: 'CNAME missing' })
    const { stage, message } = deriveStage(r, T0)
    expect(stage).toBe('failed')
    expect(message).toBe('CNAME missing')
  })

  test('awaiting_dns until the records are seen', () => {
    expect(deriveStage(mkRow({ dnsOk: false }), T0).stage).toBe('awaiting_dns')
  })

  test('validating once DNS is correct (pre-threshold)', () => {
    const r = mkRow({ status: 'pending', dnsOk: true })
    expect(deriveStage(r, T0 + 60_000).stage).toBe('validating')
  })

  test('issuing while the cert is being minted, naming the CA', () => {
    const r = mkRow({ status: 'verifying', dnsOk: true, certAuthority: 'ssl_com' })
    const { stage, message } = deriveStage(r, T0 + 60_000)
    expect(stage).toBe('issuing')
    expect(message).toContain('SSL.com')
  })

  test('stalled once past the threshold with correct DNS', () => {
    const r = mkRow({ status: 'verifying', dnsOk: true })
    expect(deriveStage(r, T0 + STALL_THRESHOLD_MS + 1).stage).toBe('stalled')
  })

  test('not stalled past the threshold if DNS is NOT correct', () => {
    const r = mkRow({ status: 'pending', dnsOk: false })
    expect(deriveStage(r, T0 + STALL_THRESHOLD_MS + 1).stage).toBe('awaiting_dns')
  })
})

describe('evaluateRetrigger (manual gate)', () => {
  test('blocked when the feature is disabled', () => {
    expect(evaluateRetrigger(mkRow({ dnsOk: true }), false, T0 + STALL_THRESHOLD_MS + 1)).toEqual({
      allowed: false,
      reason: 'not_enabled',
    })
  })

  test('blocked when already active', () => {
    const r = mkRow({ status: 'active', dnsOk: true })
    expect(evaluateRetrigger(r, true, T0 + STALL_THRESHOLD_MS + 1).reason).toBe('active')
  })

  test('blocked when DNS is not ready', () => {
    const r = mkRow({ dnsOk: false })
    expect(evaluateRetrigger(r, true, T0 + STALL_THRESHOLD_MS + 1).reason).toBe('dns_not_ready')
  })

  test('too_early before the stall threshold (reports waitMs)', () => {
    const r = mkRow({ dnsOk: true })
    const gate = evaluateRetrigger(r, true, T0 + 60_000)
    expect(gate.reason).toBe('too_early')
    expect(gate.waitMs).toBe(STALL_THRESHOLD_MS - 60_000)
  })

  test('cooldown right after a retrigger (reports remaining)', () => {
    const now = T0 + STALL_THRESHOLD_MS + 1
    const r = mkRow({ dnsOk: true, lastRetriggerAt: new Date(now - 60_000) })
    const gate = evaluateRetrigger(r, true, now)
    expect(gate.reason).toBe('cooldown')
    expect(gate.cooldownRemainingMs).toBe(MANUAL_COOLDOWN_MS - 60_000)
  })

  test('allowed when stalled, DNS ok, and outside cooldown', () => {
    const now = T0 + STALL_THRESHOLD_MS + 1
    const r = mkRow({ dnsOk: true, lastRetriggerAt: new Date(now - MANUAL_COOLDOWN_MS - 1) })
    expect(evaluateRetrigger(r, true, now)).toEqual({ allowed: true })
  })
})

describe('shouldAutoRetrigger (reconciler backoff + cap)', () => {
  const stalledNow = T0 + STALL_THRESHOLD_MS + 1

  test('triggers for a stalled, DNS-correct, never-retriggered domain', () => {
    expect(shouldAutoRetrigger(mkRow({ status: 'verifying', dnsOk: true }), stalledNow)).toBe(true)
  })

  test('skips when DNS is not correct (never re-trigger blind)', () => {
    expect(shouldAutoRetrigger(mkRow({ status: 'verifying', dnsOk: false }), stalledNow)).toBe(false)
  })

  test('skips before the stall threshold', () => {
    expect(shouldAutoRetrigger(mkRow({ status: 'verifying', dnsOk: true }), T0 + 60_000)).toBe(false)
  })

  test('backs off within the auto-retrigger interval', () => {
    const r = mkRow({
      status: 'verifying',
      dnsOk: true,
      lastRetriggerAt: new Date(stalledNow - AUTO_RETRIGGER_INTERVAL_MS + 1),
      retriggerCount: 1,
    })
    expect(shouldAutoRetrigger(r, stalledNow)).toBe(false)
  })

  test('re-triggers again once past the interval', () => {
    const r = mkRow({
      status: 'verifying',
      dnsOk: true,
      lastRetriggerAt: new Date(stalledNow - AUTO_RETRIGGER_INTERVAL_MS - 1),
      retriggerCount: 1,
    })
    expect(shouldAutoRetrigger(r, stalledNow)).toBe(true)
  })

  test('stops once the cap is reached', () => {
    const r = mkRow({ status: 'verifying', dnsOk: true, retriggerCount: MAX_RETRIGGERS })
    expect(shouldAutoRetrigger(r, stalledNow)).toBe(false)
  })

  test('only for pending/verifying, never active or failed', () => {
    expect(shouldAutoRetrigger(mkRow({ status: 'active', dnsOk: true }), stalledNow)).toBe(false)
    expect(shouldAutoRetrigger(mkRow({ status: 'failed', dnsOk: true }), stalledNow)).toBe(false)
  })
})

describe('isDueForPoll (slow-poll backoff)', () => {
  test('young domain is always due (fast cadence)', () => {
    const r = mkRow({ lastCheckedAt: new Date(T0 + 30_000) })
    expect(isDueForPoll(r, T0 + 60_000)).toBe(true)
  })

  test('old domain is due when it has never been checked', () => {
    const r = mkRow({ lastCheckedAt: null })
    expect(isDueForPoll(r, T0 + SLOW_POLL_AFTER_MS + 1)).toBe(true)
  })

  test('old domain is NOT due within the slow interval', () => {
    const now = T0 + SLOW_POLL_AFTER_MS + 1
    const r = mkRow({ lastCheckedAt: new Date(now - 60_000) })
    expect(isDueForPoll(r, now)).toBe(false)
  })

  test('old domain is due again once past the slow interval', () => {
    const now = T0 + SLOW_POLL_AFTER_MS + SLOW_POLL_INTERVAL_MS + 1
    const r = mkRow({ lastCheckedAt: new Date(now - SLOW_POLL_INTERVAL_MS - 1) })
    expect(isDueForPoll(r, now)).toBe(true)
  })
})

describe('helpers', () => {
  test('prettyCertAuthority maps known slugs', () => {
    expect(prettyCertAuthority('ssl_com')).toBe('SSL.com')
    expect(prettyCertAuthority('lets_encrypt')).toBe("Let's Encrypt")
    expect(prettyCertAuthority(null)).toBeNull()
    expect(prettyCertAuthority('mystery')).toBe('mystery')
  })

  test('parseDiagnostics tolerates null + garbage', () => {
    expect(parseDiagnostics(null)).toBeNull()
    expect(parseDiagnostics('{not json')).toBeNull()
    expect(parseDiagnostics('{"dnsOk":true}')).toEqual({ dnsOk: true } as any)
  })

  test('expectedTxtTokens prefers validation, falls back to instructions', () => {
    const withValidation: CustomHostnameState = {
      id: 'ch', hostname: 'acme.com', status: 'pending', sslStatus: null, active: false,
      instructions: [], errors: [], certAuthority: null,
      validation: [{ name: '_acme-challenge.acme.com', value: 'tokA', status: 'pending' }],
    }
    expect(expectedTxtTokens(withValidation)).toEqual(['tokA'])

    const fromInstructions: CustomHostnameState = {
      id: 'ch', hostname: 'acme.com', status: 'pending', sslStatus: null, active: false,
      instructions: [
        { type: 'CNAME', name: 'acme.com', value: 'cname.shogo.one', purpose: 'routing' },
        { type: 'TXT', name: '_acme-challenge.acme.com', value: 'tokB', purpose: 'ssl-validation' },
      ],
      errors: [], certAuthority: null, validation: [],
    }
    expect(expectedTxtTokens(fromInstructions)).toEqual(['tokB'])
  })
})
