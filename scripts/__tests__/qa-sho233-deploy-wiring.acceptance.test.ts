// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Acceptance tests for SHO-233 — the deploy path, not the GC algorithm.
 *
 * `node-image-gc.test.ts` covers what the script *selects*. This file covers
 * whether the thing that selects ever reaches a node, because that is where the
 * card's own failure class lives: SHO-136's kubelet flags never reached a
 * running node (`node_metadata` is in the OKE pool's `ignore_changes`), and the
 * first version of this DaemonSet had the same bug one level up — a changed
 * `node-image-gc.sh` updated the ConfigMap, but the DaemonSet's pod template did
 * not change, so every running pod kept executing the script it had already
 * parsed.
 *
 * So these tests execute the deploy workflow's *actual* `Apply node image GC`
 * step against a stub `kubectl` and assert the sequence of calls it makes:
 * configmap from the single source → apply the manifest → pin the script
 * checksum into the pod template → wait for the rollout — and that all of it
 * happens before the disk gate samples the cluster, in all three environments.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'node-image-gc.sh')
const SCRIPT_TEXT = readFileSync(SCRIPT, 'utf8')
const SCRIPT_SHA = createHash('sha256').update(SCRIPT_TEXT).digest('hex')

const STAGING_WF = join(REPO_ROOT, '.github', 'workflows', 'deploy-staging.yml')
const DEPLOY_WF = join(REPO_ROOT, '.github', 'workflows', 'deploy.yml')
const MONITOR = join(REPO_ROOT, 'k8s', 'base', 'warm-pool-monitor.yaml')
const MANIFEST = join(REPO_ROOT, 'k8s', 'base', 'node-image-gc.yaml')
const RUNBOOK = join(REPO_ROOT, 'docs', 'runbooks', 'node-image-gc.md')
const GATE = join(REPO_ROOT, '.github', 'scripts', 'check-node-disk-headroom.sh')

const WORK = mkdtempSync(join(tmpdir(), 'qa-sho233-'))

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true })
})

/** A YAML step's `run:` script, dedented. */
function runScriptOf(text: string, stepName: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`)
  if (start === -1) throw new Error(`step not found: ${stepName}`)
  const runAt = lines.findIndex((l, i) => i > start && /^\s*run: \|\s*$/.test(l))
  if (runAt === -1) throw new Error(`no run: block in ${stepName}`)
  const indent = lines[runAt].search(/\S/)
  const body: string[] = []
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (line.search(/\S/) <= indent) break
    body.push(line)
  }
  const minIndent = Math.min(
    ...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)),
  )
  return body.map((l) => l.slice(minIndent)).join('\n')
}

interface Call {
  argv: string[]
  patch?: any
}

/**
 * Runs one `Apply node image GC` step exactly as the workflow does — same shell,
 * same commands — with `kubectl` replaced by a recorder, in a directory that
 * holds the two files the step touches.
 */
function runGcStep(wfPath: string): { calls: Call[]; stdout: string; status: number } {
  const dir = mkdtempSync(join(WORK, 'step-'))
  const bin = join(dir, 'bin')
  const log = join(dir, 'calls.jsonl')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'k8s', 'base'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(dir, 'scripts', 'node-image-gc.sh'), SCRIPT_TEXT)
  writeFileSync(join(dir, 'k8s', 'base', 'node-image-gc.yaml'), readFileSync(MANIFEST, 'utf8'))
  writeFileSync(log, '')

  // Records argv; on `patch --patch-file` it also records the JSON it was given,
  // which is the thing that has to carry the checksum.
  writeFileSync(
    join(bin, 'kubectl'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *"create configmap"*) echo "apiVersion: v1"; echo "kind: ConfigMap"; echo "metadata:"; echo "  name: node-image-gc" ;;
  *"apply -f -"*) cat > /dev/null ;;
esac
case "$*" in
  *--patch-file*)
    for a in "$@"; do case "$prev" in --patch-file) cat "$a" > "${log}.patch" ;; esac; prev="$a"; done ;;
esac
exit 0
`,
  )
  chmodSync(join(bin, 'kubectl'), 0o755)

  const script = runScriptOf(readFileSync(wfPath, 'utf8'), 'Apply node image GC')
  writeFileSync(join(dir, 'step.sh'), script)
  const proc = Bun.spawnSync(['bash', join(dir, 'step.sh')], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })

  const calls: Call[] = readFileSync(log, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ argv: l.split(/\s+/) }))
  const patchFile = `${log}.patch`
  if (existsSync(patchFile)) {
    const body = readFileSync(patchFile, 'utf8')
    const patchCall = calls.find((c) => c.argv.includes('--patch-file'))
    if (patchCall) patchCall.patch = JSON.parse(body)
  }
  return { calls, stdout: proc.stdout.toString(), status: proc.exitCode ?? -1 }
}

