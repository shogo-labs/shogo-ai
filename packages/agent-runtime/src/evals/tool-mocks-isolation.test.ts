// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Eval-mock fixture-isolation tests.
 *
 * Locks in two correctness contracts that prevent the bucket-E failure
 * mode from the MiMo eval analysis (where BrightPath nonprofit's
 * calendar returned Pixel & Co. agency events):
 *
 * 1. The track-specific mock maps that spread `BUSINESS_USER_MOCKS` MUST
 *    override the calendar (and other agency-flavored) fixtures so an
 *    eval running on the nonprofit / event-planner track never sees
 *    Pixel & Co. data.
 *
 * 2. The eval-runner mock-install pipeline (`compileInstallBody` →
 *    gateway `setToolMocks`) replaces the previous mock set rather than
 *    merging into it — so a stale mock from eval N-1 cannot accidentally
 *    answer a tool call in eval N.
 */

import { describe, test, expect } from 'bun:test'
import {
  BUSINESS_USER_MOCKS,
  NONPROFIT_MOCKS,
  EVENT_PLANNER_MOCKS,
} from './tool-mocks'

function pixelCalendarSummaries(): string[] {
  const fix = BUSINESS_USER_MOCKS.GOOGLECALENDAR_FIND_EVENTS as { type: 'static'; response: { events: Array<{ summary: string }> } }
  return fix.response.events.map(e => e.summary)
}

describe('Track mocks override agency-flavored fixtures', () => {
  test('BUSINESS_USER_MOCKS still has the canonical Pixel events (sanity)', () => {
    const summaries = pixelCalendarSummaries()
    expect(summaries.some(s => /pixel|acme|luxe/i.test(s))).toBe(true)
  })

  test('NONPROFIT_MOCKS calendar fixture does NOT leak Pixel events', () => {
    const fix = NONPROFIT_MOCKS.GOOGLECALENDAR_FIND_EVENTS as { type: 'static'; response: { events: Array<{ summary: string; attendees: string[] }> } }
    expect(fix).toBeDefined()
    const summaries = fix.response.events.map(e => e.summary)
    // The override MUST replace, not append — no Pixel/Acme/Luxe entries.
    for (const s of summaries) {
      expect(s).not.toMatch(/pixel|acme|luxe/i)
    }
    // And must include something nonprofit-context-relevant so the
    // override actually serves the eval's purpose.
    const allText = JSON.stringify(fix.response).toLowerCase()
    expect(allText).toMatch(/brightpath|grant|volunteer|coordinator/)
  })

  test('EVENT_PLANNER_MOCKS calendar fixture does NOT leak Pixel events', () => {
    const fix = EVENT_PLANNER_MOCKS.GOOGLECALENDAR_FIND_EVENTS as { type: 'static'; response: { events: Array<{ summary: string }> } }
    expect(fix).toBeDefined()
    const summaries = fix.response.events.map(e => e.summary)
    for (const s of summaries) {
      expect(s).not.toMatch(/pixel|acme|luxe/i)
    }
    const allText = JSON.stringify(fix.response).toLowerCase()
    expect(allText).toMatch(/stellar|catering|venue|tasting|wedding/)
  })

  test('NONPROFIT_MOCKS does not surface agency GitHub repo data', () => {
    const repos = NONPROFIT_MOCKS.GITHUB_LIST_REPOS as { type: 'static'; response: { repos: any[] } }
    expect(repos).toBeDefined()
    expect(repos.response.repos).toEqual([])
  })

  test('EVENT_PLANNER_MOCKS does not surface agency GitHub repo data', () => {
    const repos = EVENT_PLANNER_MOCKS.GITHUB_LIST_REPOS as { type: 'static'; response: { repos: any[] } }
    expect(repos).toBeDefined()
    expect(repos.response.repos).toEqual([])
  })
})

describe('Mock install replaces rather than merges (gateway setToolMocks contract)', () => {
  // We don't spin up the full gateway here — the installation pipeline
  // is exercised by other tests. This locks in the function-level
  // contract that whatever `compileInstallBody` returns gets handed to
  // `setToolMocks`, which (per gateway.ts) calls `.clear()` first.
  // If anyone refactors the POST handler to merge into the existing map
  // instead, this test plus the tool-mocks-runtime tests catch it.

  test('compileInstallBody returns an envelope ready for setToolMocks (no merge state)', async () => {
    const { compileInstallBody } = await import('./tool-mocks-runtime')
    const compiledA = compileInstallBody({ FOO: { type: 'static', response: { tag: 'A' } } })
    const compiledB = compileInstallBody({ BAR: { type: 'static', response: { tag: 'B' } } })

    // Sanity: compileInstallBody is pure and returns disjoint maps.
    expect(Object.keys(compiledA.fns)).toEqual(['FOO'])
    expect(Object.keys(compiledB.fns)).toEqual(['BAR'])
    expect((compiledA.fns as any).BAR).toBeUndefined()
    expect((compiledB.fns as any).FOO).toBeUndefined()

    // The runtime `setToolMocks` (in gateway.ts) is responsible for
    // clearing the previous map before installing the new one. We
    // assert that contract via a structural check on the source: the
    // function literally calls `.clear()` on each of its maps before
    // populating them.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const gatewayPath = path.resolve(__dirname, '..', 'gateway.ts')
    const src = fs.readFileSync(gatewayPath, 'utf-8')
    const setToolMocksMatch = src.match(/setToolMocks\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/)
    expect(setToolMocksMatch).toBeTruthy()
    const body = setToolMocksMatch![1]
    expect(body).toContain('this.toolMocks.clear()')
    expect(body).toContain('this.syntheticTools.clear()')
    expect(body).toContain('this.hiddenMockTools.clear()')
  })
})
