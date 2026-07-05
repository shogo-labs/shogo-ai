// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Public per-VM port-forwarding — the pre-mesh data path.
 *
 * The control plane resolves a project to `http://{meshIp}:{agentPort}/assign`,
 * which returns a runtime URL it then connects to directly. In a real mesh that
 * URL is the private TAP guest IP (172.16.x.x). But when the control plane can
 * only reach this host over the public internet (e.g. OKE VCN-native pods that
 * have internet egress but no route to the TAP subnet), we instead DNAT a host
 * public port to the guest's :guestPort and hand back http://{publicHost}:{port}.
 *
 * Rules per forward (all removed on teardown):
 *   nat  PREROUTING  [-s allow] -p tcp --dport PORT -j DNAT --to guestIp:guestPort
 *   nat  POSTROUTING -p tcp -d guestIp --dport guestPort -j MASQUERADE
 *   filter FORWARD (insert) [-s allow] -p tcp -d guestIp --dport guestPort ACCEPT
 *
 * The FORWARD rule is inserted at the top so it wins over Docker's default-DROP
 * FORWARD policy. Locked to `fwdAllowCidr` (the control-plane egress IP) so the
 * forwarded ports are not open to the public internet.
 */

import { execFileSync } from 'child_process'

import { config } from './config'

interface Forward {
  port: number
  guestIp: string
}

function iptables(args: string[]): void {
  execFileSync('iptables', args, { stdio: 'pipe' })
}
function tryIptables(args: string[]): void {
  try {
    iptables(args)
  } catch {
    /* idempotent best-effort */
  }
}

export class PortForward {
  private byProject = new Map<string, Forward>()
  private used = new Set<number>()
  readonly enabled: boolean
  private readonly base: number
  private readonly span: number
  private readonly guestPort: number
  private readonly publicHost: string
  /** Pre-split allow CIDRs → one rule-set per source (empty = a single any-source ruleset). */
  private readonly sources: (string | null)[]

  constructor(cfg = config) {
    this.publicHost = cfg.publicHost
    this.enabled = !!cfg.publicHost
    this.base = cfg.fwdPortBase
    this.span = cfg.fwdPortSpan
    this.guestPort = cfg.guestPort
    const cidrs = cfg.fwdAllowCidr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    this.sources = cidrs.length ? cidrs : [null]
  }

  private alloc(preferred?: number): number {
    if (preferred !== undefined && !this.used.has(preferred)) {
      this.used.add(preferred)
      return preferred
    }
    for (let p = this.base; p < this.base + this.span; p++) {
      if (!this.used.has(p)) {
        this.used.add(p)
        return p
      }
    }
    throw new Error(`no free forward port in [${this.base},${this.base + this.span})`)
  }

  private ruleArgs(port: number, guestIp: string, src: string | null) {
    const dest = `${guestIp}:${this.guestPort}`
    const s = src ? ['-s', src] : []
    return {
      pre: ['-t', 'nat', 'PREROUTING', ...s, '-p', 'tcp', '--dport', String(port), '-j', 'DNAT', '--to-destination', dest],
      post: ['-t', 'nat', 'POSTROUTING', '-p', 'tcp', '-d', guestIp, '--dport', String(this.guestPort), '-j', 'MASQUERADE'],
      fwd: ['FORWARD', ...s, '-p', 'tcp', '-d', guestIp, '--dport', String(this.guestPort), '-j', 'ACCEPT'],
    }
  }

  /** Install DNAT for a project's guest; returns the public URL to hand back. */
  async ensure(projectId: string, guestIp: string): Promise<string> {
    if (!this.enabled) return `http://${guestIp}:${this.guestPort}`
    const cur = this.byProject.get(projectId)
    if (cur && cur.guestIp === guestIp) return this.urlFor(cur.port)

    const port = cur ? cur.port : this.alloc()
    if (cur && cur.guestIp !== guestIp) this.removeRules(cur.port, cur.guestIp)

    for (const src of this.sources) {
      const r = this.ruleArgs(port, guestIp, src)
      tryIptables(['-t', 'nat', '-D', 'PREROUTING', ...this.tail(r.pre)])
      iptables(['-t', 'nat', '-A', 'PREROUTING', ...this.tail(r.pre)])
      tryIptables(['-t', 'nat', '-D', 'POSTROUTING', ...this.tail(r.post)])
      iptables(['-t', 'nat', '-A', 'POSTROUTING', ...this.tail(r.post)])
      tryIptables(['-D', ...r.fwd])
      iptables(['-I', ...r.fwd])
    }
    this.byProject.set(projectId, { port, guestIp })
    return this.urlFor(port)
  }

  /** Strip a leading ['-t','nat','CHAIN'] / ['CHAIN'] marker to reusable rule args. */
  private tail(rule: string[]): string[] {
    if (rule[0] === '-t') return rule.slice(3) // drop -t nat CHAIN
    return rule.slice(1) // drop CHAIN
  }

  private removeRules(port: number, guestIp: string): void {
    for (const src of this.sources) {
      const r = this.ruleArgs(port, guestIp, src)
      tryIptables(['-t', 'nat', '-D', 'PREROUTING', ...this.tail(r.pre)])
      tryIptables(['-t', 'nat', '-D', 'POSTROUTING', ...this.tail(r.post)])
      tryIptables(['-D', ...r.fwd])
    }
  }

  remove(projectId: string): void {
    const cur = this.byProject.get(projectId)
    if (!cur) return
    this.removeRules(cur.port, cur.guestIp)
    this.used.delete(cur.port)
    this.byProject.delete(projectId)
  }

  removeAll(): void {
    for (const id of [...this.byProject.keys()]) this.remove(id)
  }

  private urlFor(port: number): string {
    return `http://${this.publicHost}:${port}`
  }
}
