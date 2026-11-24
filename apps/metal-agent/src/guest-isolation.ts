// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Guest-to-guest isolation on a metal host (SEC-31).
 *
 * Every microVM has its own /30 TAP link to the host, and the host routes
 * between them. Without a rule against it, a tenant's VM can open connections
 * to every other tenant's VM on the box: their runtime, their in-development
 * app server, and an unassigned warm VM's control channel (SEC-30).
 *
 * A guest only ever needs two kinds of traffic: to the host itself (INPUT, the
 * agent's /hydrate-stream) and out through the uplink (FORWARD tap → uplink,
 * set up per tap in net.ts). The host talking to a guest is OUTPUT. So no
 * legitimate flow is forwarded from one TAP to another, and dropping all of
 * them costs nothing.
 *
 * Rules live in a dedicated `SHOGO-GUEST-ISO` chain hooked at the top of
 * FORWARD, for the same reasons as control-firewall.ts: it converges by
 * rebuilding its own contents and never matches somebody else's rule.
 */

import { execFileSync } from 'child_process'

/** Our chain. Owned entirely by this module; safe to flush and rebuild. */
export const ISO_CHAIN = 'SHOGO-GUEST-ISO'

/** Interface wildcard matching every TAP net.ts creates (`fctap<n>`). */
export const TAP_WILDCARD = 'fctap+'

/** The chain's contents, in order. */
export function isolationRules(tapWildcard = TAP_WILDCARD): string[][] {
  return [['-i', tapWildcard, '-o', tapWildcard, '-j', 'DROP']]
}

/** The FORWARD rule that sends guest-originated traffic into our chain. */
export function isolationHookArgs(tapWildcard = TAP_WILDCARD): string[] {
  return ['FORWARD', '-i', tapWildcard, '-j', ISO_CHAIN]
}

type Runner = (args: string[]) => void

const defaultRun: Runner = (args) => {
  execFileSync('iptables', args, { stdio: 'pipe' })
}

export class GuestIsolation {
  constructor(private readonly run: Runner = defaultRun) {}

  private tryRun(args: string[]): void {
    try {
      this.run(args)
    } catch {
      /* idempotent best-effort */
    }
  }

  /** Converge the kernel on the policy. Idempotent. */
  apply(): void {
    this.tryRun(['-N', ISO_CHAIN])
    this.tryRun(['-F', ISO_CHAIN])
    for (const rule of isolationRules()) this.run(['-A', ISO_CHAIN, ...rule])
    const hook = isolationHookArgs()
    this.tryRun(['-D', ...hook])
    this.run(['-I', ...hook])
  }
}
