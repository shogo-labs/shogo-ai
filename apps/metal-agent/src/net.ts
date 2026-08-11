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
 * How many /30 VM slots fit below `base` before the address overflows the two
 * host octets `deriveNet` varies (the 3rd + 4th). With the default
 * `172.16.0.0` the 1st/2nd octets are fixed and only the 3rd/4th vary, so the
 * usable space is a /16 = 65536 addresses = 16384 /30 blocks (indices
 * 0..16383). A non-zero 3rd octet in `base` shrinks it accordingly.
 *
 * This is a HARD ceiling: index `n === capacity` makes `deriveNet` compute a
 * 3rd octet of 256, i.e. an invalid IPv4 address (`172.16.256.x`) that
 * `ip addr add` rejects with "any valid prefix is expected". The allocator
 * MUST wrap within [0, capacity) and never hand out an index at/above it.
 */
export function tapCapacity(base = '172.16.0.0'): number {
  const c = Number(base.split('.')[2] ?? 0)
  return ((256 - c) * 256) / 4
}

/** Default /30 capacity for the standard `172.16.0.0` base (16384 slots). */
export const TAP_NET_CAPACITY = tapCapacity()

/**
 * Deterministically derive a /30 for VM index `n`. n=0 -> 172.16.0.0/30
 * (host .1, guest .2), n=1 -> 172.16.0.4/30, etc.
 *
 * Throws for an out-of-range `n` rather than silently emitting a malformed IP
 * (e.g. `172.16.8282.225` for n=530104): a bad address only surfaces later as
 * an opaque `ip addr add ... any valid prefix is expected` 500 from every
 * /assign, wedging the whole host. Fail loud at the source instead.
 */
export function deriveNet(n: number, base = '172.16.0.0'): VmNet {
  const [a, b, c] = base.split('.').map(Number)
  const cap = tapCapacity(base)
  if (!Number.isInteger(n) || n < 0 || n >= cap) {
    throw new RangeError(`deriveNet: VM index ${n} out of range [0, ${cap}) for base ${base}`)
  }
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
  teardownTapByName(net.tap)
}

/**
 * Delete a tap by device name. The GC sweep reclaims leaked devices it found on
 * the host with no owning VM, so it has a name and no {@link VmNet}.
 */
export function teardownTapByName(tap: string): void {
  tryIp(['link', 'del', tap])
}

export interface HostTap {
  index: number
  name: string
  /**
   * A process currently holds this tap's tun fd — i.e. a firecracker VM is
   * attached to it right now.
   */
  attached: boolean
}

/**
 * Every `fctap<n>` device on the host, with whether something is actually using
 * it. A persistent tap created by `ip tuntap add` reports NO-CARRIER until a
 * process opens its fd, and the flag comes back the moment that process dies —
 * so `attached` is the kernel's own "in use" answer, the tap analogue of the dm
 * Open count the rootfs reconciler relies on. That makes it a safe last guard
 * for the orphan-tap GC: a device nothing has open cannot be carrying a live
 * guest's traffic, whatever the pool's bookkeeping says.
 *
 * Deliberately separate from {@link existingTapIndices} rather than sharing its
 * parse: that function is on the VM-allocation hot path and its whole-text match
 * is intentionally over-inclusive (any mention of `fctap<n>` counts as taken).
 * Here we need per-device flags, so we parse line by line — and an
 * unparseable/flagless line is reported as attached, so ambiguity can only ever
 * make the GC skip a device, never reap one.
 */
export function existingTaps(): HostTap[] {
  try {
    return parseTapLinks(execFileSync('ip', ['-o', 'link', 'show'], { encoding: 'utf8' }))
  } catch {
    return [] // no `ip`, not Linux → nothing to reclaim
  }
}

/** Parse `ip -o link show` output. Split out from {@link existingTaps} to test. */
export function parseTapLinks(txt: string): HostTap[] {
  const taps: HostTap[] = []
  for (const line of txt.split('\n')) {
    // `7: fctap3: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc ...`
    const m = /^\s*\d+:\s*(fctap(\d+))[:@]/.exec(line)
    if (!m) continue
    const flags = /<([^>]*)>/.exec(line)?.[1]
    taps.push({
      index: parseInt(m[2], 10),
      name: m[1],
      attached: flags ? !flags.split(',').includes('NO-CARRIER') : true,
    })
  }
  return taps
}

/**
 * The integer index `n` behind a `fctap<n>` device name (the same `n` passed to
 * `deriveNet`). Returns null for an unrecognised name. Used to seed the VM index
 * allocator across an agent restart so a freshly-spawned VM never reuses the tap
 * of an adopted / suspended VM (setupTap deletes-then-recreates fctap<n>, which
 * would corrupt a live VM's tap fd).
 */
export function tapIndex(net: VmNet): number | null {
  const m = /^fctap(\d+)$/.exec(net.tap)
  return m ? parseInt(m[1], 10) : null
}

/**
 * The set of `fctap<n>` device indices that CURRENTLY exist on the host (from
 * `ip link`). This is the ground truth for the VM-index allocator that survives
 * a durable-registry wipe: a `runtime.ext4` rebuild (or any out-of-band reset of
 * the live/cache registries) leaves the adopted Firecracker VMs — and their tap
 * devices — running via systemd `KillMode=process`, but the registry no longer
 * records them. Seeding/allocating past these guarantees a freshly-spawned VM
 * never reuses a live device even when the registry can't tell us it exists.
 *
 * Prod incident this guards: after a restart+rootfs-rebuild the counter reset to
 * 0, fresh warm VMs collided with survivor/resumed taps at low indices, and
 * setupTap's delete-then-recreate blackholed the running guests (duplicate
 * 172.16.0.x mesh IPs, dead guests, agent-proxy/preview 502s). Best-effort:
 * returns an empty set if `ip` is unavailable or none are present.
 */
export function existingTapIndices(): Set<number> {
  const out = new Set<number>()
  try {
    const txt = execFileSync('ip', ['-o', 'link', 'show'], { encoding: 'utf8' })
    for (const m of txt.matchAll(/\bfctap(\d+)\b/g)) out.add(parseInt(m[1], 10))
  } catch {
    /* no `ip`, not Linux, or none present → empty (allocator falls back to counter) */
  }
  return out
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
