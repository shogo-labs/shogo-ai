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
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

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
  /**
   * projectId→port/guestIp map persisted to disk. The kernel keeps the DNAT
   * rules across a node-agent restart, but this in-memory map (which port serves
   * which project) is lost — so on restart we could hand a live project a NEW
   * port (breaking the URL the control plane holds) or fail to clean its rules
   * on suspend. Persisting + reloading keeps forwards stable so adopted VMs keep
   * their exact public URL.
   */
  private readonly stateFile: string

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
    this.stateFile = join(cfg.runDir, 'port-forward.json')
    if (this.enabled) this.load()
  }

  private load(): void {
    try {
      const entries = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Array<{
        projectId: string
        port: number
        guestIp: string
      }>
      for (const e of entries) {
        if (!e || typeof e.port !== 'number' || !e.guestIp || !e.projectId) continue
        this.byProject.set(e.projectId, { port: e.port, guestIp: e.guestIp })
        this.used.add(e.port)
      }
    } catch {
      /* no prior state (fresh host / first boot) */
    }
  }

  private save(): void {
    try {
      const entries = [...this.byProject.entries()].map(([projectId, f]) => ({
        projectId,
        port: f.port,
        guestIp: f.guestIp,
      }))
      writeFileSync(this.stateFile, JSON.stringify(entries))
    } catch {
      /* best-effort persistence */
    }
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

    this.installRules(port, guestIp)
    this.byProject.set(projectId, { port, guestIp })
    this.save()
    return this.urlFor(port)
  }

  /** Install (idempotently) the DNAT/MASQUERADE/FORWARD rules for a forward. */
  private installRules(port: number, guestIp: string): void {
    // Converge: drop any PREROUTING DNAT for this port pointing at a DIFFERENT
    // guest. Such shadows arise when a prior instance was SIGKILLed (no cleanup)
    // or a guest IP changed without teardown; because iptables is first-match,
    // a stale rule ordered ahead of ours would silently misroute the port to a
    // dead guest — exactly the failure that undermines adopt-on-restart.
    this.purgeStalePre(port, guestIp)
    for (const src of this.sources) {
      const r = this.ruleArgs(port, guestIp, src)
      tryIptables(['-t', 'nat', '-D', 'PREROUTING', ...this.tail(r.pre)])
      iptables(['-t', 'nat', '-A', 'PREROUTING', ...this.tail(r.pre)])
      tryIptables(['-t', 'nat', '-D', 'POSTROUTING', ...this.tail(r.post)])
      iptables(['-t', 'nat', '-A', 'POSTROUTING', ...this.tail(r.post)])
      tryIptables(['-D', ...r.fwd])
      iptables(['-I', ...r.fwd])
    }
  }

  /** Delete every PREROUTING DNAT for `port` whose destination is not guestIp. */
  private purgeStalePre(port: number, guestIp: string): void {
    let out = ''
    try {
      out = execFileSync('iptables', ['-t', 'nat', '-S', 'PREROUTING'], { encoding: 'utf8' })
    } catch {
      return
    }
    const want = `--to-destination ${guestIp}:${this.guestPort}`
    for (const line of out.split('\n')) {
      if (!line.startsWith('-A PREROUTING ')) continue
      if (!new RegExp(`--dport ${port}(\\s|$)`).test(line)) continue
      if (!line.includes('-j DNAT')) continue
      if (line.includes(want)) continue // the mapping we intend to keep
      // Rewrite `-A PREROUTING …` → a `-D` delete for the exact rule.
      const args = line.replace(/^-A /, '-D ').trim().split(/\s+/)
      tryIptables(['-t', 'nat', ...args])
    }
  }

  /**
   * Reconcile forwards after an adopt-on-restart. `keep` is the set of
   * projectIds whose VMs were re-adopted: their DNAT rules persisted in the
   * kernel and their port mapping was reloaded from disk, so we re-assert the
   * rules (idempotent; also survives an iptables flush). Forwards for any other
   * project — its VM was not adopted — are torn down. Returns the kept count.
   */
  retainAndReassert(keep: Set<string>): number {
    if (!this.enabled) return 0
    for (const projectId of [...this.byProject.keys()]) {
      if (!keep.has(projectId)) {
        this.remove(projectId)
        continue
      }
      const f = this.byProject.get(projectId)!
      try {
        this.installRules(f.port, f.guestIp)
      } catch (err: any) {
        console.error(`[fwd] reassert failed for ${projectId}:`, err?.message ?? err)
      }
    }
    // Sweep the whole managed port range: delete any DNAT the kernel still holds
    // from a prior instance (SIGKILL / crash left no cleanup) that no live
    // forward accounts for. Without this, a stale rule ordered ahead of the
    // correct one first-matches and misroutes the port to a dead guest.
    this.reconcileKernel()
    this.save()
    return this.byProject.size
  }

  /**
   * Delete every PREROUTING DNAT in our managed port range [base, base+span)
   * whose port→destination does not correspond to a current live forward. Scoped
   * strictly to our range so it can never touch unrelated host rules.
   */
  private reconcileKernel(): void {
    let out = ''
    try {
      out = execFileSync('iptables', ['-t', 'nat', '-S', 'PREROUTING'], { encoding: 'utf8' })
    } catch {
      return
    }
    const desired = new Set<string>()
    for (const f of this.byProject.values()) desired.add(`${f.port}:${f.guestIp}`)
    let purged = 0
    for (const line of out.split('\n')) {
      if (!line.startsWith('-A PREROUTING ') || !line.includes('-j DNAT')) continue
      const portM = line.match(/--dport (\d+)\b/)
      const destM = line.match(/--to-destination ([\d.]+):\d+/)
      if (!portM || !destM) continue
      const port = parseInt(portM[1], 10)
      if (port < this.base || port >= this.base + this.span) continue // not ours
      if (desired.has(`${port}:${destM[1]}`)) continue
      const args = line.replace(/^-A /, '-D ').trim().split(/\s+/)
      tryIptables(['-t', 'nat', ...args])
      purged++
    }
    if (purged) console.log(`[fwd] reconcile: purged ${purged} stale DNAT rule(s) in [${this.base},${this.base + this.span})`)
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
    this.save()
  }

  removeAll(): void {
    for (const id of [...this.byProject.keys()]) this.remove(id)
  }

  private urlFor(port: number): string {
    return `http://${this.publicHost}:${port}`
  }
}
