// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guard: MobileHomeFeed Recent chats section structure (AC §7).
 *
 * Verifies that the feed's data model and renderItem support the
 * 'recent-chat' kind added in SHO-473 so a reviewer can't remove it
 * without this test breaking.
 *
 *   bun test apps/mobile/components/home/__tests__/home-feed-recent-chats.guard.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const MOBILE = join(import.meta.dir, '../../..')
const read = (relative: string) => readFileSync(join(MOBILE, relative), 'utf8')

describe('MobileHomeFeed — Recent chats section (SHO-473)', () => {
  const feed = read('components/home/MobileHomeFeed.tsx')

  test("'recent-chat' is a named kind in the HomeRow union", () => {
    expect(feed).toContain("'recent-chat'")
    expect(feed).toMatch(/kind:\s*'recent-chat'/)
  })

  test('the feed imports and uses useRecentAgentChats', () => {
    expect(feed).toContain('useRecentAgentChats')
    expect(feed).toContain('recentAgentChats')
  })

  test('there is a recent-chats section pushed into sections when list is non-empty', () => {
    expect(feed).toContain("'recent-chats'")
    expect(feed).toMatch(/key:\s*'recent-chats'/)
    expect(feed).toMatch(/recentAgentChats\.length\s*>\s*0/)
  })

  test('renderItem handles the recent-chat case', () => {
    expect(feed).toContain("case 'recent-chat'")
    expect(feed).toContain('agentChatRoute')
  })

  test('recent-chats section is built before agents-section (top of feed)', () => {
    const rcIdx = feed.indexOf("key: 'recent-chats'")
    const asIdx = feed.indexOf("key: 'agents-section'")
    expect(rcIdx).toBeGreaterThan(-1)
    expect(asIdx).toBeGreaterThan(-1)
    expect(rcIdx).toBeLessThan(asIdx)
  })

  test('AgentAvatar is used in the recent-chat row', () => {
    expect(feed).toContain('AgentAvatar')
  })

  test("'All' action points to DMs with agents filter", () => {
    expect(feed).toContain('filter')
    expect(feed).toContain('agents')
    // The 'All' header action pushes a DMs route with filter=agents param.
    expect(feed).toMatch(/dms.*filter.*agents|filter.*agents.*dms/s)
  })
})
