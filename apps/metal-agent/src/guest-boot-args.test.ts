// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Guest kernel cmdline. `clocksource=kvm-clock` is load-bearing: it is the only
 * thing that makes `clock_realtime` on `/snapshot/load` move the guest's wall
 * clock (see guestBootArgs and fc-api.loadSnapshot).
 */

import { describe, expect, test } from 'bun:test'
import { guestBootArgs } from './firecracker-vm-manager'

const BOOT_IP = 'ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off'

describe('guestBootArgs', () => {
  test('pins the clocksource so a restored guest gets the host clock', () => {
    const args = guestBootArgs({ bootIpArg: BOOT_IP, guestInit: '/usr/local/bin/fc-init' }).split(' ')
    expect(args).toContain('clocksource=kvm-clock')
    // Not a duplicate of anything the kernel would resolve in the other order.
    expect(args.filter((a) => a.startsWith('clocksource='))).toEqual(['clocksource=kvm-clock'])
  })

  test('still carries the network, root and init args', () => {
    const args = guestBootArgs({ bootIpArg: BOOT_IP, guestInit: '/usr/local/bin/fc-init' })
    expect(args).toContain('root=/dev/vda')
    expect(args).toContain(BOOT_IP)
    expect(args).toContain('init=/usr/local/bin/fc-init')
    expect(args).not.toContain('  ')
  })

  test('omits init when the host has none, and appends extra args', () => {
    const args = guestBootArgs({ bootIpArg: BOOT_IP, extra: 'console=ttyS1' })
    expect(args).not.toContain('init=')
    expect(args).toContain('clocksource=kvm-clock')
    expect(args.endsWith('console=ttyS1')).toBe(true)
  })
})
