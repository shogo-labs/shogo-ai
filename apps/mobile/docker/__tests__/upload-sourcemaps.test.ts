// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(import.meta.dir, '..', 'upload-sourcemaps.sh')

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const STUB = `#!/bin/sh
echo "$@" >> "$STUB_DIR/calls.log"
kind="$2"
if [ "$kind" = "$FAIL_KIND" ]; then
  count=$(cat "$STUB_DIR/count-$kind" 2>/dev/null || echo 0)
  count=$((count + 1))
  echo "$count" > "$STUB_DIR/count-$kind"
  if [ "$count" -le "$FAIL_TIMES" ]; then
    echo "error: API request failed" >&2
    echo "    sentry reported an error: bad gateway (http status: 502)" >&2
    exit 1
  fi
fi
exit 0
`

function fixture(opts: { failKind?: 'inject' | 'upload'; failTimes?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'sho135-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  const dist = join(dir, 'dist')
  mkdirSync(bin)
  mkdirSync(join(dist, '_expo', 'static', 'js', 'web'), { recursive: true })
  writeFileSync(join(dist, '_expo', 'static', 'js', 'web', 'index.js'), 'console.log(1)\n')
  writeFileSync(join(dist, '_expo', 'static', 'js', 'web', 'index.js.map'), '{}\n')
  writeFileSync(join(bin, 'sentry-cli'), STUB)
  chmodSync(join(bin, 'sentry-cli'), 0o755)
  return {
    dir,
    dist,
    mapPath: join(dist, '_expo', 'static', 'js', 'web', 'index.js.map'),
    calls: () => {
      const log = join(dir, 'calls.log')
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
    },
    run: (env: Record<string, string>) =>
      Bun.spawn(['sh', SCRIPT], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          STUB_DIR: dir,
          FAIL_KIND: opts.failKind ?? 'upload',
          FAIL_TIMES: String(opts.failTimes ?? 0),
          ...env,
        },
      }),
  }
}

const token = { SENTRY_AUTH_TOKEN: 'test-token' }

describe('upload-sourcemaps.sh', () => {
  it(
    'retries a 502 twice and succeeds on the third upload, deleting maps only then',
    async () => {
      const f = fixture({ failKind: 'upload', failTimes: 2 })
      const proc = f.run({ ...token, REQUIRE_SENTRY_UPLOAD: 'true', EXPO_PUBLIC_BUILD_HASH: 'abc123' })
      expect(await proc.exited).toBe(0)
      const calls = f.calls()
      expect(calls.filter((c) => c.startsWith('sourcemaps upload')).length).toBe(3)
      expect(calls.filter((c) => c.startsWith('sourcemaps inject')).length).toBe(3)
      expect(existsSync(f.mapPath)).toBe(false)
      expect(await new Response(proc.stdout).text()).toContain('Uploaded source maps for release abc123')
    },
    40_000,
  )

  it(
    'fails closed after three 502s and leaves the maps in dist/',
    async () => {
      const f = fixture({ failKind: 'upload', failTimes: 99 })
      const proc = f.run({ ...token, REQUIRE_SENTRY_UPLOAD: 'true', EXPO_PUBLIC_BUILD_HASH: 'abc123' })
      expect(await proc.exited).toBe(1)
      expect(f.calls().filter((c) => c.startsWith('sourcemaps upload')).length).toBe(3)
      expect(existsSync(f.mapPath)).toBe(true)
      const stderr = await new Response(proc.stderr).text()
      expect(stderr).toContain('failed 3 times')
      expect(stderr).toContain('Refusing to ship a web bundle whose source maps never reach Sentry')
    },
    40_000,
  )

  it(
    'retries a failing inject too, then uploads once it recovers',
    async () => {
      const f = fixture({ failKind: 'inject', failTimes: 1 })
      const proc = f.run({ ...token, REQUIRE_SENTRY_UPLOAD: 'true', EXPO_PUBLIC_BUILD_HASH: 'abc123' })
      expect(await proc.exited).toBe(0)
      const calls = f.calls()
      expect(calls.filter((c) => c.startsWith('sourcemaps inject')).length).toBe(2)
      expect(calls.filter((c) => c.startsWith('sourcemaps upload')).length).toBe(1)
      expect(existsSync(f.mapPath)).toBe(false)
    },
    40_000,
  )

  it('refuses a deploy build with no token, without invoking sentry-cli', async () => {
    const f = fixture({})
    const proc = f.run({ REQUIRE_SENTRY_UPLOAD: 'true', EXPO_PUBLIC_APP_ENV: 'production' })
    expect(await proc.exited).toBe(1)
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain('ERROR: SENTRY_AUTH_TOKEN is empty on a deploy build')
    expect(stderr).toContain('Configure SENTRY_AUTH_TOKEN (project:releases scope)')
    expect(f.calls()).toEqual([])
    expect(existsSync(f.mapPath)).toBe(true)
  })

  it('refuses a production APP_ENV with no token even without REQUIRE_SENTRY_UPLOAD', async () => {
    const f = fixture({})
    const proc = f.run({ EXPO_PUBLIC_APP_ENV: 'production-us' })
    expect(await proc.exited).toBe(1)
    expect(await new Response(proc.stderr).text()).toContain('ERROR: SENTRY_AUTH_TOKEN is empty on a deploy build')
    expect(f.calls()).toEqual([])
  })

  it('skips a non-production build with no token', async () => {
    const f = fixture({})
    const proc = f.run({ EXPO_PUBLIC_APP_ENV: 'development' })
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toContain(
      'SENTRY_AUTH_TOKEN not set — skipping Sentry source map upload (non-production build)',
    )
    expect(f.calls()).toEqual([])
  })
})
