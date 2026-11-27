// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-600: nothing draws the buddy when nobody can see it.
 *
 * Three host-side facts that no render test can see, because they live in the
 * bridge between React Native and the WebView:
 *
 *  1. The hidden `BuddySnapshotHost` boots still. It used to boot the *full*
 *     animation and run it from app launch until the first avatar asked for a
 *     picture.
 *  2. `webview-entry` honours props that were injected before the document
 *     loaded, so that boot state is real from the first frame.
 *  3. Both loops sleep while the engine rests (`resting` / `msUntilWake`) and
 *     draw an idle character at a low rate instead of 60 fps.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BUDDY_WEBVIEW_HTML } from '../buddy/buddy-webview.generated'

const MOBILE = join(import.meta.dir, '../../..')
const read = (relative: string) => readFileSync(join(MOBILE, relative), 'utf8')

describe('the hidden snapshot renderer', () => {
  const host = read('components/team-chat/BuddySnapshotHost.tsx')

  test('boots still, before the page script runs', () => {
    expect(host).toMatch(/injectedJavaScriptBeforeContentLoaded=\{BOOT_STILL\}/)
    expect(host).toMatch(/__shogoBuddyInitialProps=\{[^}]*still:true[^}]*\}/)
    expect(host).toMatch(/reducedMotion:true/)
  })

  test('the entry reads those boot props', () => {
    const entry = read('components/island/buddy/webview-entry.ts')
    expect(entry).toContain('__shogoBuddyInitialProps')
    // Merged over the defaults, so a still boot stays still from frame one.
    expect(entry).toMatch(/\.\.\.defaults,\s*\n\s*\.\.\.boot,/)
    // Regenerated: the checked-in bundle carries the same read.
    expect(BUDDY_WEBVIEW_HTML).toContain('__shogoBuddyInitialProps')
  })
})

describe('both render loops', () => {
  const web = read('components/island/buddy/ShogoBuddy.tsx')
  const entry = read('components/island/buddy/webview-entry.ts')

  test('draw an idle character at AMBIENT_FRAME_MS instead of every frame', () => {
    for (const source of [web, entry]) {
      expect(source).toMatch(/engine\.idleAmbient/)
      expect(source).toContain('AMBIENT_FRAME_MS')
    }
  })

  test('sleep while the engine rests, and wake for the next blink', () => {
    for (const source of [web, entry]) {
      expect(source).toContain('engine.msUntilWake()')
      expect(source).toContain('engine.resting')
    }
  })

  test('the header avatar is told to hold a frame when it cannot be seen', () => {
    const avatar = read('components/personal/WorkspaceAgentAvatar.tsx')
    expect(avatar).toContain('useBuddyStill')
    expect(avatar).toMatch(/still=\{still\}/)
    // And the engine honours it on the WebView path too.
    expect(web).toMatch(/nativePropsJson[\s\S]{0,400}still,/)
  })
})
