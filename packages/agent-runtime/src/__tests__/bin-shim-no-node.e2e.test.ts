// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// End-to-end test for the Shogo Desktop "no system node on PATH" case.
//
// The Shogo Desktop bundle ships `bun` but does NOT bundle a Node.js
// runtime. The Electron-spawned API process inherits a PATH from
// launchctl that typically excludes any user-installed node (Homebrew,
// nvm, asdf) — so the spawned `node_modules/.bin/vite` shim reads its
// `#!/usr/bin/env node` shebang and exits 127 with
// `env: node: No such file or directory`, killing every preview rebuild.
//
// `resolveBinInvocation` is the helper that fixes this by readlinking
// the shim and routing through bundled `bun`. This e2e test asserts
// that the fix works against the REAL binaries (a real .bin/vite-like
// shim, executed via real bun), so a future "this only works in
// theory" regression can't slip through. The unit tests in
// platform-pkg.test.ts cover the logic — this test proves the wiring.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  resolveBinInvocation,
  _resetUnixNodeCache,
} from '@shogo/shared-runtime'

// Use /tmp explicitly rather than $TMPDIR — under bun:test on macOS,
// stderr capture from short-lived child processes inside the system's
// per-user $TMPDIR (`/var/folders/.../T/`) intermittently arrives
// empty even though the child wrote to fd 2 and exited with the right
// code. /tmp avoids the issue.
const TMP = '/tmp/shogo-bin-shim-e2e'

