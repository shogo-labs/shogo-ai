// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage for the node checks in `k8s/base/warm-pool-monitor.yaml` (SHO-233).
 *
 * The monitor is a shell script embedded in a CronJob manifest, so it is tested
 * the way it runs: the script is extracted from the YAML (never copied) and
 * executed against a stub `kubectl` serving fixtures. That way a change to the
 * manifest is what the assertions see.
 *
 * What must hold:
 *   * a schedulable node at/above DISK_CRIT_PCT (78) pages — the deploy gate
 *     fails at 80% and nothing reclaims 80-85%, so the page has to come first;
 *   * a schedulable node holding more than MAX_RUNTIME_DIGESTS (4) runtime
 *     digests pages — that means `node-image-gc` is not reclaiming;
 *   * a cordoned node is reported but never pages, however bad it looks: it is
 *     drained on purpose and the deploy gate skips it.
 */
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const MANIFEST = join(REPO_ROOT, 'k8s', 'base', 'warm-pool-monitor.yaml')
const MANIFEST_TEXT = readFileSync(MANIFEST, 'utf8')

/** The monitor's inline shell, dedented out of the CronJob manifest. */
function monitorScript(): string {
  const lines = MANIFEST_TEXT.split('\n')
  const start = lines.findIndex((l) => /^\s*- \|\s*$/.test(l))
  if (start < 0) throw new Error('no `- |` block scalar in warm-pool-monitor.yaml')
  const markerIndent = lines[start].length - lines[start].trimStart().length
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (line.length - line.trimStart().length <= markerIndent) break
    body.push(line)
  }
  const contentIndent = Math.min(
    ...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  )
  return body.map((l) => (l.trim() ? l.slice(contentIndent) : '')).join('\n')
}

const SCRIPT = monitorScript()

interface NodeFixture {
  name: string
  /** Live nodefs/imagefs used%, as the kubelet stats summary reports it. */
  pct: number
  cordoned?: boolean
  runtimeDigests?: number
}

const OLD = '2026-01-01T00:00:00Z'

function nodeObject(node: NodeFixture) {
  const images = []
  for (let i = 0; i < (node.runtimeDigests ?? 0); i++) {
    images.push({
      names: [
        `us-ashburn-1.ocir.io/idin4oltblww/shogo/shogo-runtime@sha256:${String(i).padStart(2, '0').repeat(32)}`,
      ],
      sizeBytes: 10_000_000_000,
    })
  }
  // Non-runtime images must never be counted by check 4c.
  images.push({
    names: [`ghcr.io/cloudnative-pg/pgbouncer@sha256:${'ab'.repeat(32)}`],
    sizeBytes: 173_000_000,
  })
  return {
    metadata: { name: node.name },
    spec: node.cordoned ? { unschedulable: true } : {},
    status: {
      conditions: [{ type: 'DiskPressure', status: 'False' }],
      images,
    },
  }
}

function summaryObject(pct: number) {
  return {
    node: {
      fs: { usedBytes: pct * 10, capacityBytes: 1000 },
      runtime: { imageFs: { usedBytes: pct * 10, capacityBytes: 1000 } },
    },
  }
}

interface RunResult {
  status: number
  output: string
}

