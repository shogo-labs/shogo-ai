// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Acceptance tests for SHO-592 §4 — the *wiring*, not the reconcile loop.
 *
 * `node-disk-taint.test.ts` runs the real script against a stub kubectl, but it
 * hands the script `STATE_DIR` on the command line and relies on the script's
 * own 80/75 defaults. That means it cannot see the two ways this feature dies
 * silently in production:
 *
 *   1. **The sidecar reads a different file than the GC container writes.** The
 *      GC container `chroot`s into `/host`, so its `/run/...` is the host's
 *      `/run/...` with the pod's `state` emptyDir mounted on top of it — while
 *      the sidecar sees that same emptyDir at a plain mountPath. Move one mount
 *      and the script finds no reading, logs "no disk reading yet" every 60 s
 *      forever, and nothing ever taints a node. Both containers stay perfectly
 *      healthy, so nothing else notices.
 *   2. **The thresholds drift apart.** The entire premise is that the taint
 *      starts exactly where the deploy gate stops (`TAINT_PCT` == the gate's
 *      80) and releases below it (75). A manifest that sets 85 would recreate
 *      the 80-85% dead zone with a green test suite, because the script's own
 *      default only applies when the manifest says nothing. SHO-423's missed
 *      list is the same failure shape: a comment said "keep in sync".
 *
 * So these read the shipped manifest and the shipped scripts, and assert the
 * values and paths agree with each other — not with a literal in this file.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

const MANIFEST = 'k8s/base/node-image-gc.yaml'
const GC_SCRIPT = 'scripts/node-image-gc.sh'
const TAINT_SCRIPT = 'scripts/node-disk-taint.sh'
const GATE = '.github/scripts/check-node-disk-headroom.sh'
const WORKFLOWS = ['.github/workflows/deploy.yml', '.github/workflows/deploy-staging.yml']

interface K8sObject {
  kind?: string
  metadata?: { name?: string; namespace?: string }
  spec?: any
  [k: string]: any
}

const objects = (): K8sObject[] =>
  parseAllDocuments(read(MANIFEST))
    .map((d) => d.toJSON() as K8sObject)
    .filter((d) => d && d.kind)

const byKind = (kind: string): K8sObject => {
  const found = objects().filter((o) => o.kind === kind)
  expect(found, `${MANIFEST} must carry exactly one ${kind}`).toHaveLength(1)
  return found[0]
}

const podSpec = () => byKind('DaemonSet').spec.template.spec
const container = (name: string) => {
  const c = (podSpec().containers ?? []).find((x: any) => x.name === name)
  expect(c, `the DaemonSet must run a "${name}" container`).toBeDefined()
  return c
}
const envOf = (c: any, name: string): string | undefined =>
  (c.env ?? []).find((e: any) => e.name === name)?.value

/**
 * The default a shell script assigns to `VAR`, so the assertions compare the
 * DaemonSet against what the script would do on its own — and a change to
 * either side shows up here instead of only in production.
 */
function scriptDefault(rel: string, name: string): string {
  const m = read(rel).match(new RegExp(`${name}="\\$\\{${name}:-([^}"]+)\\}?"`))
  if (!m) throw new Error(`no default for ${name} in ${rel}`)
  return m[1]
}

/** The deploy gate's own threshold, as it defaults when the caller passes nothing. */
function gateThreshold(): string {
  const m = read(GATE).match(/THRESHOLD_PCT="\$\{1:-\$\{THRESHOLD_PCT:-(\d+)\}\}"/)
  if (!m) throw new Error(`could not find the THRESHOLD_PCT default in ${GATE}`)
  return m[1]
}

describe('SHO-592 §4 — the taint starts exactly where the deploy gate stops', () => {
  it('the manifest taints at the gate threshold, and the script agrees', () => {
    const gate = gateThreshold()
    expect(envOf(container('disk-taint'), 'TAINT_PCT')).toBe(gate)
    expect(scriptDefault(TAINT_SCRIPT, 'TAINT_PCT')).toBe(gate)
  })

  it('both thresholds are the same number in the manifest and in the script', () => {
    const taint = container('disk-taint')
    expect(envOf(taint, 'UNTAINT_PCT')).toBe(scriptDefault(TAINT_SCRIPT, 'UNTAINT_PCT'))
    expect(envOf(taint, 'TAINT_PCT')).toBe(scriptDefault(TAINT_SCRIPT, 'TAINT_PCT'))
  })

  it('the release threshold is strictly below the taint threshold — the hysteresis is real', () => {
    // Setting both to the same number would taint and untaint a node that is
    // hovering on one value, which flaps the scheduler on every pass.
    const taint = Number(envOf(container('disk-taint'), 'TAINT_PCT'))
    const untaint = Number(envOf(container('disk-taint'), 'UNTAINT_PCT'))
    expect(Number.isInteger(taint)).toBe(true)
    expect(Number.isInteger(untaint)).toBe(true)
    expect(untaint).toBeLessThan(taint)
  })

  it('the taint fires before the kubelet evicts, with room for a stopped-GC node', () => {
    // The kubelet's own eviction line is 85: a taint at or above it adds
    // nothing, and the whole card exists because 80-85 had no guard at all.
    expect(Number(envOf(container('disk-taint'), 'TAINT_PCT'))).toBeLessThan(85)
  })
})

