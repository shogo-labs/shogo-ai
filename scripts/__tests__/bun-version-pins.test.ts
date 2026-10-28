// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every Bun pin in the repo must match `packageManager` in package.json.
 *
 * The desktop app bundles whichever Bun its release workflow installs, so a
 * workflow left on an older pin ships that runtime to users. Bun 1.3.x has no
 * Windows PTY, which is how the integrated terminal shipped broken on Windows
 * while some images already ran 1.4.
 */
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '../..')

const expected: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
  .packageManager.replace(/^bun@/, '')

function trackedFiles(...patterns: string[]): string[] {
  return execFileSync('git', ['ls-files', ...patterns], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

interface Pin { file: string; line: number; version: string }

const PIN_PATTERNS = [
  // workflows: `bun-version: '1.4.2'` / `BUN_VERSION: '1.4.2'`
  /\b(?:bun-version|BUN_VERSION):\s*['"]?([^'"\s#]+)/,
  // Dockerfiles: `FROM oven/bun:1.4.2-debian`
  /oven\/bun:([0-9][^\s-]*)/,
  // Dockerfiles: `bash -s "bun-v1.4.2"`
  /\bbun-v([0-9][^"'\s]*)/,
]

export function findPins(file: string, text: string): Pin[] {
  const pins: Pin[] = []
  text.split('\n').forEach((content, i) => {
    for (const re of PIN_PATTERNS) {
      const m = re.exec(content)
      if (m) pins.push({ file, line: i + 1, version: m[1] })
    }
  })
  return pins
}

// `latest` floats forward and `${{ env.BUN_VERSION }}` resolves to a pin that
// is itself checked, so neither can drift behind.
const isFloatingOrIndirect = (v: string) => v === 'latest' || v.startsWith('${{')

const semver = (v: string) => v.split('.').map((n) => parseInt(n, 10))

/** `have` >= `floor`, comparing major/minor/patch numerically. */
export function versionAtLeast(have: string, floor: string): boolean {
  const a = semver(have)
  const b = semver(floor)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return false
    if (x !== y) return x > y
  }
  return true
}

// Node2Shell (CVE-2026-111497): an out-of-bounds write in the bundled Brotli
// decoder, reachable through `fetch()` on a `br` response. Fixed in Bun 1.4.4
// and Node 22.23.4 / 24.22.1 / 26.12.1 — the EOL lines never get a patch.
const BUN_SECURITY_FLOOR = '1.4.4'
const NODE_SECURITY_FLOOR_BY_LINE = { 24: '24.22.1', 26: '26.12.1' } as const

describe('Bun version pins', () => {
  it('packageManager pins an exact Bun version', () => {
    expect(expected).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('every workflow and Dockerfile pin matches packageManager', () => {
    const files = trackedFiles('.github/workflows/*.yml', '.github/workflows/*.yaml', '*Dockerfile*')
    const pins = files.flatMap((f) => findPins(f, readFileSync(join(ROOT, f), 'utf-8')))
    expect(pins.length).toBeGreaterThan(0)
    const drift = pins
      .filter((p) => !isFloatingOrIndirect(p.version) && p.version !== expected)
      .map((p) => `${p.file}:${p.line} pins ${p.version}`)
    expect(drift).toEqual([])
  })

  it('desktop download-bun.mjs defaults to packageManager, not latest', () => {
    const text = readFileSync(join(ROOT, 'apps/desktop/scripts/download-bun.mjs'), 'utf-8')
    const match = text.match(/process\.env\.BUN_VERSION\s*\|\|\s*['"]([^'"]+)['"]/)
    expect(match?.[1]).toBe(expected)
  })

  it('detects each pin style', () => {
    const text = [
      "          bun-version: '1.3.11'",
      "  BUN_VERSION: '1.3.11'",
      'FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS builder',
      '    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.11" && \\',
    ].join('\n')
    expect(findPins('x', text).map((p) => p.version)).toEqual(['1.3.11', '1.3.11', '1.3', '1.3.11'])
  })
})

describe('Node2Shell (CVE-2026-111497) floors', () => {
  const read = (file: string) => readFileSync(join(ROOT, file), 'utf-8')

  it('pins a Bun at or above the patched release (1.4.4)', () => {
    expect(versionAtLeast(expected, BUN_SECURITY_FLOOR)).toBe(true)
  })

  it('compares versions numerically past single digits', () => {
    expect(versionAtLeast('1.4.4', '1.4.4')).toBe(true)
    expect(versionAtLeast('1.10.0', '1.4.4')).toBe(true)
    expect(versionAtLeast('1.4.3', '1.4.4')).toBe(false)
    expect(versionAtLeast('26.12.1', '26.12.1')).toBe(true)
    expect(versionAtLeast('26.9.0', '26.12.1')).toBe(false)
  })

  // Node 20/21/23/25 are past end-of-life, so a CVE fix never lands on them.
  const EOL_NODE_LINES = /^\s*FROM\s+(?:--platform=\S+\s+)?node:(?:20|21|23|25)\b/m

  it('no Dockerfile builds from an EOL Node line', () => {
    const offenders = trackedFiles('*Dockerfile*')
      .filter((f) => EOL_NODE_LINES.test(read(f)))
      .map((f) => `${f} uses an EOL node base`)
    expect(offenders).toEqual([])
  })

  it('API image builds from a patched Node line', () => {
    const from = read('apps/api/Dockerfile').match(/^\s*FROM\s+node:(\d+)/m)
    expect(Number(from?.[1])).toBeGreaterThanOrEqual(26)
  })

  // The guard is what stops a stale registry cache or a floating nodesource
  // tag from silently shipping the vulnerable decoder again.
  const GUARDED: Array<{ file: string; bun: string; node?: string }> = [
    { file: 'apps/api/Dockerfile', bun: BUN_SECURITY_FLOOR, node: NODE_SECURITY_FLOOR_BY_LINE[26] },
    { file: 'docker/workspace-deps/Dockerfile', bun: BUN_SECURITY_FLOOR },
    {
      file: 'packages/agent-runtime/Dockerfile.base',
      bun: BUN_SECURITY_FLOOR,
      node: NODE_SECURITY_FLOOR_BY_LINE[24],
    },
    {
      file: 'packages/agent-runtime/Dockerfile.swe-overlay',
      bun: BUN_SECURITY_FLOOR,
      node: NODE_SECURITY_FLOOR_BY_LINE[24],
    },
  ]

  for (const { file, bun, node } of GUARDED) {
    it(`${file} fails its build below bun ${bun}${node ? ` / node ${node}` : ''}`, () => {
      const text = read(file)
      expect(text).toContain(`bun_need=${bun}`)
      if (node) expect(text).toContain(`node_need=${node}`)
      expect(text).toContain('Node2Shell guard OK')
    })
  }
})

