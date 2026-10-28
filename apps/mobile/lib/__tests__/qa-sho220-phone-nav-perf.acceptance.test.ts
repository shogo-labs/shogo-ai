// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-220 acceptance guard (QA round 1).
 *
 * Four properties of the phone work that are cheap to state and expensive to
 * lose, and that no rtl test covers because the surfaces involved are a route
 * layout, a header slot and a pure reducer:
 *
 * 1. **Back is wired on web as well as native.** `ProjectTopBar` renders
 *    `NativePhoneHeader` on `isPhoneLayout(width)`, which on web is simply
 *    `width <= 767` — so a narrow web viewport paints the same arrow, and a
 *    handler gated on `Platform.OS !== "web"` is a dead control on the surface
 *    Russell named ("phone / phone web"). Wide web and desktop never render it,
 *    so one handler for every platform is correct.
 * 2. **The workspace avatar is Home's only sidebar button.** No other screen
 *    passes a `leading` control, so nothing else can grow a menu button.
 * 3. **The sidebar sheet is not mounted until the drawer opens.**
 * 4. **The conversation list updates in place**: only the conversation the
 *    event touched gets a new reference, so 150 rows do not re-render on every
 *    message.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { applyListEvent } from '../team-chat-state'
import type { ChatMessage, ConversationSummary } from '../team-chat-api'

const MOBILE = join(import.meta.dir, '../..')
const read = (relative: string) => readFileSync(join(MOBILE, relative), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.expo') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(entry)) out.push(full)
  }
  return out
}

describe('a project is a screen you go into, on every platform', () => {
  const layout = read('app/(app)/projects/[id]/_layout.tsx')

  test('Back is wired on web as well as native', () => {
    // The handler exists…
    expect(layout).toMatch(/onBack:\s*\(\)\s*=>\s*\{/)
    // …pops when there is something to pop…
    expect(layout).toMatch(/router\.canGoBack\(\)/)
    expect(layout).toMatch(/router\.back\(\)/)
    // …and falls back to Home rather than nowhere.
    expect(layout).toContain('/(app)/home')
  })

  test('it is not gated on the platform', () => {
    // The round-1 blocker: `onBack: Platform.OS !== "web" ? … : undefined`.
    expect(layout).not.toMatch(/onBack:\s*\n?\s*Platform\.OS/)
    expect(layout).not.toMatch(/onBack:[\s\S]{0,120}Platform\.OS\s*!==\s*"web"/)
    expect(layout).not.toMatch(/onBack:\s*undefined/)
  })

  test('the header that renders it is chosen by width, not by platform', () => {
    // Why the gate was wrong: this header shows on web too.
    const topbar = read('components/project/ProjectTopBar.tsx')
    expect(topbar).toMatch(/isPhoneLayout\(/)
    expect(topbar).toMatch(/NativePhoneHeader/)
    // And it renders a real arrow, not a hamburger.
    const header = read('components/project/topbar/native/NativePhoneHeader.tsx')
    expect(header).toContain('project-native-back')
    // A back arrow, not a hamburger: the lucide `Menu` icon is gone from it.
    expect(header).toMatch(/icon=\{ArrowLeft\}/)
    expect(header).not.toMatch(/^\s*Menu,$/m)
  })
})

describe("the workspace avatar is Home's only sidebar button", () => {
  test('no screen other than the Home feed passes a `leading` control', () => {
    const files = [
      ...walk(join(MOBILE, 'app')),
      ...walk(join(MOBILE, 'components')),
    ]
    const withLeading = files
      .filter((file) => /\bleading=\{/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(MOBILE.length + 1))
      .sort()
    expect(withLeading).toEqual(['components/home/MobileHomeFeed.tsx'])
  })

  test('that control is the avatar, and it asks for the drawer', () => {
    const feed = read('components/home/MobileHomeFeed.tsx')
    expect(feed).toMatch(/leading=\{<WorkspaceSidebarAvatar/)
    const avatar = read('components/layout/WorkspaceSidebarAvatar.tsx')
    expect(avatar).toContain('sidebarOpenEvents.requestOpenSidebar()')
    expect(avatar).toContain('home-sidebar-avatar')
  })
})

describe('the sidebar sheet is not mounted until it is opened', () => {
  test('the phone layout asks for a lazy sheet and the shell honours it', () => {
    const layout = read('app/(app)/_layout.tsx')
    expect(layout).toMatch(/lazySidebarSheet/)
    const shell = read('components/layout/NativeSheetDrawerShell.tsx')
    // The sheet is only mounted when the drawer is open (or laziness is off);
    // it stays through the closing animation so it can slide out.
    expect(shell).toMatch(
      /const sheetMounted = !lazySidebarSheet \|\| drawerOpen \|\| sheetCompositing/,
    )
    expect(shell).toMatch(/sheetMounted \?/)
  })
})

describe('the conversation list updates in place', () => {
  const conversation = (id: string, lastSeq: number): ConversationSummary =>
    ({
      id,
      workspaceId: 'ws-1',
      kind: 'public',
      name: id,
      slug: id,
      topic: null,
      lastSeq,
      lastMessageAt: '2026-10-26T00:00:00.000Z',
      archivedAt: null,
      createdAt: '2026-10-25T00:00:00.000Z',
      joined: true,
      starred: false,
      muted: false,
      notifyLevel: 'all',
      lastReadSeq: lastSeq,
      unreadCount: 0,
      mentionCount: 0,
    }) as ConversationSummary

  const message = (conversationId: string, seq: number): ChatMessage =>
    ({
      id: `m-${conversationId}-${seq}`,
      conversationId,
      workspaceId: 'ws-1',
      seq,
      threadRootId: null,
      replyCount: 0,
      lastReplyAt: null,
      alsoSentToChannel: false,
      authorType: 'user',
      author: { id: 'someone-else', name: 'Someone', image: null },
      authorUserId: 'someone-else',
      authorAgent: null,
      text: 'hello',
      blocks: null,
      clientMsgId: null,
      agentSessionId: null,
      agentStatus: null,
      reactions: [],
      attachments: [],
      editedAt: null,
      deletedAt: null,
      createdAt: '2026-10-26T01:00:00.000Z',
    }) as ChatMessage

  test('only the conversation the event touched gets a new reference', () => {
    const list = [conversation('a', 1), conversation('b', 1), conversation('c', 1)]
    const before = [...list]
    const { list: next } = applyListEvent(
      list,
      { type: 'message.created', conversationId: 'b', message: message('b', 2) },
      'me',
      null,
    )
    // A new array (so React sees a change)…
    expect(next).not.toBe(list)
    // …with the untouched rows keeping their identity (so 150 rows do not redraw).
    expect(next[0]).toBe(before[0])
    expect(next[2]).toBe(before[2])
    expect(next[1]).not.toBe(before[1])
    expect(next[1].id).toBe('b')
    expect(next[1].lastSeq).toBe(2)
    // The original list is not mutated in place.
    expect(list[1]).toBe(before[1])
  })

  test('a quiet event returns the same array, so nothing re-renders', () => {
    const list = [conversation('a', 1), conversation('b', 1)]
    const { list: next } = applyListEvent(
      list,
      { type: 'message.created', conversationId: 'not-in-this-list', message: message('not-in-this-list', 2) },
      'me',
      null,
    )
    // A conversation this client cannot see asks for a refetch and changes nothing.
    expect(next).toBe(list)
  })
})
