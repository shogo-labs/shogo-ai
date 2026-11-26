// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage for `scripts/node-disk-taint.sh` — the DaemonSet sidecar that holds
 * `shogo.ai/disk-high=true:NoSchedule` on a node between the deploy gate (80%)
 * and the kubelet's own eviction taint (85%), so the scheduler cannot pile
 * pods onto a node that is about to evict them (SHO-592 §4).
 *
 * 2026-11-26: pods evicted from 10.0.10.5 were rescheduled onto 10.0.10.184 at
 * 75%, pushing it to 84% and then over the line — 36 pods across 21 published
 * apps. Nothing in the cluster refused a placement between 80% and 85%.
 *
 * These tests run the REAL script against a stub `kubectl` that records every
 * call, so what is asserted is what the sidecar executes. The manifest half of
 * the same describe checks the properties that make the taint safe: DaemonSets
 * still run on a tainted node, and neither the deploy gate nor warm-pool-monitor
 * treats the taint as "ignore this node" the way they treat a cordon.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'node-disk-taint.sh')
const SCRIPT_CONTENT = readFileSync(SCRIPT, 'utf8')

const WORK = mkdtempSync(join(tmpdir(), 'node-disk-taint-'))
const BIN = join(WORK, 'bin')
const STATE = join(WORK, 'state')
const KUBECTL_LOG = join(WORK, 'kubectl.log')
const TAINTED_FLAG = join(WORK, 'tainted')

const NODE = '10.0.10.184'
const TAINT = 'shogo.ai/disk-high'

interface RunOpts {
  /** used% the GC pass reported. `null` = no status file at all. */
  pct?: number | null
  /** How old the reading is, in seconds. Default 0 (just written). */
  ageS?: number
  /** Omit the `epoch=` line entirely, as an older/partial writer would. */
  noEpoch?: boolean
  /** Does the node already carry the taint? */
  tainted?: boolean
  env?: Record<string, string>
}

function run(opts: RunOpts = {}): { status: number; stdout: string; calls: string[] } {
  const pct = opts.pct === undefined ? 82 : opts.pct
  const ageS = opts.ageS ?? 0
  rmSync(STATE, { recursive: true, force: true })
  mkdirSync(STATE, { recursive: true })
  if (pct !== null) {
    const epoch = opts.noEpoch ? '' : `epoch=${Math.floor(Date.now() / 1000) - ageS}\n`
    writeFileSync(join(STATE, 'disk-status'), `pct=${pct}\n${epoch}ts=2026-11-26T04:20:00Z\n`)
  }
  if (opts.tainted) writeFileSync(TAINTED_FLAG, '')
  else rmSync(TAINTED_FLAG, { force: true })
  writeFileSync(KUBECTL_LOG, '')

  const result = spawnSync('sh', [SCRIPT], {
    encoding: 'utf-8',
    env: {
      PATH: `${BIN}:${process.env.PATH ?? ''}`,
      NODE_NAME: NODE,
      STATE_DIR: STATE,
      ONESHOT: '1',
      INTERVAL_S: '0',
      ...opts.env,
    },
  })
  const calls = readFileSync(KUBECTL_LOG, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return { status: result.status ?? -1, stdout: result.stdout ?? '', calls }
}

const mutations = (calls: string[]) => calls.filter((c) => c.startsWith('taint '))

beforeEach(() => {
  rmSync(BIN, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  // Stub kubectl: `get node` renders the taints the fixture says the node has;
  // `taint` is recorded and always succeeds.
  writeFileSync(
    join(BIN, 'kubectl'),
    `#!/bin/sh
echo "$*" >> "${KUBECTL_LOG}"
case "$1" in
  get)
    if [ -f "${TAINTED_FLAG}" ]; then
      echo "${TAINT}=true:NoSchedule"
    fi
    exit 0 ;;
  taint) exit 0 ;;
  *) echo "stub kubectl: unexpected args: $*" >&2; exit 2 ;;
esac
`,
  )
  chmodSync(join(BIN, 'kubectl'), 0o755)
})

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true })
})

