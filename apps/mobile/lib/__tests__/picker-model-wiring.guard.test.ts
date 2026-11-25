// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The shared picker has two async writers, and only one of them may win
 * (SHO-497).
 *
 * The project layout seeds `selectedModel` from the persisted last-used
 * preference, and the open chat reports its own model up to the same state.
 * They arrive on separate paths — the preference read re-runs whenever the
 * model catalog or the runtime URL lands — so the read can finish *after* the
 * chat has reported. Writing the preference straight into the state there
 * showed Sonnet (the model last picked in another chat) in a chat whose own
 * Opus was sitting in the device cache; the browser repro is
 * `e2e/local/chat-composer-memory.test.ts` "AC 5-8".
 *
 * The rule itself is `resolvePickerModel` (unit-tested in
 * chat-composer-memory.test.ts). This file pins the wiring: both writers go
 * through it, and the read keeps the chat's claim in its inputs.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const MOBILE = join(import.meta.dir, '../..')
const layout = readFileSync(join(MOBILE, 'app/(app)/projects/[id]/_layout.tsx'), 'utf8')

/** The cold-load effect that seeds the picker from the persisted preference. */
function preferenceRead(): string {
  const start = layout.indexOf('loadModelPreference(projectId).then((stored) => {')
  expect(start).toBeGreaterThan(-1)
  // The effect's dependency array closes it; that is far enough to cover the
  // write and the runtime sync below it.
  const end = layout.indexOf('}, [projectId, agentUrl, visibleModels])', start)
  expect(end).toBeGreaterThan(start)
  return layout.slice(start, end)
}

describe('the persisted preference cannot overwrite an open chat (SHO-497)', () => {
  test('the read resolves through the chat-first rule', () => {
    const read = preferenceRead()
    expect(read).toContain('resolvePickerModel({')
    // The open chat's claim is an input, not something applied later.
    expect(read).toContain('chatModel: activeChatModelRef.current')
    expect(read).toContain('preference: next')
  })

  test('the read never writes the preference into the picker directly', () => {
    expect(preferenceRead()).not.toContain('setSelectedModel(next)')
  })

  test('a read that lost to a chat claim does not re-point the runtime', () => {
    const read = preferenceRead()
    const guard = read.indexOf('if (resolved.fromChat) return')
    expect(guard).toBeGreaterThan(-1)
    // The agent-config PATCH comes after the guard, so the runtime keeps the
    // model the chat reported.
    expect(guard).toBeLessThan(read.indexOf('/agent/config'))
  })

  test("the chat's report records its claim before any early return", () => {
    const report = layout.slice(
      layout.indexOf('const handleResolveSessionModel = useCallback('),
      layout.indexOf('}, [agentUrl, projectId]', layout.indexOf('const handleResolveSessionModel = useCallback(')),
    )
    const claim = report.indexOf('activeChatModelRef.current = modelId')
    expect(claim).toBeGreaterThan(-1)
    // Claim first: a re-report of the value already on screen still has to
    // leave the claim behind for a preference read that lands afterwards.
    expect(claim).toBeLessThan(report.indexOf('if (selectedModelRef.current === next) return'))
  })
})
