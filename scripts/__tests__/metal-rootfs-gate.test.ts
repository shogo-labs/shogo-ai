// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * scripts/ci/metal-rootfs-gate.sh decides whether a production release rebuilds
 * every metal host's rootfs. Both wrong answers hurt: a needless rebuild throws
 * away every snapshot fleet-wide, a skipped one leaves guests on stale code.
 * These run the real script against a throwaway git repo and a stubbed curl
 * that serves per-control-plane /fleet fixtures.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const SCRIPT = resolve(import.meta.dir, '../ci/metal-rootfs-gate.sh')

let root: string
let repo: string
let bin: string
let fixtures: string
/** c1: runtime code. c2: API-only change on top. c3: another runtime change. */
let c1: string, c2: string, c3: string

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function commit(path: string, content: string): string {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), content)
  git('add', '-A')
  git('commit', '-qm', path)
  return git('rev-parse', 'HEAD')
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rootfs-gate-'))
  repo = join(root, 'repo')
  bin = join(root, 'bin')
  fixtures = join(root, 'fixtures')
  mkdirSync(repo)
  mkdirSync(bin)
  mkdirSync(fixtures)
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  c1 = commit('packages/agent-runtime/src/a.ts', 'one')
  c2 = commit('apps/api/src/x.ts', 'api')
  c3 = commit('packages/agent-runtime/src/a.ts', 'two')

  // curl stub: `<host>.down` fails the request, `<host>.code` overrides the
  // status, `<host>.json` is the body. Also records the bearer it was sent.
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
url="\${@: -1}"; host=$(echo "$url" | sed -E 's#^https?://([^/]+)/.*#\\1#')
for a in "$@"; do case "$a" in Authorization:*) echo "$a" > "$FIXTURES/$host.auth";; esac; done
[ -f "$FIXTURES/$host.down" ] && { echo "curl: (7) Failed to connect to $host" >&2; exit 7; }
cat "$FIXTURES/$host.json" 2>/dev/null
printf '\\n%s' "$(cat "$FIXTURES/$host.code" 2>/dev/null || echo 200)"
`,
  )
  chmodSync(join(bin, 'curl'), 0o755)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

type Host = { hostId: string; region: string; rootfsRevision?: string | null }

function serve(cp: string, opts: { hosts?: Host[]; down?: boolean; code?: number }) {
  for (const ext of ['json', 'down', 'code', 'auth']) rmSync(join(fixtures, `${cp}.${ext}`), { force: true })
  if (opts.down) writeFileSync(join(fixtures, `${cp}.down`), '')
  if (opts.code) writeFileSync(join(fixtures, `${cp}.code`), String(opts.code))
  const hosts = (opts.hosts ?? []).map((h) => ({ ...h, agentVersion: 'v', load: { available: 1 }, live: true }))
  writeFileSync(join(fixtures, `${cp}.json`), JSON.stringify({ ok: opts.code ? false : true, hosts }))
}

function gate(sha: string, opts: { baseline?: string | null; summary?: string } = {}) {
  const baselineFile = join(root, 'baseline')
  if (opts.baseline === null || opts.baseline === undefined) rmSync(baselineFile, { force: true })
  else writeFileSync(baselineFile, `# the commit the fleet runs\n\n${opts.baseline}\n`)
  const r = spawnSync('bash', [SCRIPT, 'check', sha, 'production-us=https://us.test', 'production-eu=https://eu.test'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FIXTURES: fixtures,
      BASELINE_FILE: baselineFile,
      METAL_REGISTER_TOKEN_PRODUCTION_US: 'us-tok',
      METAL_REGISTER_TOKEN_PRODUCTION_EU: 'eu-tok',
      GITHUB_STEP_SUMMARY: opts.summary ?? '',
    },
  })
  const out = Object.fromEntries(
    r.stdout
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
  return { status: r.status, rebuild: out.rebuild, reason: out.reason ?? '', stderr: r.stderr }
}

const us = (rev: string | null) => [
  { hostId: 'dal-1', region: 'us', rootfsRevision: rev },
  { hostId: 'dal-2', region: 'us', rootfsRevision: rev },
]
const eu = (rev: string | null) => [
  { hostId: 'fra-1', region: 'eu', rootfsRevision: rev },
  { hostId: 'fra-2', region: 'eu', rootfsRevision: rev },
  { hostId: 'fra-3', region: 'eu', rootfsRevision: rev },
]

