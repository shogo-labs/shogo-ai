// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-600: the invariants that keep a channel cheap, stated where a future
 * change will trip over them.
 *
 * Each one was a measured cost on a 4×-slowed phone: a composer that rebuilt
 * its ~200 hooks on every streamed delta, a dock pill that re-rendered per
 * event for a badge that had not moved, and a timestamp formatter built from
 * scratch for every row on every scroll step.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const MOBILE = join(import.meta.dir, '../../..')
const read = (relative: string) => readFileSync(join(MOBILE, relative), 'utf8')

describe('the channel chrome stays out of a delta', () => {
  test('the composer is memoised, so its hooks do not run with the pane', () => {
    expect(read('components/team-chat/Composer.tsx')).toContain('export const Composer = memo(ComposerImpl)')
  })

  test('the dock pill only re-renders for a badge or dot change', () => {
    expect(read('components/layout/GlassTabRow.tsx')).toContain('export const GlassTabRow = memo(GlassTabRowImpl)')
    const dock = read('components/layout/TeamDock.tsx')
    expect(dock).toMatch(/const items = useMemo\(/)
    expect(dock).toMatch(/\[activity, activityDot, dms, router\]/)
  })

  test('markdown is memoised', () => {
    expect(read('components/chat/ChatMarkdown.tsx')).toContain('export const ChatMarkdown = memo(')
  })
})

describe('a live reply reaches only its own row', () => {
  const list = read('components/team-chat/MessageList.tsx')

  test('the list does not hand the streaming map to its rows', () => {
    expect(list).not.toMatch(/streaming=\{state\.streaming\[/)
    // …nor rebuild `renderItem` when the map changes.
    expect(list).not.toMatch(/\[\s*me, names, mentionables, channelMemberIds, state\.streaming/)
    expect(list).toContain('streamingStore.current?.set(state.streaming)')
  })

  test('a row subscribes to its own entry', () => {
    expect(read('components/team-chat/MessageRow.tsx')).toContain('useStreamingEntry(message.id)')
  })
})

describe('timestamps are formatted once, not per scroll step', () => {
  const time = read('lib/team-chat-time.ts')

  test('the formatters are built at module load', () => {
    expect(time).toMatch(/const TIME = timeFormat\(/)
    expect(time).toMatch(/const FULL_TIME = timeFormat\(/)
    // Two constructors, both at module load: a per-call one is what cost
    // 118 ms of self time on Hermes.
    expect(time.match(/new Intl\.DateTimeFormat\(/g)?.length).toBe(2)
    expect(time).not.toContain('.toLocaleTimeString(')
    expect(time).not.toContain('.toLocaleDateString(')
  })

  test('rows reuse a cached label', () => {
    const row = read('components/team-chat/MessageRow.tsx')
    expect(row).toContain('rowTimeLabel(message.createdAt)')
    expect(row).not.toMatch(/formatTime\(message\.createdAt\)/)
  })
})