describe('SHO-233 — the deploy actually delivers the GC to a node', () => {
  for (const [label, wf] of [
    ['staging', STAGING_WF],
    ['production (US block)', DEPLOY_WF],
  ] as const) {
    it(`runs the step as written: configmap -> manifest -> checksum -> rollout (${label})`, () => {
      const { calls, status } = runGcStep(wf)
      expect(status).toBe(0)

      const cm = calls.findIndex((c) => c.argv.join(' ').includes('create configmap node-image-gc'))
      const apply = calls.findIndex((c) => c.argv.join(' ') === 'apply -f k8s/base/node-image-gc.yaml')
      const patch = calls.findIndex((c) => c.argv.join(' ').includes('patch daemonset/node-image-gc'))
      const wait = calls.findIndex((c) => c.argv.join(' ').includes('rollout status daemonset/node-image-gc'))

      expect(cm).toBeGreaterThanOrEqual(0)
      expect(apply).toBeGreaterThan(cm)
      expect(patch).toBeGreaterThan(apply)
      expect(wait).toBeGreaterThan(patch)

      // The ConfigMap is generated from the single source, never a second copy.
      expect(calls[cm].argv.join(' ')).toContain('--from-file=node-image-gc.sh=scripts/node-image-gc.sh')
    })
  }

  it('pins the script checksum into the POD TEMPLATE, so a changed script rolls the pods', () => {
    const { calls } = runGcStep(STAGING_WF)
    const patchCall = calls.find((c) => c.argv.includes('--patch-file'))
    expect(patchCall).toBeDefined()
    // A DaemonSet's own metadata does not trigger a rollout; only the template does.
    expect(patchCall!.patch).toEqual({
      spec: { template: { metadata: { annotations: { 'checksum/script': SCRIPT_SHA } } } },
    })
    // merge-patch, so the rest of the manifest is not clobbered.
    expect(patchCall!.argv.join(' ')).toContain('--type=merge')
  })

  it('applies the same four calls in both production region blocks', () => {
    const text = readFileSync(DEPLOY_WF, 'utf8')
    expect(text.split('--from-file=node-image-gc.sh=scripts/node-image-gc.sh')).toHaveLength(3)
    expect(text.split('patch daemonset/node-image-gc --type=merge')).toHaveLength(3)
    expect(text.split('rollout status daemonset/node-image-gc')).toHaveLength(3)
  })

  it('reclaims before anything samples disk, in all three blocks', () => {
    for (const wf of [STAGING_WF, DEPLOY_WF]) {
      const text = readFileSync(wf, 'utf8')
      const gc = text.indexOf('Apply node image GC')
      const gate = text.indexOf('check-node-disk-headroom.sh')
      expect(gc).toBeGreaterThan(-1)
      expect(gate).toBeGreaterThan(gc)
      // The GC step must not land after the gate anywhere in the file.
      const gcAll = [...text.matchAll(/name: Apply node image GC/g)].map((m) => m.index!)
      const gateAll = [...text.matchAll(/check-node-disk-headroom\.sh/g)].map((m) => m.index!)
      expect(gcAll).toHaveLength(gateAll.length)
      for (let i = 0; i < gcAll.length; i++) expect(gcAll[i]).toBeLessThan(gateAll[i])
    }
  })
})

describe('SHO-233 — the operator paths name things that exist', () => {
  it('the gate failure text points at a section terraform/README.md actually has', () => {
    const gate = readFileSync(GATE, 'utf8')
    const m = gate.match(/see terraform\/README\.md '([^']+)'/)
    expect(m).not.toBeNull()
    const readme = readFileSync(join(REPO_ROOT, 'terraform', 'README.md'), 'utf8')
    expect(readme).toContain(`## ${m![1]}`)
  })

  it('the hand-run instructions exec into the GC pod, not into the node root', () => {
    // The ConfigMap is mounted inside the pod's view of the host root: on the
    // host that path is an empty directory, so `kubectl debug node/...` cannot
    // find the script (verified on staging 10.0.29.201).
    for (const text of [readFileSync(RUNBOOK, 'utf8'), SCRIPT_TEXT]) {
      const handRun = text.slice(text.indexOf('kubectl -n kube-system exec'))
      expect(handRun.length).toBeGreaterThan(0)
      expect(handRun).toContain('/run/shogo-node-image-gc/node-image-gc.sh')
      expect(handRun).toContain('chroot /host')
    }
    // ...and the manifest documents why, instead of claiming the node has it.
    expect(readFileSync(MANIFEST, 'utf8')).toContain('ONLY inside')
  })
})

describe('SHO-233 — the thresholds cannot drift between the three places', () => {
  const dsEnv = (name: string): string | undefined => {
    const m = readFileSync(MANIFEST, 'utf8').match(
      new RegExp(`- name: ${name}\\n\\s+value: "([^"]+)"`),
    )
    return m?.[1]
  }
  const monitorEnv = (name: string): string | undefined => {
    const m = readFileSync(MONITOR, 'utf8').match(
      new RegExp(`- name: ${name}\\n\\s+value: "([^"]+)"`),
    )
    return m?.[1]
  }

  it('the DaemonSet acts where the monitor starts paging about digests', () => {
    const reclaim = SCRIPT_TEXT.match(/RECLAIM_PCT="\$\{RECLAIM_PCT:-(\d+)\}"/)?.[1]
    expect(reclaim).toBeDefined()
    expect(dsEnv('RECLAIM_PCT')).toBe(reclaim)
    expect(monitorEnv('RECLAIM_PCT')).toBe(reclaim)
  })

  it('KEEP_PER_REPO is the same number the DaemonSet runs with', () => {
    const keep = SCRIPT_TEXT.match(/KEEP_PER_REPO="\$\{KEEP_PER_REPO:-(\d+)\}"/)?.[1]
    expect(dsEnv('KEEP_PER_REPO')).toBe(keep)
  })

  it('the gate threshold is still 80 and the monitor pages before it', () => {
    const gateDefault = readFileSync(GATE, 'utf8').match(/THRESHOLD_PCT="\$\{1:-\$\{THRESHOLD_PCT:-(\d+)\}\}"/)?.[1]
    expect(gateDefault).toBe('80')
    const crit = Number(monitorEnv('DISK_CRIT_PCT'))
    expect(crit).toBeGreaterThan(0)
    expect(crit).toBeLessThan(80)
  })
})