function run(nodes: NodeFixture[]): RunResult {
  const work = mkdtempSync(join(tmpdir(), 'wpm-'))
  const bin = join(work, 'bin')
  mkdirSync(bin, { recursive: true })
  try {
    writeFileSync(join(work, 'nodes.json'), JSON.stringify({ items: nodes.map(nodeObject) }))
    for (const node of nodes) {
      writeFileSync(join(work, `summary-${node.name}.json`), JSON.stringify(summaryObject(node.pct)))
    }
    // Everything outside the node checks is healthy, so any failure below is
    // the node checks.
    writeFileSync(
      join(work, 'api-ksvc.json'),
      JSON.stringify({
        spec: { template: { spec: { containers: [{ env: [{ name: 'RUNTIME_IMAGE', value: 'ocir/runtime:1' }] }] } } },
      }),
    )
    writeFileSync(join(work, 'wp-pods.json'), JSON.stringify({ items: [] }))
    writeFileSync(
      join(work, 'wp-ksvc.json'),
      JSON.stringify({
        items: [
          {
            metadata: { creationTimestamp: OLD },
            status: { conditions: [{ type: 'Ready', status: 'True' }] },
          },
        ],
      }),
    )
    writeFileSync(
      join(work, 'studio-pods.json'),
      JSON.stringify({
        items: [
          {
            metadata: { labels: { 'serving.knative.dev/revision': 'studio-00001' } },
            status: { conditions: [{ type: 'Ready', status: 'True' }] },
          },
        ],
      }),
    )
    writeFileSync(join(work, 'revisions.json'), JSON.stringify({ items: [] }))
    writeFileSync(
      join(bin, 'kubectl'),
      `#!/bin/sh
echo "$*" >> "$FIX/calls.log"
case "$*" in
  *--raw*)
    node=$(echo "$3" | sed -e 's|^/api/v1/nodes/||' -e 's|/proxy/stats/summary$||')
    cat "$FIX/summary-$node.json" ;;
  "get ksvc api -n $API_NS -o json") cat "$FIX/api-ksvc.json" ;;
  "get pods -n $WP_NS -o json") cat "$FIX/wp-pods.json" ;;
  "get ksvc -n $WP_NS -l shogo.io/warm-pool=true -o json") cat "$FIX/wp-ksvc.json" ;;
  "get nodes -o json") cat "$FIX/nodes.json" ;;
  "get pods -n $API_NS -l serving.knative.dev/service=studio -o json") cat "$FIX/studio-pods.json" ;;
  *revisions*) cat "$FIX/revisions.json" ;;
  *) echo "stub kubectl: unexpected args: $*" >&2; exit 3 ;;
esac
`,
    )
    chmodSync(join(bin, 'kubectl'), 0o755)

    const result = spawnSync('sh', ['-ec', SCRIPT], {
      encoding: 'utf-8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FIX: work,
        API_NS: 'shogo-staging-system',
        WP_NS: 'shogo-staging-workspaces',
        ROLLOUT_GRACE_MIN: '15',
      },
    })
    return {
      status: result.status ?? -1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

describe('warm-pool-monitor — node disk and image store checks', () => {
  it('is quiet on a healthy cluster', () => {
    const { status, output } = run([{ name: '10.0.0.1', pct: 40, runtimeDigests: 2 }])
    expect(output).toContain('10.0.0.1 40% used')
    expect(output).toContain('10.0.0.1 runtime digests: 2')
    expect(output).not.toContain('CRITICAL')
    expect(status).toBe(0)
  })

  it('pages CRITICAL at 78% on a schedulable node, before the 80% deploy gate', () => {
    const { status, output } = run([{ name: '10.0.0.1', pct: 79, runtimeDigests: 2 }])
    expect(output).toContain('CRITICAL: 10.0.0.1 at 79% disk')
    expect(status).toBe(1)
  })

  it('only warns between 70% and 78%', () => {
    const { status, output } = run([{ name: '10.0.0.1', pct: 72, runtimeDigests: 2 }])
    expect(output).toContain('WARNING: 10.0.0.1 at 72% disk')
    expect(output).not.toContain('CRITICAL')
    expect(status).toBe(0)
  })

  it('pages CRITICAL when a node at RECLAIM_PCT still holds more than MAX_RUNTIME_DIGESTS runtime digests', () => {
    const { status, output } = run([{ name: '10.0.0.1', pct: 70, runtimeDigests: 5 }])
    expect(output).toContain('10.0.0.1 runtime digests: 5')
    expect(output).toContain('CRITICAL: 10.0.0.1 holds 5 runtime digests at 70% disk')
    expect(status).toBe(1)
  })

  it('only warns about digests below RECLAIM_PCT, where node-image-gc leaves the node alone', () => {
    // Staging 10.0.24.140 after the manual prune: 58% with 10 runtime digests.
    // The DaemonSet does nothing there by design, so paging would be a false
    // positive that never clears until the node crosses 65%.
    const { status, output } = run([{ name: '10.0.24.140', pct: 58, runtimeDigests: 10 }])
    expect(output).toContain('WARNING: 10.0.24.140 holds 10 runtime digests (')
    expect(output).toContain('below RECLAIM_PCT (65%)')
    expect(output).not.toContain('CRITICAL')
    expect(status).toBe(0)
  })

  it('does not page for 4 runtime digests — that is what node-image-gc keeps', () => {
    const { status, output } = run([{ name: '10.0.0.1', pct: 70, runtimeDigests: 4 }])
    expect(output).not.toContain('CRITICAL')
    expect(status).toBe(0)
  })

  it('reports but never pages a cordoned node, however bad it looks', () => {
    const { status, output } = run([{ name: '10.0.24.140', pct: 85, cordoned: true, runtimeDigests: 9 }])
    expect(output).toContain('10.0.24.140 85% used (cordoned — not paged)')
    expect(output).toContain('WARNING: 10.0.24.140 at 85% disk — cordoned, not paging')
    expect(output).toContain('WARNING: 10.0.24.140 holds 9 runtime digests — cordoned, not paging')
    expect(output).not.toContain('CRITICAL')
    expect(status).toBe(0)
  })

  it('still pages the healthy-looking node while a drained one sits next to it', () => {
    const { status, output } = run([
      { name: '10.0.24.140', pct: 85, cordoned: true, runtimeDigests: 9 },
      { name: '10.0.27.220', pct: 78, runtimeDigests: 2 },
    ])
    expect(output).toContain('CRITICAL: 10.0.27.220 at 78% disk')
    expect(output).not.toContain('CRITICAL: 10.0.24.140')
    expect(status).toBe(1)
  })

  it('never counts a non-runtime image towards the digest limit', () => {
    const { output } = run([{ name: '10.0.0.1', pct: 40, runtimeDigests: 0 }])
    expect(output).toContain('10.0.0.1 runtime digests: 0')
  })

  it('ships the thresholds the checks are tested against', () => {
    // The env values and the `${VAR:-default}` fallbacks in the script have to
    // agree, or the CronJob pages at a different number than the tests prove.
    const envValue = (name: string) => {
      const hit = MANIFEST_TEXT.match(new RegExp(`- name: ${name}\\n\\s+value: "(\\d+)"`))
      if (!hit) throw new Error(`no ${name} in warm-pool-monitor.yaml`)
      return hit[1]
    }
    expect(envValue('DISK_WARN_PCT')).toBe('70')
    expect(envValue('DISK_CRIT_PCT')).toBe('78')
    expect(envValue('MAX_RUNTIME_DIGESTS')).toBe('4')
    expect(envValue('RECLAIM_PCT')).toBe('65')
    for (const [name, value] of [
      ['DISK_WARN_PCT', '70'],
      ['DISK_CRIT_PCT', '78'],
      ['MAX_RUNTIME_DIGESTS', '4'],
      ['RECLAIM_PCT', '65'],
    ] as const) {
      expect(SCRIPT).toContain(`${name}:-${value}`)
    }
  })

  it('can read the node stats summary it bases those checks on', () => {
    // `/api/v1/nodes/<n>/proxy/stats/summary` is a `nodes/proxy` call: with
    // only `nodes` get/list it 403s, the disk line is skipped, and the 78%
    // page silently never fires.
    expect(MANIFEST_TEXT).toMatch(/resources: \["nodes\/proxy"\]/)
  })
})
