// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-VM TAP networking. Each microVM gets a /30 point-to-point link:
 *   host side  = x.x.x.1  (the tap device, on the host)
 *   guest side = x.x.x.2  (configured by the guest kernel via the ip= cmdline)
 *
 * The guest is reachable directly from the host at its /30 address, so the
 * node-agent talks to the in-guest agent over http://<guestIp>:<port> — no
 * port-forwarding shim (unlike the desktop's QEMU+SLIRP path).
 *
 * NAT to the internet is added per-tap so guests can reach outbound services
 * (S3/Postgres/AI-proxy over the mesh in production). Idempotent; safe to
 * re-run on restore (the tap must exist again before LoadSnapshot).
 */

import { execFileSync } from 'child_process'

function ip(args: string[]): void {
  execFileSync('ip', args, { stdio: 'pipe' })
}
function tryIp(args: string[]): void {
  try {
    ip(args)
  } catch {
    /* idempotent best-effort */
  }
}

export interface VmNet {
  tap: string
  hostIp: string
  guestIp: string
  netmask: string
  guestMac: string
  /** Kernel ip= cmdline fragment for static guest config. */
  bootIpArg: string
}

/**
 * Deterministically derive a /30 for VM index `n`. n=0 -> 172.16.0.0/30
 * (host .1, guest .2), n=1 -> 172.16.0.4/30, etc.
 */
export function deriveNet(n: number, base = '172.16.0.0'): VmNet {
  const [a, b, c] = base.split('.').map(Number)
  const block = n * 4 // each VM consumes a /30 (4 addresses)
  const third = c + (block >> 8)
  const hostLast = (block & 0xff) + 1
  const guestLast = (block & 0xff) + 2
  const hostIp = `${a}.${b}.${third}.${hostLast}`
  const guestIp = `${a}.${b}.${third}.${guestLast}`
  const tap = `fctap${n}`
  // Locally-administered, unicast MAC derived from the /30 (third + guest octet).
  const hx = (v: number) => (v & 0xff).toString(16).padStart(2, '0')
  const guestMac = `06:00:AC:10:${hx(third)}:${hx(guestLast)}`
  const netmask = '255.255.255.252'
  return {
    tap,
    hostIp,
    guestIp,
    netmask,
    guestMac,
    // ip=<client>::<gw>:<mask>::<dev>:off  (kernel IP autoconfig, no DHCP)
    bootIpArg: `ip=${guestIp}::${hostIp}:${netmask}::eth0:off`,
  }
}

/** Create (or re-create) the tap device and its host-side address + NAT. */
export function setupTap(net: VmNet, uplink?: string): void {
  tryIp(['link', 'del', net.tap]) // clear any stale device
  ip(['tuntap', 'add', 'dev', net.tap, 'mode', 'tap'])
  ip(['addr', 'add', `${net.hostIp}/30`, 'dev', net.tap])
  ip(['link', 'set', 'dev', net.tap, 'up'])

  // Best-effort outbound NAT so guests can reach the internet / mesh.
  if (uplink) {
    try {
      execFileSync('sh', [
        '-c',
        `sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1;
         iptables -t nat -C POSTROUTING -o ${uplink} -j MASQUERADE 2>/dev/null ||
           iptables -t nat -A POSTROUTING -o ${uplink} -j MASQUERADE;
         iptables -C FORWARD -i ${net.tap} -o ${uplink} -j ACCEPT 2>/dev/null ||
           iptables -A FORWARD -i ${net.tap} -o ${uplink} -j ACCEPT;
         iptables -C FORWARD -i ${uplink} -o ${net.tap} -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null ||
           iptables -A FORWARD -i ${uplink} -o ${net.tap} -m state --state RELATED,ESTABLISHED -j ACCEPT`,
      ])
    } catch {
      /* NAT is optional for the local e2e */
    }
  }
}

export function teardownTap(net: VmNet): void {
  tryIp(['link', 'del', net.tap])
}

/** Best-effort default-route interface, used as the NAT uplink. */
export function defaultUplink(): string | undefined {
  try {
    const out = execFileSync('sh', ['-c', "ip route show default | awk '{print $5; exit}'"], {
      encoding: 'utf8',
    }).trim()
    return out || undefined
  } catch {
    return undefined
  }
}
