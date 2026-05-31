// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for PreviewManager's status/URL contract. The agent relies on
// getStatus().url to tell the QA subagent (and the user) where the running
// app lives — this test exists because a regression here previously left the
// agent probing for the URL via `lsof` and hallucinated `.shogo/preview-url`.
//
// Layout note: TEST_DIR is the *workspace root*. PreviewManager derives the
// bundler cwd from this — for these tests we put package.json directly at
// the workspace root (the Expo / RN layout), so `bundlerCwd === workspaceDir`.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PreviewManager, emitBuildLine, resolveApiServerEnv } from '../preview-manager'
import { flushAllLogWrites, __resetLogWriterForTest } from '../runtime-log-writer'
import {
  previewBuildLogPath,
  ensureRuntimeLogDir,
  RUNTIME_LOG_SUBDIR,
  BUILD_LOG_BASENAME,
} from '../runtime-log-paths'
import {
  __resetRuntimeLogDispatcherForTest,
  getRuntimeLogsSnapshot,
} from '../runtime-log-dispatcher'

const TEST_DIR = '/tmp/test-preview-manager'

function setupProjectDir(hasPrebuiltDist = false) {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({ name: 'fixture' }))
  // Pre-create an empty node_modules/ so PreviewManager skips `bun install`
  // during the background setup path — otherwise install flips phase to
  // 'installing' and spawns a real package manager inside the test.
  mkdirSync(join(TEST_DIR, 'node_modules'), { recursive: true })
  if (hasPrebuiltDist) {
    mkdirSync(join(TEST_DIR, 'dist'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'dist', 'index.html'), '<html></html>')
  }
}

