// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Packet-level access control for the agent's own port.
 *
 * The bearer in auth.ts is the real gate; this is the layer underneath it. The
 * two fail differently, which is the point of having both: a bug in the token
 * path, a host that boots with an empty `/etc/metal-agent.env`, or a route
 * added without thinking about auth are all still just a dropped SYN here.
 *
 * Rules live in a dedicated `SHOGO-CTRL` chain rather than being appended to
 * INPUT. INPUT on these hosts already carries Docker's rules and whatever
 * port-forward.ts is doing, so owning a private chain means this converges by
 * rebuilding its own contents and can be removed cleanly, without a filter
 * matching somebody else's rule by accident.
 *
 * Off unless an allowlist is configured. Defaulting to closed would brick a
 * host whose env file predates this feature — and the agent that would need to
 * fix it is the one behind the firewall.
 */

import { execFileSync } from 'child_process'

import { config } from './config'

/** Our chain. Owned entirely by this module; safe to flush and rebuild. */
export const CHAIN = 'SHOGO-CTRL'

export interface ControlFirewallSpec {
  /** The agent's listen port. */
  port: number
  /** Control-plane egress CIDRs allowed to reach it. */
  allow: string[]
  /** The guest TAP supernet, which must always be allowed. */
  guestCidr: string
}

/**
 * The chain's contents, in order. Pure, because ordering is the part that
 * causes outages: iptables is first-match, so a `DROP` in the wrong place
 * silently severs the control plane or every cold boot on the host.
 */
export function chainRules(spec: ControlFirewallSpec): string[][] {
  const rules: string[][] = []

  // Anti-spoof first. auth.ts exempts loopback from the bearer, which is only
  // sound if a loopback source cannot be asserted from off-box. Linux drops
  // such martians by default; this makes it explicit rather than inherited,
  // because the exemption's safety should not depend on a sysctl nobody on
  // this team set.
  rules.push(['!', '-i', 'lo', '-s', '127.0.0.0/8', '-j', 'DROP'])
  rules.push(['-i', 'lo', '-j', 'ACCEPT'])

  // Guests pulling their own archive over the tap link (/hydrate-stream). Not
  // configurable and not omittable: dropping this breaks every cold boot on
  // the host, and it is the single easiest thing to forget when writing an
  // allowlist by hand.
  rules.push(['-s', spec.guestCidr, '-j', 'ACCEPT'])

  for (const cidr of spec.allow) rules.push(['-s', cidr, '-j', 'ACCEPT'])

  // Everything else. Established flows never reach here — this chain is only
  // entered for new connections to the agent port.
  rules.push(['-j', 'DROP'])
  return rules
}

/** The INPUT rule that sends traffic for the agent port into our chain. */
export function hookArgs(port: number): string[] {
  return ['INPUT', '-p', 'tcp', '--dport', String(port), '-j', CHAIN]
}

function run(args: string[]): void {
  execFileSync('iptables', args, { stdio: 'pipe' })
}
function tryRun(args: string[]): void {
  try {
    run(args)
  } catch {
    /* idempotent best-effort */
  }
}

export class ControlFirewall {
  readonly enabled: boolean
  private readonly spec: ControlFirewallSpec

  constructor(cfg = config) {
    const allow = cfg.ctrlAllowCidr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    this.enabled = allow.length > 0
    this.spec = {
      port: cfg.listenPort,
      allow,
      // Derived from the same base the TAP allocator uses, so the two cannot
      // drift into a config where guests exist outside the allowed range.
      guestCidr: `${cfg.tapCidrBase}/12`,
    }
  }

  /** Human-readable summary for the startup log. */
  describe(): string {
    return this.enabled
      ? `port=${this.spec.port} allow=[${this.spec.allow.join(', ')}] guests=${this.spec.guestCidr}`
      : 'off (no METAL_CTRL_ALLOW_CIDR)'
  }

  /**
   * Converge the kernel on the configured policy. Idempotent: rebuilds the
   * chain from scratch, so a changed allowlist takes effect on restart and a
   * partially-applied previous run cannot leave a stale ACCEPT behind.
   *
   * When disabled this REMOVES any rules a previous run installed, which is the
   * rollback path: clear `METAL_CTRL_ALLOW_CIDR`, restart, and the host is
   * reachable again without hand-editing iptables.
   */
  apply(): void {
    if (!this.enabled) {
      this.remove()
      return
    }
    tryRun(['-N', CHAIN])
    // Flush before filling. The gap is briefly permissive (an empty user chain
    // RETURNs to INPUT) rather than briefly closed, which is the right way to
    // fail while reconverging: a dropped control-plane call during a restart
    // would be indistinguishable from the host being down.
    tryRun(['-F', CHAIN])
    for (const rule of chainRules(this.spec)) run(['-A', CHAIN, ...rule])

    // Hook it exactly once, at the top of INPUT so a permissive rule already in
    // INPUT cannot accept the packet before we see it.
    const hook = hookArgs(this.spec.port)
    tryRun(['-D', ...hook])
    run(['-I', ...hook])
  }

  /** Detach and delete the chain. Safe to call when nothing is installed. */
  remove(): void {
    tryRun(['-D', ...hookArgs(this.spec.port)])
    tryRun(['-F', CHAIN])
    tryRun(['-X', CHAIN])
  }
}
