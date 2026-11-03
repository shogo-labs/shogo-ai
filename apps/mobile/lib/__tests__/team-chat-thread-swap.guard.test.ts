// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-294 guard: one thread at a time, from every entry point.
 *
 * The bug was not one wrong call — it was eleven callers each pushing their own
 * `/c/[conversationId]?thread=…` screen, so a thread opened while another was on
 * screen stacked a copy of the channel over it. The rule now lives in
 * `openConversationTarget`, and this test keeps it there: a new entry point that
 * pushes a thread route itself fails here instead of shipping the bug again.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const MOBILE = join(import.meta.dir, '../..')
const ROOTS = ['app', 'components', 'hooks', 'lib']
/** The one place allowed to push a thread route. */
const HELPER = 'lib/team-chat-nav.ts'

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

/** Every `router.push(…)` call, with the text of its argument. */
function pushes(text: string): string[] {
  const found: string[] = []
  const marker = /router\.push\(/g
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
  test('no screen pushes a thread route itself — they all go through openConversationTarget', () => {
    const offenders = sources
      .filter((file) => file.path !== HELPER)
      .filter((file) => pushes(file.text).some((arg) => /\bthread\b/.test(arg)))
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })

  test('the conversation screen publishes which thread is in focus', () => {
    const screen = sources.find((file) => file.path === 'app/(app)/c/[conversationId].tsx')!
    expect(screen.text).toContain('setThreadFocus({ conversationId, threadRootId }, activeToken)')
    expect(screen.text).toContain('setThreadFocus(null, activeToken)')
  })

  test('the helper is the only place that decides swap versus push', () => {
    const callers = sources.filter((file) => file.path !== HELPER && /openConversationTarget\(/.test(file.text))
    // Every entry point the card names, plus the conversation screen itself.
    for (const path of [
      'app/(app)/c/[conversationId].tsx',
      'app/(app)/c/inbox.tsx',
      'app/(app)/c/later.tsx',
      'app/(app)/c/search.tsx',
      'app/(app)/c/questions.tsx',
      'components/activity/ActivityFeed.tsx',
      'components/chat/turns/ChannelDispatchCard.tsx',
      'components/team-chat/MessageQuoteCard.tsx',
      'lib/open-active-chat.ts',
      'lib/team-chat-links.ts',
      'lib/notifications/useNotificationClickRouter.ts',
    ]) {
      expect(callers.map((file) => file.path)).toContain(path)
    }
  })
})
