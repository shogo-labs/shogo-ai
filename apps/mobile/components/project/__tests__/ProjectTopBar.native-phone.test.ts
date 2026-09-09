// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(
  resolve(import.meta.dir, '../ProjectTopBar.tsx'),
  'utf8',
)

describe('ProjectTopBar native phone header', () => {
  test('merges chat and more into one pill when the chat icon is shown', () => {
    expect(source).toContain('testID="project-native-chat-more-cluster"')
    expect(source).toContain('showChatMoreCluster ? (')
    expect(source).toContain('rounded-full bg-muted')
    expect(source).toContain('testID="project-native-chat"')
    expect(source).toContain('testID="project-native-more"')
  })

  test('centers the project title with equal insets from the wider chrome side', () => {
    expect(source).toContain('const titleInset = Math.max(leftChrome, rightChrome)')
    expect(source).toContain('left: 0')
    expect(source).toContain('right: 0')
    expect(source).toContain('paddingHorizontal: titleInset')
    expect(source).not.toContain('right: onChat ? 52 : 100')
  })

  test('keeps header icons off the hairline under the bar', () => {
    expect(source).toContain('NATIVE_HEADER_PAD_BOTTOM = 12')
    expect(source).toContain('paddingBottom: NATIVE_HEADER_PAD_BOTTOM')
  })
})
