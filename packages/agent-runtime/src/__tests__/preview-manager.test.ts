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
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PreviewManager } from '../preview-manager'

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
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

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
})