describe('metal-rootfs-gate', () => {
  test('skips when every host runs the same revision and the runtime chain did not change', () => {
    serve('us.test', { hosts: us(c1) })
    serve('eu.test', { hosts: eu(c1) })
    const r = gate(c2)
    expect(r.status).toBe(0)
    expect(r.rebuild).toBe('false')
    expect(r.reason).toContain(c1.slice(0, 12))
  })

  test('sends each control plane its own token', () => {
    serve('us.test', { hosts: us(c1) })
    serve('eu.test', { hosts: eu(c1) })
    gate(c2)
    expect(readFileSync(join(fixtures, 'us.test.auth'), 'utf8').trim()).toBe('Authorization: Bearer us-tok')
    expect(readFileSync(join(fixtures, 'eu.test.auth'), 'utf8').trim()).toBe('Authorization: Bearer eu-tok')
  })

  test('skips when the fleet already runs the release commit', () => {
    serve('us.test', { hosts: us(c3) })
    serve('eu.test', { hosts: eu(c3) })
    expect(gate(c3).rebuild).toBe('false')
  })

  test('rebuilds when the runtime chain changed since the fleet revision', () => {
    serve('us.test', { hosts: us(c1) })
    serve('eu.test', { hosts: eu(c1) })
    const r = gate(c3)
    expect(r.rebuild).toBe('true')
    expect(r.reason).toContain('guest image changed')
    expect(r.stderr).toContain('packages/agent-runtime/src/a.ts')
  })

  test('rebuilds when hosts disagree on the revision', () => {
    serve('us.test', { hosts: us(c1) })
    serve('eu.test', { hosts: eu(c2) })
    const r = gate(c2)
    expect(r.rebuild).toBe('true')
    expect(r.reason).toContain('disagree')
  })

  test('rebuilds when a control plane is unreachable', () => {
    serve('us.test', { hosts: us(c1) })
    serve('eu.test', { down: true })
    const r = gate(c2)
    expect(r.status).toBe(0)
    expect(r.rebuild).toBe('true')
    expect(r.reason).toContain('production-eu unreachable')
  })

  test('rebuilds when a control plane rejects the token', () => {
    serve('us.test', { hosts: us(c1) })
    serve('eu.test', { code: 401 })
    const r = gate(c2)
    expect(r.rebuild).toBe('true')
    expect(r.reason).toContain('HTTP 401')
  })

  test('rebuilds when a control plane reports no live hosts', () => {
    serve('us.test', { hosts: us(c1) })
    serve('eu.test', { hosts: [] })
    const r = gate(c2)
    expect(r.rebuild).toBe('true')
    expect(r.reason).toContain('no live hosts')
  })

  test('rebuilds when a host revision is not a commit in this checkout', () => {
    serve('us.test', { hosts: us('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef') })
    serve('eu.test', { hosts: eu('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef') })
    expect(gate(c2).rebuild).toBe('true')
  })

  describe('legacy hosts that report no revision', () => {
    test('fall back to the baseline file, with a warning', () => {
      serve('us.test', { hosts: us(null) })
      serve('eu.test', { hosts: eu(null) })
      const r = gate(c2, { baseline: c1 })
      expect(r.rebuild).toBe('false')
      expect(r.stderr).toContain('::warning::5 host(s) report no rootfs revision')
    })

    test('rebuild when the baseline is behind the runtime chain', () => {
      serve('us.test', { hosts: us(null) })
      serve('eu.test', { hosts: eu(null) })
      expect(gate(c3, { baseline: c1 }).rebuild).toBe('true')
    })

    test('rebuild when no baseline is recorded', () => {
      serve('us.test', { hosts: us(null) })
      serve('eu.test', { hosts: eu(null) })
      const r = gate(c2, { baseline: null })
      expect(r.rebuild).toBe('true')
      expect(r.reason).toContain('no baseline is recorded')
    })

    test('mixed with stamped hosts: skip only when the baseline is the same revision', () => {
      serve('us.test', { hosts: us(null) })
      serve('eu.test', { hosts: eu(c1) })
      expect(gate(c2, { baseline: c1 }).rebuild).toBe('false')
      expect(gate(c2, { baseline: c2 }).rebuild).toBe('true')
    })
  })

  test('writes a per-host table to the job summary', () => {
    serve('us.test', { hosts: us(c1) })
    serve('eu.test', { hosts: eu(null) })
    const summary = join(root, 'summary.md')
    rmSync(summary, { force: true })
    gate(c2, { baseline: c1, summary })
    const md = readFileSync(summary, 'utf8')
    expect(md).toContain('rebuild=false')
    expect(md).toContain(`| production-us | dal-1 | us | ${c1} |`)
    expect(md).toContain('| production-eu | fra-3 | eu | _none_ |')
  })

  test('decide treats a missing fleet file as unreadable', () => {
    const r = spawnSync('bash', [SCRIPT, 'decide', c2, join(root, 'nope.json')], { cwd: repo, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('rebuild=true')
    expect(r.stdout).toContain('missing or unreadable')
  })
})
