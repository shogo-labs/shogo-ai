// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Home on a phone must stay a virtualized list (SHO-220).
 *
 * The feed used to be a `ScrollView` that mapped every section and every row,
 * so a workspace with 150 channels and 150 projects mounted 300 rows before the
 * first paint — on a phone, behind a drawer that stayed mounted too. The fix is
 * a `SectionList`, and the risk is that the next feature quietly turns it back
 * into a `ScrollView` (a section header that needs to be sticky, a row that
 * wants to span sections) and nobody notices until a big workspace janks.
 *
 * `e2e/local/team-home-phone-perf.test.ts` proves the live behaviour on a
 * 150/150/150 workspace. This is the fast, deterministic half: the structure
 * that makes it true, and rows that do not each subscribe to the window size.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const MOBILE = join(import.meta.dir, '../../..')
const read = (relative: string) => readFileSync(join(MOBILE, relative), 'utf8')

describe('Home feed is a virtualized list', () => {
  const feed = read('components/home/MobileHomeFeed.tsx')

  test('it renders a SectionList, not a ScrollView over every row', () => {
    expect(feed).toMatch(/from 'react-native'/)
    expect(feed).toMatch(/\bSectionList\b/)
    expect(feed).toContain('<SectionList')
    // The scroller this replaced.
    expect(feed).not.toContain('TabScreenScrollView')
    expect(feed).not.toMatch(/<ScrollView/)
  })

  test('the window is bounded rather than left to the default', () => {
    expect(feed).toMatch(/initialNumToRender=\{?\d+/)
    expect(feed).toMatch(/maxToRenderPerBatch=\{?\d+/)
    expect(feed).toMatch(/windowSize=\{?\d+/)
  })

  test('rows are rendered from one flat section model', () => {
    // Sections carry data, not JSX: the list decides what is mounted.
    expect(feed).toMatch(/interface HomeSection/)
    expect(feed).toMatch(/data: HomeRow\[\]/)
    expect(feed).toMatch(/renderSectionHeader=/)
    expect(feed).toMatch(/keyExtractor=/)
  })
})

describe('rows do not each subscribe to the window size', () => {
  test('ConversationRowView takes `comfortable` instead of calling the hook', () => {
    const rows = read('components/team-chat/ConversationRows.tsx')
    const start = rows.indexOf('export const ConversationRowView')
    expect(start).toBeGreaterThan(-1)
    // Up to the wrapper that resolves the hook once.
    const view = rows.slice(start, rows.indexOf('export function ConversationRow('))
    expect(view).not.toContain('usePhoneLayout()')
    expect(view).toContain('comfortable: boolean')
    // The wrapper keeps the old single-row call sites working.
    expect(rows.slice(rows.indexOf('export function ConversationRow('))).toContain('usePhoneLayout()')
  })

  test('the feed resolves `comfortable` once and passes it down', () => {
    const feed = read('components/home/MobileHomeFeed.tsx')
    // One call in the component body, not inside renderItem's per-row JSX.
    expect(feed.match(/usePhoneLayout\(\)/g)?.length).toBe(1)
    expect(feed).toMatch(/comfortable=\{comfortable\}/)
  })
})
