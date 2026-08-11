// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'

import { CHAIN, ControlFirewall, chainRules, hookArgs } from './control-firewall'

const SPEC = {
  port: 9900,
  allow: ['129.80.99.116/32', '92.5.64.210/32'],
  guestCidr: '172.16.0.0/12',
}

const flat = (rules: string[][]) => rules.map((r) => r.join(' '))
/** Index of the first rule matching a predicate, or -1. */
const idx = (rules: string[][], pred: (r: string) => boolean) => flat(rules).findIndex(pred)

describe('chainRules ordering (iptables is first-match, so order IS the policy)', () => {
  const rules = chainRules(SPEC)

  test('drops everything as the final rule', () => {
    expect(rules[rules.length - 1]).toEqual(['-j', 'DROP'])
  })

  test('the catch-all DROP is last, so no ACCEPT is unreachable behind it', () => {
    const drop = flat(rules).lastIndexOf('-j DROP')
    const accepts = flat(rules)
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.includes('ACCEPT'))
    expect(accepts.length).toBeGreaterThan(0)
    for (const a of accepts) expect(a.i).toBeLessThan(drop)
  })

  test('anti-spoof precedes the loopback accept, or the exemption is forgeable', () => {
    // auth.ts skips the bearer for loopback. That is only sound if a remote
    // packet cannot claim a loopback source, so the DROP must be evaluated
    // before the ACCEPT that trusts `-i lo`.
    const spoof = idx(rules, (r) => r.includes('127.0.0.0/8') && r.includes('DROP'))
    const loopback = idx(rules, (r) => r.includes('-i lo') && r.includes('ACCEPT'))
    expect(spoof).toBeGreaterThanOrEqual(0)
    expect(loopback).toBeGreaterThan(spoof)
  })

  test('the anti-spoof rule only fires off the loopback interface', () => {
    // Without the `! -i lo` qualifier this would drop genuine local traffic
    // and take out every on-host operator tool at once.
    const spoof = rules.find((r) => r.join(' ').includes('127.0.0.0/8'))!
    expect(spoof.slice(0, 3)).toEqual(['!', '-i', 'lo'])
  })
})

describe('chainRules: the things that break the host if omitted', () => {
  const rules = chainRules(SPEC)

  test('guests can always reach the agent, so cold boots keep hydrating', () => {
    // /hydrate-stream is served on this same port over the tap link. Dropping
    // it would break every cold boot on the host — the easiest allowlist
    // mistake to make, so it is not sourced from operator config at all.
    expect(flat(rules)).toContain('-s 172.16.0.0/12 -j ACCEPT')
  })

  test('the guest rule survives an empty operator allowlist', () => {
    const bare = chainRules({ ...SPEC, allow: [] })
    expect(flat(bare)).toContain('-s 172.16.0.0/12 -j ACCEPT')
    expect(flat(bare)).toContain('-i lo -j ACCEPT')
    expect(bare[bare.length - 1]).toEqual(['-j', 'DROP'])
  })

  test('both regional control planes are admitted on every host', () => {
    // destroyEverywhere fans out across regions, so a US-only rule on a
    // Frankfurt host would silently break project deletion.
    expect(flat(rules)).toContain('-s 129.80.99.116/32 -j ACCEPT')
    expect(flat(rules)).toContain('-s 92.5.64.210/32 -j ACCEPT')
  })

  test('the guest supernet is derived, not hardcoded, so it tracks the TAP base', () => {
    const moved = chainRules({ ...SPEC, guestCidr: '10.200.0.0/12' })
    expect(flat(moved)).toContain('-s 10.200.0.0/12 -j ACCEPT')
    expect(flat(moved).some((r) => r.includes('172.16'))).toBe(false)
  })
})

describe('hookArgs', () => {
  test('scopes the jump to the agent port only', () => {
    expect(hookArgs(9900)).toEqual(['INPUT', '-p', 'tcp', '--dport', '9900', '-j', CHAIN])
  })

  test('follows the configured port rather than assuming 9900', () => {
    expect(hookArgs(9999)).toContain('9999')
  })
})

describe('ControlFirewall enablement', () => {
  const cfg = (ctrlAllowCidr: string) =>
    ({ ctrlAllowCidr, listenPort: 9900, tapCidrBase: '172.16.0.0' }) as any

  test('off when no allowlist is configured', () => {
    // A host whose env file predates this feature must not fence itself off
    // from the control plane that would have to fix it.
    const fw = new ControlFirewall(cfg(''))
    expect(fw.enabled).toBe(false)
    expect(fw.describe()).toContain('off')
  })

  test('on once an allowlist is present, and says what it will enforce', () => {
    const fw = new ControlFirewall(cfg('129.80.99.116/32, 92.5.64.210/32'))
    expect(fw.enabled).toBe(true)
    expect(fw.describe()).toContain('129.80.99.116/32')
    expect(fw.describe()).toContain('172.16.0.0/12')
  })

  test('tolerates whitespace and trailing separators in the env value', () => {
    const fw = new ControlFirewall(cfg(' 129.80.99.116/32 , , '))
    expect(fw.enabled).toBe(true)
    expect(fw.describe()).toContain('129.80.99.116/32')
  })
})
