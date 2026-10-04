// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  AGENT_CHAT_COLUMN_GUTTER,
  AGENT_CHAT_COLUMN_MAX_WIDTH,
  STUDIO_CHAT_COLUMN_GUTTER,
  chatColumn,
  chatColumnStyle,
} from '../chat-column'
import { CHAT_TRANSCRIPT_MAX_WIDTH } from '../native-composer-keyboard'
import { NATIVE_PHONE_GUTTER } from '../native-phone-layout'

describe('chatColumn', () => {
  test('agent column on wide viewports', () => {
    expect(chatColumn({ presentation: 'agent' })).toEqual({
      maxWidth: AGENT_CHAT_COLUMN_MAX_WIDTH,
      gutter: AGENT_CHAT_COLUMN_GUTTER,
      measuredWidth: undefined,
      contentMaxWidth: AGENT_CHAT_COLUMN_MAX_WIDTH - AGENT_CHAT_COLUMN_GUTTER * 2,
    })
  })

  test('studio column is the default', () => {
    const column = chatColumn()
    expect(column.maxWidth).toBe(CHAT_TRANSCRIPT_MAX_WIDTH)
    expect(column.gutter).toBe(STUDIO_CHAT_COLUMN_GUTTER)
  })

  test('phone uses the phone gutter for both presentations', () => {
    expect(chatColumn({ presentation: 'agent', phone: true }).gutter).toBe(NATIVE_PHONE_GUTTER)
    expect(chatColumn({ presentation: 'studio', phone: true }).gutter).toBe(NATIVE_PHONE_GUTTER)
  })

  test('content width is outer width minus both gutters', () => {
    for (const presentation of ['agent', 'studio'] as const) {
      for (const phone of [false, true]) {
        const column = chatColumn({ presentation, phone })
        expect(column.contentMaxWidth).toBe(column.maxWidth! - column.gutter * 2)
      }
    }
  })

  test('a measured width replaces the max-width cap but keeps the gutter', () => {
    const column = chatColumn({ presentation: 'agent', phone: true, measuredWidth: 390 })
    expect(column.maxWidth).toBeUndefined()
    expect(column.measuredWidth).toBe(390)
    expect(column.gutter).toBe(NATIVE_PHONE_GUTTER)
  })
})

describe('chatColumnStyle', () => {
  test('is width 100% capped at max width, centered, with the gutter as padding', () => {
    expect(chatColumnStyle({ presentation: 'agent' })).toEqual({
      width: '100%',
      maxWidth: AGENT_CHAT_COLUMN_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: AGENT_CHAT_COLUMN_GUTTER,
    })
  })

  test('uses the measured pixel width when provided', () => {
    expect(chatColumnStyle({ presentation: 'studio', phone: true, measuredWidth: 390 })).toEqual({
      width: 390,
      alignSelf: 'center',
      paddingHorizontal: NATIVE_PHONE_GUTTER,
    })
  })
})
