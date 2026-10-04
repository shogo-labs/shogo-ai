// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Source guard: chat surfaces must not define their own horizontal width.
 * The header, transcript, dock and composer all get their max-width and
 * side gutter from `lib/chat-column.ts` (via `chatColumnStyle` /
 * `<ChatColumn>`), which is what keeps their edges aligned.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')

const GUARDED_FILES = [
  'components/chat/ChatPanel.tsx',
  'components/chat/ChatInput.tsx',
  'components/chat/dock/ChatDock.tsx',
  'components/chat/composer/ProjectComposerDock.tsx',
  'components/personal/PersonalAgentHeader.tsx',
  'components/personal/PersonalAgentMobileHeader.tsx',
  'components/layout/MobileBottomNav.tsx',
]

const FORBIDDEN: Array<[RegExp, string]> = [
  [/max-w-2xl/, 'max-w-2xl'],
  [/max-w-\[760px\]/, 'max-w-[760px]'],
  [/maxWidth=\{\s*760\s*\}/, 'maxWidth={760}'],
  [/maxWidth:\s*760\b/, 'maxWidth: 760'],
  [/\bCHAT_TRANSCRIPT_MAX_WIDTH\b/, 'CHAT_TRANSCRIPT_MAX_WIDTH'],
  [/\bHORIZONTAL_PADDING_CLASS\b/, 'HORIZONTAL_PADDING_CLASS'],
]

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('chat column guard', () => {
  for (const file of GUARDED_FILES) {
    test(`${file} has no private chat width`, () => {
      const source = stripComments(readFileSync(resolve(root, file), 'utf8'))
      for (const [pattern, label] of FORBIDDEN) {
        if (pattern.test(source)) {
          throw new Error(
            `${file} uses "${label}". Chat surfaces must take their width and ` +
              `side gutter from lib/chat-column.ts (chatColumnStyle or ` +
              `components/chat/ChatColumn.tsx) so header, transcript, dock and ` +
              `composer stay aligned.`,
          )
        }
      }
    })
  }
})