describe('node-disk-taint — hold the 80-85% band shut', () => {
  it('taints a node at or above TAINT_PCT', () => {
    const { status, calls, stdout } = run({ pct: 80, tainted: false })
    expect(status).toBe(0)
    expect(mutations(calls)).toEqual([`taint nodes ${NODE} ${TAINT}=true:NoSchedule --overwrite`])
    expect(stdout).toContain('tainted')
  })

  it('taints well above the threshold too (the .184 case, 84%)', () => {
    const { calls } = run({ pct: 84, tainted: false })
    expect(mutations(calls)).toHaveLength(1)
  })

  it('does not touch an already-tainted node — no write per tick', () => {
    const { status, calls } = run({ pct: 90, tainted: true })
    expect(status).toBe(0)
    expect(mutations(calls)).toEqual([])
  })

  it('leaves the node exactly as it is between UNTAINT_PCT and TAINT_PCT', () => {
    // Hysteresis: this is what stops a node hovering on one number from
    // tainting/untaunting on every pass.
    for (const tainted of [true, false]) {
      const { status, calls } = run({ pct: 77, tainted })
      expect(status).toBe(0)
      expect(mutations(calls)).toEqual([])
    }
  })

  it('untaints below UNTAINT_PCT', () => {
    const { calls, stdout } = run({ pct: 74, tainted: true })
    expect(mutations(calls)).toEqual([`taint nodes ${NODE} ${TAINT}:NoSchedule-`])
    expect(stdout).toContain('removed')
  })

  it('does not remove a taint that is not there', () => {
    const { calls } = run({ pct: 20, tainted: false })
    expect(mutations(calls)).toEqual([])
  })

  it('makes no calls at all in dry-run mode, even on a full node', () => {
    const { status, calls, stdout } = run({ pct: 95, tainted: false, env: { DRY_RUN: '1' } })
    expect(status).toBe(0)
    expect(mutations(calls)).toEqual([])
    expect(stdout).toContain('would taint')
  })

  it('does nothing until the GC pass has published a reading', () => {
    // A fresh pod must not guess: tainting a healthy node on startup would be
    // worse than the gap this closes.
    const { status, calls } = run({ pct: null })
    expect(status).toBe(0)
    expect(calls).toEqual([])
  })

  it('ignores an unreadable reading instead of crashing the sidecar', () => {
    const { status, stdout } = run({ pct: null })
    expect(status).toBe(0)
    expect(stdout).toContain('no disk reading yet')
  })

  it('does not act on a reading older than MAX_READING_AGE_S', () => {
    // The gc container CrashLoopBackOff'd: its last reading is hours old, and
    // the node has moved on. Tainting or untainting from that number would be
    // acting on a measurement nobody took.
    const { status, stdout, calls } = run({ pct: 91, tainted: false, ageS: 4000 })
    expect(status).toBe(0)
    expect(mutations(calls)).toEqual([])
    expect(stdout).toContain('not publishing')
  })

  it('does not REMOVE a taint from a stale reading either', () => {
    // The dangerous direction: a stale 40% would untaint a node that has since
    // refilled, and the scheduler would start placing pods there again.
    const { status, calls } = run({ pct: 40, tainted: true, ageS: 4000 })
    expect(status).toBe(0)
    expect(calls).toEqual([])
  })

  it('treats a reading with no epoch as stale rather than acting blind', () => {
    const { status, stdout, calls } = run({ pct: 91, tainted: false, noEpoch: true })
    expect(status).toBe(0)
    expect(mutations(calls)).toEqual([])
    expect(stdout).toContain('unknown age')
  })

  it('still acts on a reading inside the freshness window', () => {
    const { calls } = run({ pct: 91, tainted: false, ageS: 1200 })
    expect(mutations(calls)).toHaveLength(1)
  })

  it('MAX_READING_AGE_S=0 disables the freshness check', () => {
    const { calls } = run({ pct: 91, tainted: false, ageS: 999_999, env: { MAX_READING_AGE_S: '0' } })
    expect(mutations(calls)).toHaveLength(1)
  })
})

