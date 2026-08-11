// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * deriveNet / tapCapacity — the /30 per-VM address math.
 *
 * The prod incident these lock in (2026-07, US region): the tap-index counter
 * climbed past the /16's 16384 /30 blocks, so `deriveNet(530104)` computed a
 * 3rd octet of 8282 → `172.16.8282.225/30`, which `ip addr add` rejects with
 * "any valid prefix is expected". Every metal /assign 500'd and project
 * runtimes hung forever on "Project runtime is starting up…". deriveNet must
 * now fail LOUD for an out-of-range index instead of emitting a bad IP.
 *
 * Run: bun test apps/metal-agent/src/net.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { deriveNet, parseTapLinks, tapCapacity, TAP_NET_CAPACITY } from './net'

describe('tapCapacity', () => {
  test('default 172.16.0.0 base yields a /16 = 16384 /30 slots', () => {
    expect(tapCapacity('172.16.0.0')).toBe(16384)
    expect(TAP_NET_CAPACITY).toBe(16384)
  })

  test('a non-zero 3rd octet shrinks the usable space', () => {
    // Starting at .128.0 leaves 128 of the 256 3rd-octet values → half the /30s.
    expect(tapCapacity('172.16.128.0')).toBe((128 * 256) / 4)
  })
})

describe('deriveNet', () => {
  test('n=0 → 172.16.0.0/30 (host .1, guest .2)', () => {
    const net = deriveNet(0)
    expect(net.tap).toBe('fctap0')
    expect(net.hostIp).toBe('172.16.0.1')
    expect(net.guestIp).toBe('172.16.0.2')
    expect(net.netmask).toBe('255.255.255.252')
  })

  test('consecutive indices step by a /30 and carry into the 3rd octet', () => {
    expect(deriveNet(1).hostIp).toBe('172.16.0.5')
    // 64 /30s fill a /24, so index 64 rolls the 3rd octet to .1.
    expect(deriveNet(64).hostIp).toBe('172.16.1.1')
  })

  test('the last valid index (capacity-1) is still a valid address', () => {
    const last = deriveNet(TAP_NET_CAPACITY - 1)
    expect(last.hostIp).toBe('172.16.255.253')
    expect(last.guestIp).toBe('172.16.255.254')
    // Every octet must be a legal 0..255 value.
    for (const ip of [last.hostIp, last.guestIp]) {
      for (const oct of ip.split('.').map(Number)) {
        expect(oct).toBeGreaterThanOrEqual(0)
        expect(oct).toBeLessThanOrEqual(255)
      }
    }
  })

  test('THROWS at capacity instead of emitting an invalid 3rd octet', () => {
    expect(() => deriveNet(TAP_NET_CAPACITY)).toThrow(RangeError)
  })

  test('the exact prod-incident index (530104) throws, never 172.16.8282.225', () => {
    let out: string | null = null
    try {
      out = deriveNet(530104).hostIp
    } catch {
      out = null
    }
    expect(out).toBeNull()
    // Belt-and-suspenders: whatever the code does, it must never produce the
    // malformed address that wedged the host.
    expect(out).not.toBe('172.16.8282.225')
  })

  test('rejects negative / non-integer indices', () => {
    expect(() => deriveNet(-1)).toThrow(RangeError)
    expect(() => deriveNet(1.5)).toThrow(RangeError)
  })
})

/**
 * The orphan-tap GC's last safety guard: NO-CARRIER means no process holds the
 * tap's fd, so nothing can be using it. Getting `attached` wrong in the unsafe
 * direction would cut a live guest's networking, so ambiguous input must read as
 * attached (skip) rather than free (delete).
 */
describe('parseTapLinks', () => {
  const line = (n: number, flags: string) =>
    `${n + 4}: fctap${n}: <${flags}> mtu 1500 qdisc pfifo_fast state UP mode DEFAULT group default qlen 1000\\    link/ether 0a:1b:2c:3d:4e:5f`

  test('NO-CARRIER → unattached; carrier present → attached', () => {
    const taps = parseTapLinks(
      [line(3, 'NO-CARRIER,BROADCAST,MULTICAST,UP'), line(4, 'BROADCAST,MULTICAST,UP,LOWER_UP')].join('\n'),
    )
    expect(taps).toEqual([
      { index: 3, name: 'fctap3', attached: false },
      { index: 4, name: 'fctap4', attached: true },
    ])
  })

  test('ignores non-tap interfaces', () => {
    const txt = [
      '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN',
      '2: eno1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP',
      line(9, 'NO-CARRIER,BROADCAST,MULTICAST,UP'),
    ].join('\n')

    expect(parseTapLinks(txt).map((t) => t.index)).toEqual([9])
  })

  test('a flagless / unparseable device reads as attached, never as reclaimable', () => {
    const taps = parseTapLinks('12: fctap12: mtu 1500 qdisc pfifo_fast state UP')
    expect(taps).toEqual([{ index: 12, name: 'fctap12', attached: true }])
  })

  test('handles @-suffixed device names', () => {
    expect(parseTapLinks('8: fctap8@if2: <NO-CARRIER,UP> mtu 1500')[0]).toEqual({
      index: 8,
      name: 'fctap8',
      attached: false,
    })
  })
})
