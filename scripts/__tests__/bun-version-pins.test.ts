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