describe('a tainted node stays visible and keeps its DaemonSets (SHO-592 §4)', () => {
  const REPO = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8')

  it('every node DaemonSet tolerates the taint, so none of them stops running', () => {
    for (const manifest of [
      'k8s/base/node-image-gc.yaml',
      'k8s/base/image-prepuller.yaml',
      'k8s/base/inotify-tuner.yaml',
      'k8s/base/oci-growfs.yaml',
    ]) {
      expect(REPO(manifest), manifest).toContain('operator: Exists')
    }
    // The log collector is the SigNoz chart's DaemonSet; the module sets the
    // same blanket toleration, so a tainted node keeps shipping logs.
    expect(REPO('terraform/modules/signoz/main.tf')).toContain('otelAgent.tolerations[0].operator')
    expect(REPO('terraform/modules/signoz/main.tf')).toContain('Exists')
  })

  it('ships the ServiceAccount and only nodes get/patch', () => {
    const manifest = REPO('k8s/base/node-image-gc.yaml')
    expect(manifest).toContain('kind: ServiceAccount')
    expect(manifest).toContain('serviceAccountName: node-image-gc')
    expect(manifest).toContain('kind: ClusterRole\n')
    expect(manifest).toContain('resources: ["nodes"]\n    verbs: ["get", "patch"]')
    // Nothing on pods, nodes/status or anything writable else.
    expect(manifest).not.toContain('"nodes/status"')
    expect(manifest).not.toContain('"pods"')
  })

  it('the deploy gate still fails on a tainted node (only a cordon exempts one)', () => {
    const gate = REPO('.github/scripts/check-node-disk-headroom.sh')
    // The only exemption in the node loop is `spec.unschedulable`.
    expect(gate).toContain('select(.spec.unschedulable != true)')
    expect(gate).toContain('shogo.ai/disk-high')
    // And it must never grow a taint-based skip.
    expect(gate).not.toMatch(/select\([^)]*disk-high[^)]*(!=|==)\s*null/)
  })

  it('warm-pool-monitor reports the taint but never treats it as a cordon', () => {
    const monitor = REPO('k8s/base/warm-pool-monitor.yaml')
    expect(monitor).toContain('shogo.ai/disk-high')
    expect(monitor).toContain('disk-high taint — scheduling blocked')
    // The cordon exemption is still keyed on `spec.unschedulable` only.
    expect(monitor).toContain('(.spec.unschedulable // false)')
    // Paging at 78% is unchanged for a tainted node: the CRITICAL branch is
    // still gated on CORDONED, never on the taint.
    const crit = monitor.slice(monitor.indexOf('DISK_CRIT_PCT:-78'))
    expect(crit).toContain('if [ "$CORDONED" = "true" ]')
    expect(crit).not.toContain('if [ "$TAINTED"')
  })

  it('the sidecar is a separate container, because the GC container has no kubectl', () => {
    const manifest = REPO('k8s/base/node-image-gc.yaml')
    expect(manifest).toContain('- name: disk-taint')
    expect(manifest).toContain('/run/shogo-node-image-gc/node-disk-taint.sh')
    expect(existsSync(SCRIPT)).toBe(true)
    // The script must be in the ConfigMap the deploy builds, or the sidecar
    // CrashLoops on a missing file.
    for (const wf of ['.github/workflows/deploy.yml', '.github/workflows/deploy-staging.yml']) {
      expect(REPO(wf), wf).toContain('--from-file=node-disk-taint.sh=scripts/node-disk-taint.sh')
    }
  })

  it('the manifest and the writer agree on how a reading is aged', () => {
    const manifest = REPO('k8s/base/node-image-gc.yaml')
    // Without MAX_READING_AGE_S in the pod the sidecar falls back to its own
    // default, and a stale reading from a dead gc container would be trusted.
    expect(manifest).toMatch(/- name: MAX_READING_AGE_S\n\s+value: "1800"/)
    // The freshness check is only meaningful if the gc pass stamps `epoch=`.
    expect(REPO('scripts/node-image-gc.sh')).toContain("epoch=%s")
    expect(SCRIPT_CONTENT).toContain('sed -n \'s/^epoch=//p\'')
  })
})
