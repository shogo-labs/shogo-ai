// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-294 guard: one thread at a time, from every entry point.
 *
 * The bug was not one wrong call — it was a dozen callers each pushing their own
 * `/c/[conversationId]` screen, so a thread opened while another was on screen
 * stacked a copy of the channel over it. The rule now lives in
 * `openConversationTarget` and this test keeps it there: any `router.push` to a
 * conversation outside `lib/team-chat-nav.ts` fails here, whatever params it
 * carries, instead of shipping the bug again.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const MOBILE = join(import.meta.dir, '../..')
const ROOTS = ['app', 'components', 'hooks', 'lib']
/** The one place allowed to push a conversation. */
const HELPER = 'lib/team-chat-nav.ts'
const CONVERSATION = '/(app)/c/[conversationId]'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.expo') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const sources = ROOTS.flatMap((root) => walk(join(MOBILE, root))).map((full) => ({
  path: relative(MOBILE, full).split('\\').join('/'),
  text: readFileSync(full, 'utf8'),
}))

const read = (path: string) => sources.find((file) => file.path === path)!.text

/** Every `router.push(…)` / `router.replace(…)` call, with the text of its argument. */
function navigations(text: string, method: 'push' | 'replace' = 'push'): string[] {
  const found: string[] = []
  const marker = new RegExp(`router\\.${method}\\(`, 'g')
  let match: RegExpExecArray | null
  while ((match = marker.exec(text))) {
    let depth = 1
    let i = match.index + match[0].length
    const start = i
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') depth--
      i++
    }
    found.push(text.slice(start, i - 1))
  }
  return found
}

describe('one thread at a time', () => {
  test('nothing but the helper pushes a conversation route', () => {
    const offenders = sources
      .filter((file) => file.path !== HELPER)
      .filter((file) => navigations(file.text).some((arg) => arg.includes(CONVERSATION)))
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })

  test('the two pushes that pass a route through are guarded by a conversation check', () => {
    // A notification href and an activity block both arrive as a prebuilt route,
    // so neither names the path in its own `push`. Each must take the
    // conversation branch first, and only then fall through to a plain push.
    const notifications = read('lib/notifications/useNotificationClickRouter.ts')
    expect(notifications).toContain(`route?.pathname === '${CONVERSATION}'`)
    expect(notifications.indexOf(`route?.pathname === '${CONVERSATION}'`)).toBeLessThan(notifications.indexOf('router.push(href'))

    const row = read('components/team-chat/MessageRow.tsx')
    expect(row).toContain(`target.pathname === '${CONVERSATION}'`)
    expect(row.indexOf(`target.pathname === '${CONVERSATION}'`)).toBeLessThan(row.indexOf('router.push({ pathname: target.pathname'))
  })

  test('the activity targets that lead to a conversation are opened through the helper', () => {
    // `activity-target.ts` builds the route; `MessageRow` is what navigates.
    expect(read('lib/activity-target.ts')).not.toContain('router.push')
    expect(read('components/team-chat/MessageRow.tsx')).toContain('openConversationTarget(router, {')
  })

  test('message targets keep the focus message separate from the thread root', () => {
    const helper = read(HELPER)
    expect(helper).toContain('return openConversationTarget(router, {')
    expect(helper).toContain('thread: target.threadRootId')
    expect(helper).toContain('msg: target.messageId')
    expect(helper).not.toContain('thread: target.threadRootId ?? target.messageId')
  })

  test('the conversation screen publishes which thread is in focus', () => {
    const screen = read('app/(app)/c/[conversationId].tsx')
    expect(screen).toContain('setThreadFocus({ conversationId, threadRootId }, activeToken)')
    expect(screen).toContain('setThreadFocus(null, activeToken)')
  })

  test('every entry point the card names opens through the helper', () => {
    const callers = sources.filter((file) => file.path !== HELPER && /openConversation(?:Target|Message)\(/.test(file.text)).map((file) => file.path)
    for (const path of [
      'app/(app)/c/[conversationId].tsx',
      'app/(app)/c/inbox.tsx',
      'app/(app)/c/later.tsx',
      'app/(app)/c/search.tsx',
      'app/(app)/c/questions.tsx',
      'components/activity/ActivityFeed.tsx',
      'components/chat/turns/ChannelDispatchCard.tsx',
      'components/team-chat/MessageQuoteCard.tsx',
      'components/team-chat/MessageRow.tsx',
      'lib/open-active-chat.ts',
      'lib/team-chat-links.ts',
      'lib/notifications/useNotificationClickRouter.ts',
    ]) {
      expect(callers).toContain(path)
    }
  })
})