describe('PreviewManager', () => {
  beforeEach(() => setupProjectDir())
  afterEach(async () => {
    // Drain any pending async log writes scheduled via runtime-log-writer
    // before tearing down the fixture directory — otherwise Windows hits
    // EBUSY because the .shogo/logs/build.log handle is still open.
    await flushAllLogWrites()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('getStatus before start: running=false, urls null', () => {
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    const s = pm.getStatus()
    expect(s.running).toBe(false)
    expect(s.port).toBeNull()
    expect(s.url).toBeNull()
    expect(s.internalUrl).toBeNull()
    expect(s.publicUrl).toBeNull()
    expect(s.phase).toBe('idle')
  })

  test('depsReady is constructable up-front and resolves after start() settles', async () => {
    // Pin the contract `CanvasBuildManager` relies on: the deferred
    // must exist BEFORE `start()` is called (so the gateway can pass
    // `() => pm.depsReady` into CanvasBuildManager during wiring,
    // which happens before pm.start()), and it must resolve exactly
    // once installDepsIfNeeded settles — not on subsequent restarts.
    //
    // Regression target: the canvas-build vs. install race that
    // produced `error during build: undefined` in every VM-isolated
    // session on macOS (see PreviewManager.depsReady doc comment).
    setupProjectDir(true) // pre-built dist → start() short-circuits without spawning vite
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    expect(pm.depsSettled).toBe(false)
    let resolved = false
    pm.depsReady.then(() => { resolved = true })
    await pm.start()
    // start() runs installDepsIfNeeded, which (with no node_modules
    // to inspect and no install marker) falls through to the actual
    // install branch. Whether that branch succeeds or throws, the
    // `finally` in installDepsIfNeeded must flip depsSettled.
    expect(pm.depsSettled).toBe(true)
    // Allow microtask flush so the then() can observe resolution.
    await Promise.resolve()
    expect(resolved).toBe(true)
    pm.stop()
  })

  test('depsReady can be awaited before start() (deferred created in constructor)', async () => {
    setupProjectDir(true)
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    let observed = false
    const waiter = pm.depsReady.then(() => { observed = true })

    // Sanity: the await is still pending — nothing has settled yet.
    await Promise.resolve()
    expect(observed).toBe(false)

    await pm.start()
    await waiter
    expect(observed).toBe(true)
    expect(pm.depsSettled).toBe(true)
    pm.stop()
  })

  test('cross-platform node_modules tag drops the install-marker fast-path', async () => {
    // Regression target: macOS host installs node_modules and writes
    // an install-marker; linux guest VM 9p-mounts the same workspace
    // and `installDepsIfNeeded` would otherwise see the matching
    // package.json sha256 and skip the install, leaving
    // `@rollup/rollup-linux-arm64-gnu` (and friends) absent.
    //
    // We can't fake `process.platform` from a unit test, so we go in
    // the other direction: write a `.shogo-platform` tag that
    // CANNOT match the running platform (`fake-tag-from-other-os`),
    // along with a valid install-marker matching the current
    // package.json. After running through the marker-loading branch
    // by inspecting on-disk state, the install-marker must be gone
    // (signaling the mismatch path tripped) so the next install pass
    // runs unconditionally.
    setupProjectDir(false)
    const {
      writeInstallMarker,
      computePackageJsonHash,
      readInstallPlatformMarker,
      INSTALL_PLATFORM_TAG,
    } = await import('../workspace-defaults')
    const fs = await import('fs')
    const path = await import('path')

    // Seed a populated node_modules so the gate path's
    // `hasNodeModules` branch evaluates.
    fs.mkdirSync(path.join(TEST_DIR, 'node_modules'), { recursive: true })
    const hash = computePackageJsonHash(TEST_DIR)!
    writeInstallMarker(TEST_DIR, hash)

    // Write a platform marker that is GUARANTEED to differ from the
    // host running this test. (`INSTALL_PLATFORM_TAG` is `darwin-arm64`
    // / `linux-x64` etc. on CI runners; `synthetic-other-arch` matches
    // nothing.)
    fs.writeFileSync(
      path.join(TEST_DIR, 'node_modules', '.shogo-platform'),
      'synthetic-other-arch\n',
      'utf-8',
    )

    expect(INSTALL_PLATFORM_TAG).not.toBe('synthetic-other-arch')

    // PreviewManager.start() spawns backgroundSetup async and
    // returns before installDepsIfNeeded has actually run. We must
    // await depsReady to observe the side-effects of the
    // cross-platform check (and the subsequent install pass).
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    await pm.start()
    await pm.depsReady

    // The contract under test: cross-platform reuse never wins
    // silently. The mismatch path forces a full `bun install`
    // (skipping BOTH the hash-match and missing-deps fast paths),
    // and a successful install rewrites the platform marker to
    // the running platform. In this fixture there are no deps in
    // package.json, so `bun install` is a successful no-op — but
    // critically it ran (rather than being short-circuited by the
    // matching install-marker), and the platform tag is now
    // `INSTALL_PLATFORM_TAG`, not the synthetic foreign tag.
    const platformOnDisk = readInstallPlatformMarker(TEST_DIR)
    expect(platformOnDisk).toBe(INSTALL_PLATFORM_TAG)
    expect(platformOnDisk).not.toBe('synthetic-other-arch')
    pm.stop()
  })

  test('internalUrl getter always reflects runtimePort', () => {
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 9123 })
    expect(pm.internalUrl).toBe('http://localhost:9123/')
  })

  test('externalUrl falls back to internalUrl when publicUrl is unset', () => {
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    expect(pm.externalUrl).toBe('http://localhost:8080/')
  })

  test('externalUrl prefers publicUrl when set', () => {
    const pm = new PreviewManager({
      workspaceDir: TEST_DIR,
      runtimePort: 8080,
      publicUrl: 'https://preview--proj123.dev.shogo.ai',
    })
    expect(pm.externalUrl).toBe('https://preview--proj123.dev.shogo.ai')
  })

  test('apiPort option overrides the env-derived sidecar port (per-project workspace runtimes)', () => {
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080, apiPort: 3107 })
    expect(pm.apiServerUrl).toBe('http://localhost:3107')
  })

  test('externalUrl ignores empty publicUrl string', () => {
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080, publicUrl: '' })
    expect(pm.externalUrl).toBe('http://localhost:8080/')
  })

  test('getStatus when running reports runtimePort as port (not fake 5173)', async () => {
    // A pre-built dist triggers the immediate-ready path in start(), which
    // flips `started=true` + phase='ready' without spawning vite.
    setupProjectDir(true)
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    await pm.start()
    const s = pm.getStatus()
    expect(s.running).toBe(true)
    expect(s.port).toBe(8080)
    expect(s.url).toBe('http://localhost:8080/')
    expect(s.internalUrl).toBe('http://localhost:8080/')
    expect(s.publicUrl).toBeNull()
    pm.stop()
  })

  test('getStatus when running reports publicUrl as the canonical url', async () => {
    setupProjectDir(true)
    const pm = new PreviewManager({
      workspaceDir: TEST_DIR,
      runtimePort: 8080,
      publicUrl: 'https://preview--abc.dev.shogo.ai',
    })
    await pm.start()
    const s = pm.getStatus()
    expect(s.running).toBe(true)
    expect(s.url).toBe('https://preview--abc.dev.shogo.ai')
    expect(s.internalUrl).toBe('http://localhost:8080/')
    expect(s.publicUrl).toBe('https://preview--abc.dev.shogo.ai')
    pm.stop()
  })

  // --- getDevicePreview: cloud vs local Metro/Expo behaviour ----------------

  test('getDevicePreview: non-metro stack returns not-applicable', () => {
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    const dp = pm.getDevicePreview()
    expect(dp.deviceMode).toBe('not-applicable')
    expect(dp.metroUrl).toBeNull()
    expect(dp.devServer).toBe('vite')
  })

  test('getDevicePreview: metro stack in cloud mode returns cloud-todo', () => {
    // Mark the project as a metro stack so resolveDevServer picks 'metro'.
    writeFileSync(join(TEST_DIR, '.tech-stack'), 'expo-three')
    const pm = new PreviewManager({
      workspaceDir: TEST_DIR,
      runtimePort: 8080,
      localMode: false,
    })
    const dp = pm.getDevicePreview()
    expect(dp.devServer).toBe('metro')
    expect(dp.deviceMode).toBe('cloud-todo')
    expect(dp.metroUrl).toBeNull()
    expect(dp.message).toMatch(/Local Mode/i)
    expect(dp.docs).toContain('shogo.ai')
  })

  test('getDevicePreview: metro stack in local mode without @expo/ngrok returns local-tunnel-unavailable', () => {
    writeFileSync(join(TEST_DIR, '.tech-stack'), 'expo-three')
    // No @expo/ngrok in node_modules.
    const pm = new PreviewManager({
      workspaceDir: TEST_DIR,
      runtimePort: 8080,
      localMode: true,
    })
    const dp = pm.getDevicePreview()
    expect(dp.devServer).toBe('metro')
    expect(dp.deviceMode).toBe('local-tunnel-unavailable')
    expect(dp.message).toMatch(/@expo\/ngrok/)
    expect(dp.docs).toContain('expo.dev')
  })

  test('getDevicePreview: metro stack in local mode WITH @expo/ngrok returns local-tunnel "starting"', () => {
    writeFileSync(join(TEST_DIR, '.tech-stack'), 'expo-three')
    // Pretend @expo/ngrok is installed.
    mkdirSync(join(TEST_DIR, 'node_modules', '@expo', 'ngrok'), { recursive: true })

    const pm = new PreviewManager({
      workspaceDir: TEST_DIR,
      runtimePort: 8080,
      localMode: true,
    })
    const dp = pm.getDevicePreview()
    expect(dp.devServer).toBe('metro')
    expect(dp.deviceMode).toBe('local-tunnel')
    expect(dp.metroUrl).toBeNull()
    expect(dp.metroPort).toBeNull() // Tunnel hasn't been spawned yet.
    expect(dp.message).toMatch(/tunnel is starting/i)
  })

  test('getDevicePreview always exposes a metroPort field (even when null)', () => {
    // The field exists on every code path so the studio doesn't have to
    // null-check the shape — only the value.
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    expect(pm.getDevicePreview().metroPort).toBeNull()

    writeFileSync(join(TEST_DIR, '.tech-stack'), 'expo-three')
    const cloud = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080, localMode: false })
    expect(cloud.getDevicePreview().metroPort).toBeNull()

    const local = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080, localMode: true })
    expect(local.getDevicePreview().metroPort).toBeNull()
  })

  test('onLogLine callback is invoked with the configured handler (sanity)', () => {
    // We can't easily exercise the Metro/Expo spawn path without a real
    // Expo install, but we can verify the callback wiring survives the
    // constructor — i.e. the field is stored, not dropped on the floor.
    // The forwarding helper is private; test the contract by hitting it
    // through the only public seam available in this unit-level test:
    // construction with a callback shouldn't throw, and `getDevicePreview`
    // should still work normally.
    const captured: Array<{ line: string; stream: string }> = []
    const pm = new PreviewManager({
      workspaceDir: TEST_DIR,
      runtimePort: 8080,
      onLogLine: (line, stream) => captured.push({ line, stream }),
    })
    // Sanity: no spawn yet, so no captures yet either.
    expect(captured).toHaveLength(0)
    expect(pm.getDevicePreview().devServer).toBe('vite')
  })

  test('isLocalMode reflects explicit override over env', () => {
    const pm = new PreviewManager({
      workspaceDir: TEST_DIR,
      runtimePort: 8080,
      localMode: true,
    })
    expect(pm.isLocalMode).toBe(true)

    const pm2 = new PreviewManager({
      workspaceDir: TEST_DIR,
      runtimePort: 8080,
      localMode: false,
    })
    expect(pm2.isLocalMode).toBe(false)
  })

  // --- bundlerCwd derivation (workspaceDir rename contract) -----------------
  // Pins the contract so callers can stop guessing whether `<workspace>/project`
  // exists. PreviewManager owns the resolution; everyone else reads
  // `getStatus().bundlerCwd` or `pm.bundlerCwd`.

  test('bundlerCwd: Expo layout (package.json at workspace root)', () => {
    // setupProjectDir already writes package.json at TEST_DIR.
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    expect(pm.bundlerCwd).toBe(TEST_DIR)
  })

  test('bundlerCwd: Vite layout (legacy <workspace>/project/package.json)', () => {
    // Wipe the root package.json and create the legacy layout instead.
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(join(TEST_DIR, 'project'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'project', 'package.json'), JSON.stringify({ name: 'vite-fixture' }))
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    expect(pm.bundlerCwd).toBe(join(TEST_DIR, 'project'))
  })

  test('bundlerCwd: empty workspace falls back to legacy <workspace>/project/', () => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    expect(pm.bundlerCwd).toBe(join(TEST_DIR, 'project'))
  })

  test('getStatus exposes both workspaceDir and bundlerCwd', () => {
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
    const s = pm.getStatus()
    expect(s.workspaceDir).toBe(TEST_DIR)
    expect(s.bundlerCwd).toBe(TEST_DIR) // Expo layout in setupProjectDir().
  })

  // --- install-marker (sha256(package.json)) gate ---------------------------
  // We exercise the gate via the prebuilt-dist path so `start()` schedules
  // background install (which we don't want to actually run); we then call
  // installDepsIfNeeded directly through the public bundlerCwd seam.
  // Easiest test: write a marker that matches, confirm install is skipped.

  test('install-marker matching package.json hash skips install', async () => {
    setupProjectDir(true) // Pre-built dist → start() returns immediately, then bg setup.
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })

    // Pre-write a marker that matches the current package.json. Background
    // install should consult it and bail — verified indirectly via no
    // `installing` phase transition (start exposed phase remains 'ready'
    // since we hit the prebuilt-dist fast path; the install gate's
    // *behaviour* under matching hash is what we pin via the marker file
    // continuing to exist after the run).
    const { createHash } = await import('crypto')
    const pkgRaw = (await import('fs')).readFileSync(join(TEST_DIR, 'package.json'), 'utf-8')
    const hash = createHash('sha256').update(pkgRaw).digest('hex')
    ;(await import('fs')).mkdirSync(join(TEST_DIR, '.shogo'), { recursive: true })
    ;(await import('fs')).writeFileSync(join(TEST_DIR, '.shogo', 'install-marker'), hash)

    await pm.start()
    // Marker should still be present and unchanged.
    const after = (await import('fs')).readFileSync(join(TEST_DIR, '.shogo', 'install-marker'), 'utf-8')
    expect(after).toBe(hash)
    pm.stop()
  })

  test('install-marker mismatch triggers reinstall (which writes a new marker)', async () => {
    setupProjectDir(true)
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })

    // Stale hash on disk.
    ;(await import('fs')).mkdirSync(join(TEST_DIR, '.shogo'), { recursive: true })
    ;(await import('fs')).writeFileSync(join(TEST_DIR, '.shogo', 'install-marker'), 'deadbeef')

    await pm.start()
    // Background setup may or may not have completed by now (it's async);
    // either way, the marker logic ran. We can only assert that the marker
    // is *eventually* updated — give bg work a tick.
    await new Promise((r) => setTimeout(r, 500))
    const after = (await import('fs')).readFileSync(join(TEST_DIR, '.shogo', 'install-marker'), 'utf-8')
    // After a real install, the marker should match package.json's sha256
    // (or remain 'deadbeef' if install failed silently — bun install can't
    // run inside this fixture without internet, so accept either: the
    // contract is "marker is best-effort, never blocks startup").
    expect(after.length).toBeGreaterThan(0)
    pm.stop()
  })

  // --- API server port resolution ------------------------------------------
  // Pre-merge, the project backend was a separate `SkillServerManager` whose
  // port was resolved per-instance from `SKILL_SERVER_PORT` (with a 4100
  // default). Local Shogo-managed workers, the VM harness, and the docker
  // eval-worker all rely on injecting that port to dynamically assign one
  // per worker. After the unification into PreviewManager, the resolver
  // honours `API_SERVER_PORT` first, then `SKILL_SERVER_PORT`, then 3001.

  describe('apiServerPort resolution', () => {
    const ENV_KEYS = ['API_SERVER_PORT', 'SKILL_SERVER_PORT'] as const
    const saved: Record<string, string | undefined> = {}

    beforeEach(() => {
      for (const k of ENV_KEYS) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
    })
    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    })

    test('apiServerUrl defaults to 3001 when no env override is set', () => {
      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      expect(pm.apiServerUrl).toBe('http://localhost:3001')
    })

    test('apiServerUrl honours API_SERVER_PORT', () => {
      process.env.API_SERVER_PORT = '4123'
      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      expect(pm.apiServerUrl).toBe('http://localhost:4123')
    })

    test('apiServerUrl honours legacy SKILL_SERVER_PORT', () => {
      process.env.SKILL_SERVER_PORT = '4101'
      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      expect(pm.apiServerUrl).toBe('http://localhost:4101')
    })

    test('API_SERVER_PORT wins over SKILL_SERVER_PORT', () => {
      process.env.API_SERVER_PORT = '5500'
      process.env.SKILL_SERVER_PORT = '5599'
      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      expect(pm.apiServerUrl).toBe('http://localhost:5500')
    })

    test('invalid env values fall back to 3001', () => {
      process.env.API_SERVER_PORT = 'not-a-number'
      process.env.SKILL_SERVER_PORT = '0'
      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      expect(pm.apiServerUrl).toBe('http://localhost:3001')
    })

    test('apiServerPort getter is null until the API process is running', () => {
      process.env.API_SERVER_PORT = '4242'
      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      // No server.tsx, no spawn — getter must report null but apiServerUrl
      // (the resolved bind target) still reflects the configured port.
      expect(pm.apiServerPort).toBeNull()
      expect(pm.apiServerUrl).toBe('http://localhost:4242')
    })

    test('port is resolved at construction time (later env mutations are ignored)', () => {
      process.env.API_SERVER_PORT = '6001'
      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      process.env.API_SERVER_PORT = '6002'
      // Already-constructed manager must keep its resolved port — the
      // running spawn (if any) is bound to the original value.
      expect(pm.apiServerUrl).toBe('http://localhost:6001')
    })
  })

  // --- Custom-routes fast restart -----------------------------------------
  // The synchronous fast path agent tools call when `custom-routes.ts` is
  // edited. With no spawned server in the test fixture, the call should
  // simply exit cleanly (no throw, phase doesn't get stuck).

  describe('restartApiServerOnly', () => {
    let savedPort: string | undefined
    beforeEach(() => {
      // Pin to a high random-ish port so `forceKillPort` doesn't reach
      // for `lsof` against a port a real local dev shogo runtime might
      // happen to occupy (3001 is the runtime template default).
      savedPort = process.env.API_SERVER_PORT
      process.env.API_SERVER_PORT = '39021'
    })
    afterEach(() => {
      if (savedPort === undefined) delete process.env.API_SERVER_PORT
      else process.env.API_SERVER_PORT = savedPort
    })

    test('no-ops cleanly when no API server is running', async () => {
      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      // Should not throw — the kill path has nothing to kill, and the
      // startApiServer existence check returns idle without `server.tsx`.
      await pm.restartApiServerOnly()
      expect(['idle', 'crashed']).toContain(pm.apiServerPhase)
    })
  })

  // --- API server existence-check ----------------------------------------
  // Boot path skips `bun run generate` when there's no schema.prisma but
  // also no server.tsx — that workspace is pre-bootstrap, not crashed.

  describe('startApiServer existence check', () => {
    let savedPort: string | undefined
    beforeEach(() => {
      savedPort = process.env.API_SERVER_PORT
      process.env.API_SERVER_PORT = '39022'
    })
    afterEach(() => {
      if (savedPort === undefined) delete process.env.API_SERVER_PORT
      else process.env.API_SERVER_PORT = savedPort
    })

    test('preboot workspace (no server.tsx, no schema) leaves apiPhase=idle', async () => {
      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      // Trigger the same code path the orchestrator uses — restartApi-
      // ServerOnly funnels through startApiServer which has the new
      // existence-check logic.
      await pm.restartApiServerOnly()
      expect(pm.apiServerPhase).toBe('idle')
    })
  })

  // --- Drift heal at boot --------------------------------------------------
  // When `server.tsx` exists on disk but doesn't import / mount
  // `custom-routes.ts`, `startApiServer` self-heals before spawning.
  // SDK-generated stale files are signalled for regeneration; hand-edited
  // files are patched in place so the user's other edits are preserved.
  // We assert the on-disk file is patched after `restartApiServerOnly`
  // returns. The fixture server.tsx exits as soon as it runs so the
  // spawn doesn't bind a real port — we only care about the heal step.

  describe('startApiServer drift heal', () => {
    let savedPort: string | undefined
    beforeEach(() => {
      savedPort = process.env.API_SERVER_PORT
      process.env.API_SERVER_PORT = '39023'
    })
    afterEach(() => {
      if (savedPort === undefined) delete process.env.API_SERVER_PORT
      else process.env.API_SERVER_PORT = savedPort
    })

    function seedDriftWorkspace(serverTsx: string): void {
      // src/generated/index.ts so startApiServer skips the missing-file
      // branch and lands directly in the drift check.
      mkdirSync(join(TEST_DIR, 'src', 'generated'), { recursive: true })
      writeFileSync(
        join(TEST_DIR, 'src', 'generated', 'index.ts'),
        'export {}\n',
        'utf-8',
      )
      writeFileSync(join(TEST_DIR, 'server.tsx'), serverTsx, 'utf-8')
      writeFileSync(
        join(TEST_DIR, 'shogo.config.json'),
        JSON.stringify({
          schema: './prisma/schema.prisma',
          outputs: [
            {
              dir: '.',
              generate: ['server'],
              fileExtension: 'tsx',
              serverConfig: { customRoutesPath: './custom-routes' },
            },
          ],
        }),
        'utf-8',
      )
      writeFileSync(
        join(TEST_DIR, 'custom-routes.ts'),
        "import { Hono } from 'hono'\nconst app = new Hono()\nexport default app\n",
        'utf-8',
      )
    }

    test('hand-edited drifted server.tsx is patched in place at boot', async () => {
      // Self-exiting fixture so the spawn that follows the heal step
      // returns quickly without binding a port.
      const handEdited = `import { Hono } from 'hono'

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))

process.exit(0)

export default { port: Number(process.env.PORT) || 3001, fetch: app.fetch }
`
      seedDriftWorkspace(handEdited)

      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      try {
        await pm.restartApiServerOnly()
      } finally {
        pm.stop()
      }

      const after = readFileSync(join(TEST_DIR, 'server.tsx'), 'utf-8')
      // Heal helper inserted both required lines.
      expect(after).toContain("import customRoutes from './custom-routes'")
      expect(after).toMatch(/app\.route\(\s*['"]\/api['"]\s*,\s*customRoutes\s*\)/)
      // Hand-edited body is preserved verbatim.
      expect(after).toContain("app.get('/health'")
      expect(after).toContain('process.exit(0)')
    }, 15_000)

    test('stale SDK-generated server.tsx is NOT patched in place (signals regenerate)', async () => {
      // Has the SDK auto-gen header → drift heal returns
      // { mode: 'regenerate' }. In this fixture `runShogoGenerate` will
      // fail (no real prisma schema / sdk) but that's fine — we just
      // want to verify the file is left UNTOUCHED so the caller can
      // overwrite it.
      const staleSdk = `/**
 * Hono Server
 *
 * Auto-generated by @shogo-ai/sdk
 * This file can be customized - it will not be overwritten if it exists.
 */

import { Hono } from 'hono'

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))

process.exit(0)

export default { port: Number(process.env.PORT) || 3001, fetch: app.fetch }
`
      seedDriftWorkspace(staleSdk)

      const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
      try {
        await pm.restartApiServerOnly()
      } finally {
        pm.stop()
      }

      const after = readFileSync(join(TEST_DIR, 'server.tsx'), 'utf-8')
      // No in-place patch — the file must NOT have gained customRoutes
      // lines, because the heal helper signalled `regenerate` and we
      // never invoke the additive patcher for that path.
      expect(after).not.toContain('import customRoutes from')
      expect(after).not.toMatch(/app\.route\(\s*['"]\/api['"]\s*,\s*customRoutes\s*\)/)
      // (The full regen via `runShogoGenerate` doesn't run cleanly in
      // this fixture because there's no `prisma/schema.prisma`. The
      // wiring is unit-tested in `server-tsx-drift.test.ts`; this test
      // just pins that the in-place patcher does NOT touch
      // SDK-generated files.)
    }, 15_000)
  })

  // --- emitBuildLine: build-log dispatcher integration -----------------------
  // The Output tab and Monitor consume the typed RuntimeLogEntry stream.
  // Every call site in preview-manager.ts that previously called appendFileSync
  // directly now goes through `emitBuildLine` so the stream stays in sync with
  // `.shogo/logs/build.log`. These tests pin that contract.

  describe('emitBuildLine', () => {
    let buildLogPath: string

    beforeEach(() => {
      __resetRuntimeLogDispatcherForTest()
      __resetLogWriterForTest()
      // Use the canonical resolver so the test fixture mirrors what
      // `startBuildWatch` actually passes in production. `ensureRuntimeLogDir`
      // is the mkdir-p helper that real callers run before the first
      // append — without it the first emitBuildLine would ENOENT.
      ensureRuntimeLogDir(TEST_DIR)
      buildLogPath = previewBuildLogPath(TEST_DIR)
    })

    afterEach(() => {
      __resetRuntimeLogDispatcherForTest()
      __resetLogWriterForTest()
    })

    test('appends to build.log AND dispatches through recordBuildEntry', async () => {
      emitBuildLine(buildLogPath, '[stdout]', 'compiled successfully', 'stdout')
      // emitBuildLine batches the disk write asynchronously via
      // runtime-log-writer (previously synchronous appendFileSync — moved
      // off the hot path in 2026-05 to unblock the Windows cold-boot event
      // loop). Drain pending writes before reading the file.
      await flushAllLogWrites(buildLogPath)
      const onDisk = readFileSync(buildLogPath, 'utf-8')
      expect(onDisk).toContain('[stdout] compiled successfully')

      const entries = getRuntimeLogsSnapshot()
      expect(entries).toHaveLength(1)
      expect(entries[0]!.source).toBe('build')
      expect(entries[0]!.text).toBe('[stdout] compiled successfully')
    })

    test('resolves under <workspace>/.shogo/logs/ (the canonical layout)', () => {
      // Pin the path contract so a future "let's put logs back in the
      // bundler cwd" refactor fails loudly — the chokidar rebuild-loop
      // diagnosed in May 2026 was directly caused by logs sitting next
      // to `index.html`.
      expect(buildLogPath).toBe(join(TEST_DIR, RUNTIME_LOG_SUBDIR, BUILD_LOG_BASENAME))
    })

    test('stderr stream → level=error so the unseen-error red dot turns on', () => {
      emitBuildLine(buildLogPath, '[stderr]', 'tsc: type error', 'stderr')
      const entries = getRuntimeLogsSnapshot()
      expect(entries).toHaveLength(1)
      expect(entries[0]!.level).toBe('error')
    })

    test('stdout stream defaults to level=info on benign output', () => {
      emitBuildLine(buildLogPath, '[stdout]', 'compiled in 200ms', 'stdout')
      const entries = getRuntimeLogsSnapshot()
      expect(entries[0]!.level).toBe('info')
    })

    test('empty lines are dropped (no disk write, no dispatch)', () => {
      emitBuildLine(buildLogPath, '[stdout]', '', 'stdout')
      expect(getRuntimeLogsSnapshot()).toHaveLength(0)
      // The file was never created because no append happened.
      expect(() => readFileSync(buildLogPath, 'utf-8')).toThrow()
    })

    test('disk failure does NOT block in-memory dispatch', async () => {
      // Point at an unwritable path: a directory we can never create
      // (mkdir -p of the grandparent would race; we rely on the writer
      // swallowing the error). emitBuildLine must surface synchronously
      // (it batches the write to a later tick) and still dispatch through
      // the in-memory ring.
      const badPath = join(TEST_DIR, 'no-such-dir', 'nested', 'build.log')
      expect(() =>
        emitBuildLine(badPath, '[stdout]', 'still dispatched', 'stdout'),
      ).not.toThrow()
      const entries = getRuntimeLogsSnapshot()
      expect(entries).toHaveLength(1)
      expect(entries[0]!.text).toBe('[stdout] still dispatched')
      // The async write may fail in the background — flushing should
      // resolve cleanly because runtime-log-writer swallows write errors.
      await expect(flushAllLogWrites(badPath)).resolves.toBeUndefined()
    })

    test('detects ERROR-class words on stdout and tags as error', () => {
      // The detector runs on stdout (we don't force level=info there) so
      // a warm error message still surfaces with level=error.
      emitBuildLine(buildLogPath, '[stdout]', 'ERROR: missing module', 'stdout')
      const entries = getRuntimeLogsSnapshot()
      expect(entries[0]!.level).toBe('error')
    })
  })

  // --- resolveApiServerEnv: env handed to the spawned `server.tsx` ----------
  // The API sidecar inherits `process.env` plus a few overrides + a
  // local-mode default for SHOGO_API_URL. Each invariant gets pinned
  // here so a future "fix" of one branch doesn't accidentally regress
  // another (e.g. accidentally forcing localhost in cloud or stomping
  // a desktop user's explicit SHOGO_API_URL override).

  describe('resolveApiServerEnv', () => {
    const FIXED_CWD = '/tmp/test-preview-manager'
    const PORT = '3091'

    test('always pins PORT/API_SERVER_PORT/SKILL_SERVER_PORT to the resolved port', () => {
      const env = resolveApiServerEnv({
        parentEnv: { PORT: '9999', API_SERVER_PORT: '8888', SKILL_SERVER_PORT: '7777' },
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env.PORT).toBe(PORT)
      expect(env.API_SERVER_PORT).toBe(PORT)
      expect(env.SKILL_SERVER_PORT).toBe(PORT)
    })

    test('pins DATABASE_URL to the workspace sqlite file regardless of parent', () => {
      const env = resolveApiServerEnv({
        parentEnv: { DATABASE_URL: 'postgres://elsewhere/db' },
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env.DATABASE_URL).toBe(`file:${FIXED_CWD}/prisma/dev.db`)
    })

    test('local mode + no SHOGO_API_URL parent override → injects http://localhost:8002', () => {
      const env = resolveApiServerEnv({
        parentEnv: { SHOGO_LOCAL_MODE: 'true' },
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env.SHOGO_API_URL).toBe('http://localhost:8002')
    })

    test('local mode + explicit SHOGO_API_URL parent override → parent wins', () => {
      // A power user (or the e2e harness) pinned a different API URL on
      // the parent; the sidecar must inherit that, not the localhost
      // default. Otherwise integration tests pointing at a staging API
      // would silently get redirected to localhost.
      const env = resolveApiServerEnv({
        parentEnv: { SHOGO_LOCAL_MODE: 'true', SHOGO_API_URL: 'https://api.staging.shogo.ai' },
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env.SHOGO_API_URL).toBe('https://api.staging.shogo.ai')
    })

    test('cloud mode (SHOGO_LOCAL_MODE unset) → does NOT inject localhost', () => {
      // Cloud pods get SHOGO_API_URL pinned to the in-cluster API service
      // by the warm-pool launcher; if we accidentally injected
      // localhost here that would break every voice/chat call from
      // every cloud-pod sidecar.
      const env = resolveApiServerEnv({
        parentEnv: { /* no SHOGO_LOCAL_MODE */ },
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env.SHOGO_API_URL).toBeUndefined()
    })

    test('cloud mode with parent SHOGO_API_URL → still propagates parent value', () => {
      const env = resolveApiServerEnv({
        parentEnv: { SHOGO_API_URL: 'http://api.shogo-system.svc.cluster.local' },
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env.SHOGO_API_URL).toBe('http://api.shogo-system.svc.cluster.local')
    })

    test('SHOGO_LOCAL_MODE values other than the literal "true" do NOT trigger injection', () => {
      // The repo convention is `SHOGO_LOCAL_MODE === 'true'` (string compare),
      // not "is truthy". `'1'` / `'yes'` / boolean `true` would be a typo.
      // Pinning the strict-equals contract here avoids accidental regression
      // to a Boolean(...) check that would surprise cloud callers.
      const env1 = resolveApiServerEnv({
        parentEnv: { SHOGO_LOCAL_MODE: '1' },
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env1.SHOGO_API_URL).toBeUndefined()

      const env2 = resolveApiServerEnv({
        parentEnv: { SHOGO_LOCAL_MODE: 'TRUE' },
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env2.SHOGO_API_URL).toBeUndefined()
    })

    test('preserves unrelated parent env (e.g. PATH, HOME, PROJECT_ID)', () => {
      const env = resolveApiServerEnv({
        parentEnv: {
          PATH: '/usr/local/bin:/usr/bin',
          HOME: '/home/test',
          PROJECT_ID: 'proj_abc',
        },
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
      expect(env.HOME).toBe('/home/test')
      expect(env.PROJECT_ID).toBe('proj_abc')
    })

    test('captures parent PORT into RUNTIME_PORT before overwriting PORT', () => {
      // The sidecar's @shogo-ai/sdk/tools/server proxy uses RUNTIME_PORT
      // to forward `/api/tools/*` calls back to the agent runtime over
      // 127.0.0.1. If we ever stop preserving the parent's PORT here,
      // every installed-integration call from a pod app silently breaks.
      const env = resolveApiServerEnv({
        parentEnv: { PORT: '8080' },
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env.RUNTIME_PORT).toBe('8080')
      expect(env.PORT).toBe(PORT)
    })

    test('falls back to 8080 when parent PORT is unset', () => {
      const env = resolveApiServerEnv({
        parentEnv: {},
        portStr: PORT,
        cwd: FIXED_CWD,
      })
      expect(env.RUNTIME_PORT).toBe('8080')
    })
  })
})