function seedFakeViteShim(workspaceDir: string): {
  jsEntry: string
  shim: string
  markerPath: string
} {
  // Mimic an installed Vite layout:
  //   <workspace>/node_modules/vite/bin/vite.js   (with bad shebang)
  //   <workspace>/node_modules/.bin/vite -> ../vite/bin/vite.js
  // The JS writes a sentinel file to a known location. We check for
  // the file's existence and contents instead of capturing stdout —
  // bun:test discards spawned child stdio (both 'pipe' and explicit
  // fd redirection lose bytes silently) but the filesystem doesn't
  // lie.
  const viteDir = join(workspaceDir, 'node_modules', 'vite', 'bin')
  const binDir = join(workspaceDir, 'node_modules', '.bin')
  mkdirSync(viteDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  const markerPath = join(workspaceDir, 'vite-marker.txt')
  const jsEntry = join(viteDir, 'vite.js')
  writeFileSync(
    jsEntry,
    `#!/usr/bin/env node
// This shebang is the bug — when this file is spawned directly without
// node on PATH, the kernel can't exec env-node and we get exit 127.
// Bun ignores the shebang line and runs the rest as JS.
const fs = require('fs')
const args = process.argv.slice(2)
fs.writeFileSync(${JSON.stringify(markerPath)}, 'vite-marker:' + args.join(','))
process.exit(0)
`,
  )
  chmodSync(jsEntry, 0o755)
  const shim = join(binDir, 'vite')
  symlinkSync('../vite/bin/vite.js', shim)
  return { jsEntry, shim, markerPath }
}

function runCmd(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { code: number | null } {
  // Under bun:test on macOS, spawnSync silently drops piped child
  // stdout/stderr (and won't even capture the kernel-emitted
  // `env: ...: No such file` from a 127 exit), so we don't try to
  // capture output here. Tests rely on (a) the exit code, which bun
  // does propagate correctly, and (b) a marker file written by the
  // child to a known path — the filesystem doesn't have this quirk.
  const result = spawnSync(cmd, args, {
    env,
    stdio: 'ignore',
  })
  return { code: result.status }
}

describe('resolveBinInvocation e2e (no node on PATH)', () => {
  let prevPath: string | undefined
  let prevBunPath: string | undefined

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    prevPath = process.env.PATH
    prevBunPath = process.env.SHOGO_BUN_PATH
    _resetUnixNodeCache()
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevBunPath === undefined) delete process.env.SHOGO_BUN_PATH
    else process.env.SHOGO_BUN_PATH = prevBunPath
    _resetUnixNodeCache()
  })

  test('direct shim spawn fails with code 127 when node is missing (the bug)', () => {
    if (process.platform === 'win32') return
    const { shim, markerPath } = seedFakeViteShim(TMP)

    // PATH does not contain `node`. This is the broken case from the
    // user's main.log — assert exit 127 AND that the JS never got to
    // run (no marker file), proving the shebang exec really failed.
    const result = runCmd(shim, ['build', '--watch'], { PATH: join(TMP, 'no-node-here') })
    expect(result.code).toBe(127)
    expect(existsSync(markerPath)).toBe(false)
  })

  test('bun-routed spawn succeeds when node is missing (the fix)', () => {
    if (process.platform === 'win32') return
    const { markerPath } = seedFakeViteShim(TMP)

    // resolveBinInvocation should pick bun + the JS entry, and that
    // pair must actually execute correctly with `node` absent from
    // PATH. SHOGO_BUN_PATH points to the bun running this test.
    const bunPath = process.execPath
    process.env.PATH = join(TMP, 'no-node-here')
    process.env.SHOGO_BUN_PATH = bunPath
    _resetUnixNodeCache()

    const inv = resolveBinInvocation(TMP, 'vite')
    expect(inv).not.toBeNull()
    expect(inv!.cmd).toBe(bunPath)
    expect(inv!.argsPrefix).toHaveLength(1)

    // Now actually invoke it the way preview-manager and
    // canvas-build-manager would. PATH still has no node — the marker
    // file's existence proves bun executed the JS end-to-end.
    const result = runCmd(
      inv!.cmd,
      [...inv!.argsPrefix, 'build', '--watch'],
      { PATH: join(TMP, 'no-node-here'), HOME: process.env.HOME ?? '/tmp' },
    )
    expect(result.code).toBe(0)
    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(markerPath, 'utf8')).toBe('vite-marker:build,--watch')
  })

  test('bun-routed spawn works when workspace path contains spaces', () => {
    if (process.platform === 'win32') return
    const spacey = join(TMP, 'Library', 'Application Support', 'Shogo', 'workspaces', 'abc-def')
    mkdirSync(spacey, { recursive: true })
    const { markerPath } = seedFakeViteShim(spacey)

    const bunPath = process.execPath
    process.env.PATH = join(TMP, 'no-node-here')
    process.env.SHOGO_BUN_PATH = bunPath
    _resetUnixNodeCache()

    const inv = resolveBinInvocation(spacey, 'vite')
    expect(inv).not.toBeNull()

    // The original v0.4.0 SDK path bug was passing a space-containing
    // path through a shell string ("bun ${generateScript}"). Assert
    // that the new fix uses argv-array spawn with the space-laden
    // absolute path intact, then succeeds with exit 0 — no shell
    // tokenization, no path truncation. The marker file lives at a
    // spaces-in-path location too, so this exercises both halves
    // (cmd-line arg AND filesystem path).
    expect(inv!.argsPrefix[0]).toContain('Application Support')
    expect(markerPath).toContain('Application Support')

    const result = runCmd(
      inv!.cmd,
      [...inv!.argsPrefix, 'build', '--emptyOutDir', 'false'],
      { PATH: join(TMP, 'no-node-here'), HOME: process.env.HOME ?? '/tmp' },
    )
    expect(result.code).toBe(0)
    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(markerPath, 'utf8')).toBe('vite-marker:build,--emptyOutDir,false')
  })

  test('direct shim spawn succeeds when node IS on PATH (fast-path preserved)', () => {
    if (process.platform === 'win32') return
    const { shim, markerPath } = seedFakeViteShim(TMP)

    // Find a real node on the host. If none is available, skip — the
    // previous test already covers the bun fallback path that desktop
    // bundles actually take.
    const realNode = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'].find((p) => {
      try { return existsSync(p) } catch { return false }
    })
    if (!realNode) return
    const nodePathDir = realNode.replace(/\/node$/, '')

    process.env.PATH = nodePathDir
    _resetUnixNodeCache()

    const inv = resolveBinInvocation(TMP, 'vite')
    expect(inv).not.toBeNull()
    expect(inv!.cmd).toBe(shim)
    expect(inv!.argsPrefix).toEqual([])

    const result = runCmd(
      inv!.cmd,
      ['build'],
      { PATH: nodePathDir, HOME: process.env.HOME ?? '/tmp' },
    )
    expect(result.code).toBe(0)
    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(markerPath, 'utf8')).toBe('vite-marker:build')
  })
})
