// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const layout = readFileSync(resolve(import.meta.dir, '../_layout.tsx'), 'utf8')

describe('native canvas preview auth', () => {
  test('polls /preview/status through agentFetch so iOS sends the session cookie', () => {
    expect(layout).toContain('agentFetch(`${statusBase}/preview/status`')
    expect(layout).toContain('previewStatusPollBase(agentUrl, canvasBaseUrl)')
  })

  test('native loads the tokenized preview without waiting for running', () => {
    expect(layout).toContain('nativeCanvasBaseReady')
    expect(layout).toContain('preview/start')
    expect(layout).toContain('previewWakeUrl')
  })
})