describe('SHO-592 §4 — the sidecar reads the file the GC container actually writes', () => {
  const mountPath = (c: any, volume: string): string => {
    const m = (c.volumeMounts ?? []).find((v: any) => v.name === volume)
    expect(m, `container ${c.name} must mount the ${volume} volume`).toBeDefined()
    return m.mountPath
  }

  it('both containers mount the same state volume', () => {
    const gc = container('gc')
    const taint = container('disk-taint')
    expect(mountPath(gc, 'state')).toBeDefined()
    expect(mountPath(taint, 'state')).toBeDefined()
    const vols = podSpec().volumes ?? []
    expect(vols.find((v: any) => v.name === 'state')).toBeDefined()
  })

  it('the GC container writes into the chrooted path the script uses', () => {
    // The GC container runs `chroot /host <script>`, so the script's absolute
    // STATE_DIR resolves INSIDE /host. Its state mount is at
    // /host<STATE_DIR> — strip the /host prefix and you have the path the
    // script sees, which is also the emptyDir the sidecar shares.
    const gc = container('gc')
    const mount = mountPath(gc, 'state')
    expect(mount.startsWith('/host/')).toBe(true)
    const chrootView = mount.slice('/host'.length)
    expect(scriptDefault(GC_SCRIPT, 'STATE_DIR')).toBe(chrootView)
  })

  it("the sidecar's own STATE_DIR is where the shared emptyDir lands for it", () => {
    const taint = container('disk-taint')
    expect(envOf(taint, 'STATE_DIR')).toBe(mountPath(taint, 'state'))
    expect(scriptDefault(TAINT_SCRIPT, 'STATE_DIR')).toBe(mountPath(taint, 'state'))
  })

  it('the two containers therefore agree on the status file', () => {
    const gc = container('gc')
    const taint = container('disk-taint')
    // Compare the MOUNTS, not STATE_DIR: if the sidecar's env points at a path
    // it does not mount the emptyDir on, the script silently reads nothing and
    // never taints — the exact silent death this file exists to catch.
    const gcSees = mountPath(gc, 'state').slice('/host'.length)
    const taintSees = mountPath(taint, 'state')
    expect(`${gcSees}/disk-status`).toBe(`${taintSees}/disk-status`)
  })

  it('the GC script and the taint script name the same status file', () => {
    // One writes `disk-status`, the other reads `disk-status`; a rename in one
    // file must not silently orphan the other.
    for (const file of [GC_SCRIPT, TAINT_SCRIPT]) {
      expect(read(file), file).toContain('disk-status')
    }
  })
})

describe('SHO-592 §4 — the sidecar is delivered and authorised', () => {
  it('runs as the ServiceAccount the ClusterRoleBinding grants', () => {
    const sa = byKind('ServiceAccount')
    const crb = byKind('ClusterRoleBinding')
    expect(sa.metadata?.namespace).toBe(byKind('DaemonSet').metadata?.namespace)
    expect(podSpec().serviceAccountName).toBe(sa.metadata?.name)
    expect(crb.subjects?.[0]?.kind).toBe('ServiceAccount')
    expect(crb.subjects?.[0]?.name).toBe(sa.metadata?.name)
    expect(crb.subjects?.[0]?.namespace).toBe(sa.metadata?.namespace)
    expect(crb.roleRef?.kind).toBe('ClusterRole')
    expect(crb.roleRef?.name).toBe(byKind('ClusterRole').metadata?.name)
  })

  it('grants exactly nodes get + patch — no pods, no nodes/status', () => {
    const rules = byKind('ClusterRole').rules ?? []
    expect(rules).toHaveLength(1)
    expect(rules[0].apiGroups).toEqual([''])
    expect(rules[0].resources).toEqual(['nodes'])
    expect([...rules[0].verbs].sort()).toEqual(['get', 'patch'])
  })

  it('every deploy block that ships the ConfigMap also ships the sidecar script', () => {
    const command = container('disk-taint').command as string[]
    expect(Array.isArray(command)).toBe(true)
    const key = basename(command[command.length - 1])
    expect(existsSync(join(REPO_ROOT, TAINT_SCRIPT))).toBe(true)

    for (const wf of WORKFLOWS) {
      const text = read(wf)
      const keys = [...text.matchAll(/--from-file=([^=\s]+)=([^\s\\]+)/g)].map((m) => ({
        key: m[1],
        src: m[2],
      }))
      const forGc = keys.filter((k) => k.key === 'node-image-gc.sh')
      // Every block with a node-image-gc ConfigMap must carry the sidecar too,
      // or the sidecar CrashLoops on a file that is not in the volume.
      expect(forGc.length, `${wf} must create the node-image-gc ConfigMap`).toBeGreaterThan(0)
      for (const k of keys.filter((k) => k.key === 'node-image-gc.sh')) {
        expect(
          keys.some((o) => o.key === key),
          `${wf} ships node-image-gc.sh without ${key}`,
        ).toBe(true)
        expect(existsSync(join(REPO_ROOT, k.src)), `${wf} names a missing ${k.src}`).toBe(true)
      }
      // And the checksum must cover both, or a sidecar-only change never rolls.
      const sumMatches = [...text.matchAll(/sha256sum ([^\n|]+)\| sha256sum/g)].map((m) => m[1])
      expect(sumMatches.length, `${wf} must hash the shipped scripts`).toBeGreaterThan(0)
      for (const listed of sumMatches) expect(listed).toContain(TAINT_SCRIPT)
    }
  })

  it('the sidecar tolerates the taint it applies, so it can remove it again', () => {
    // A NoSchedule taint on a node whose only copy of the remover cannot be
    // scheduled there is a one-way door.
    const tolerations = podSpec().tolerations ?? []
    expect(tolerations.some((t: any) => t.operator === 'Exists' && !t.key)).toBe(true)
  })
})
