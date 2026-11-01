// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A restored chat tab that is not on screen must not run its own timers
 * (SHO-277).
 *
 * Every chat tab the project layout has open at the same time stays mounted, so
 * switching tabs does not lose scroll position or the draft. Each mounted
 * `ChatPanel` also ran a stall watchdog (`setInterval`, 15 s) and, when anything
 * was queued offline, a connectivity drain (`setInterval`, 10 s). With four
 * tabs open that is eight timers doing work for nothing, on the same machine
 * and the same event loop the visible chat's stream is using.
 *
 * The fix is `isActive` (already passed by the tab layout, already used to gate
 * quick actions) now gating both effects. This is the fast half: the structure
 * that makes it true. `apps/desktop/e2e/streaming/nav-under-load.spec.ts`
 * measures the live cost.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const MOBILE = join(import.meta.dir, '../../..')
const read = (relative: string) => readFileSync(join(MOBILE, relative), 'utf8')

describe('hidden chat tabs run no intervals', () => {
  const panel = read('components/chat/ChatPanel.tsx')
  const layout = read('app/(app)/projects/[id]/_layout.tsx')

  test('the offline drain is gated on the panel being visible', () => {
    const drain = panel.slice(panel.indexOf('const hasOfflineQueued ='))
    const gate = drain.indexOf('if (!isActive) return')
    expect(gate).toBeGreaterThan(-1)
    // The gate comes before the interval that polls connectivity.
    expect(gate).toBeLessThan(drain.indexOf('setInterval('))
    // And the effect re-runs when the tab is shown again, so the drain happens
    // on return instead of never.
    expect(drain.slice(0, drain.indexOf('])'))).toContain('isActive,')
  })

  test('the stall watchdog is gated on the panel being visible', () => {
    // `Stall watchdog` appears twice (a ref comment near the top, the effect
    // itself further down); the effect is the last one.
    const watchdog = panel.slice(panel.lastIndexOf('Stall watchdog'))
    const gate = watchdog.indexOf('if (!isStreaming || !isActive) return')
    expect(gate).toBeGreaterThan(-1)
    // The gate is the first thing the watchdog effect does, before its interval.
    expect(gate).toBeLessThan(watchdog.indexOf('setInterval('))
  })

  test('the tab layout tells each panel whether it is the visible one', () => {
    expect(layout).toContain('isActive={isActive}')
    // The hidden tabs stay mounted (that is what keeps scroll and drafts); they
    // are only made non-interactive.
    expect(layout).toContain('pointerEvents={isActive ? "auto" : "none"}')
  })
})
