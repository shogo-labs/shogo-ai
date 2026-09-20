#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `update-channel.ts` — the pure feed-URL resolver behind
 * the desktop app's stable/beta auto-update channels. Run with:
 *
 *   cd apps/desktop && bun test-update-channel.ts
 *
 * Deliberately not `bun:test` — matches the plain pass/fail runner used
 * by the other top-level `test-*.ts` files in this package (see
 * test-forge-config.ts), which `npm run test:desktop-bundle[:ci]` chains
 * together with `&&` and relies on a non-zero exit code from any of them
 * failing the whole chain.
 */
import { parseUpdateChannel, resolveFeedUrl } from './src/update-channel'

let passed = 0
let failed = 0

function ok(name: string): void {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}`)
}
function bad(name: string, detail?: unknown): void {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${String(detail)}` : ''}`)
}
function assertEqual(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) ok(name)
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

console.log('parseUpdateChannel')
{
  assertEqual('passes through "beta"', parseUpdateChannel('beta'), 'beta')
  assertEqual('passes through "stable"', parseUpdateChannel('stable'), 'stable')
  assertEqual('defaults undefined to "stable"', parseUpdateChannel(undefined), 'stable')
  assertEqual('defaults null to "stable"', parseUpdateChannel(null), 'stable')
  assertEqual('defaults an unrecognized string to "stable"', parseUpdateChannel('nightly'), 'stable')
  assertEqual('defaults a non-string to "stable"', parseUpdateChannel(42), 'stable')
  assertEqual('defaults empty string to "stable"', parseUpdateChannel(''), 'stable')
}

console.log('')
console.log('resolveFeedUrl — stable channel (unchanged update.electronjs.org contract)')
{
  assertEqual(
    'darwin-arm64',
    resolveFeedUrl({ channel: 'stable', platform: 'darwin', arch: 'arm64', version: '1.14.9' }),
    'https://update.electronjs.org/shogo-labs/shogo-ai/darwin-arm64/1.14.9',
  )
  assertEqual(
    'win32-x64',
    resolveFeedUrl({ channel: 'stable', platform: 'win32', arch: 'x64', version: '1.14.9' }),
    'https://update.electronjs.org/shogo-labs/shogo-ai/win32-x64/1.14.9',
  )
}

console.log('')
console.log('resolveFeedUrl — beta channel (releases.shogo.ai Worker)')
{
  assertEqual(
    'darwin-arm64',
    resolveFeedUrl({ channel: 'beta', platform: 'darwin', arch: 'arm64', version: '1.14.9' }),
    'https://releases.shogo.ai/desktop/beta/darwin-arm64/1.14.9',
  )
  assertEqual(
    'darwin-x64',
    resolveFeedUrl({ channel: 'beta', platform: 'darwin', arch: 'x64', version: '1.14.10-beta.20260919233000' }),
    'https://releases.shogo.ai/desktop/beta/darwin-x64/1.14.10-beta.20260919233000',
  )
  assertEqual(
    'win32-x64',
    resolveFeedUrl({ channel: 'beta', platform: 'win32', arch: 'x64', version: '1.14.9' }),
    'https://releases.shogo.ai/desktop/beta/win32-x64/1.14.9',
  )
}

console.log('')
console.log('resolveFeedUrl — SHOGO_UPDATE_FEED_BASE_URL override (e2e mock feed)')
{
  assertEqual(
    'stable channel routes through the override with the channel in the path',
    resolveFeedUrl({
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      version: '1.14.9',
      baseUrlOverride: 'http://127.0.0.1:4321',
    }),
    'http://127.0.0.1:4321/stable/darwin-arm64/1.14.9',
  )
  assertEqual(
    'beta channel routes through the override with the channel in the path',
    resolveFeedUrl({
      channel: 'beta',
      platform: 'win32',
      arch: 'x64',
      version: '1.99.0',
      baseUrlOverride: 'http://127.0.0.1:4321',
    }),
    'http://127.0.0.1:4321/beta/win32-x64/1.99.0',
  )
  assertEqual(
    'strips a trailing slash from the override before appending',
    resolveFeedUrl({
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      version: '1.0.0',
      baseUrlOverride: 'http://127.0.0.1:4321/',
    }),
    'http://127.0.0.1:4321/stable/darwin-arm64/1.0.0',
  )
  assertEqual(
    'a null override falls back to the real hosts',
    resolveFeedUrl({
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      version: '1.0.0',
      baseUrlOverride: null,
    }),
    'https://update.electronjs.org/shogo-labs/shogo-ai/darwin-arm64/1.0.0',
  )
}

console.log('')
if (failed > 0) {
  console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed`)
  process.exit(1)
}
console.log(`\x1b[32mall ${passed} tests passed\x1b[0m`)
