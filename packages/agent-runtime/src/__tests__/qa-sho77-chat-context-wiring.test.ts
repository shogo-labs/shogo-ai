// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-77 wiring guard — the surface each chat belongs to has to travel from the
 * API proxy to the runtime, because one runtime serves both.
 *
 * The route handlers that stamp it (`workspace-chat.ts` / `project-chat.ts`)
 * need ~200 lines of auth/session/runtime mocks to drive, and `server.ts`
 * cannot be imported without booting a runtime. So this guards the exact
 * statements that carry the value, and the behavioural half (what the runtime
 * does with it) is covered by `qa-sho77-workspace-capabilities.acceptance.test.ts`
 * and `capability-scope.test.ts`.
 *
 * If this fails, the feature is silently back to reading the anchor project's
 * toggles — which is the bug SHO-77 fixed.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '../../../..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8')

describe('SHO-77 chat-surface wiring', () => {
  test('a workspace chat stamps chatContext "workspace" on the forwarded body', () => {
    const src = read('apps/api/src/routes/workspace-chat.ts')
    const forwards = src.match(/`\$\{podUrl\}\/agent\/chat`/g) ?? []
    expect(forwards.length).toBe(1)
    expect(src).toContain("parsedBody.chatContext = 'workspace'")
    // Never taken from the client: always overwritten before forwarding.
    expect(src).not.toMatch(/chatContext\s*=\s*parsedBody\.chatContext/)
  })

  test('a project chat stamps chatContext "project" on the forwarded body', () => {
    const src = read('apps/api/src/routes/project-chat.ts')
    expect(src).toContain("parsedBody.chatContext = 'project'")
    expect(src).not.toMatch(/chatContext\s*=\s*parsedBody\.chatContext/)
  })

  test('the runtime reads chatContext off the message payload and passes it into the turn', () => {
    const src = read('packages/agent-runtime/src/server.ts')
    expect(src).toContain("body.chatContext === 'workspace'")
    expect(src).toContain("body.chatContext === 'project'")
    expect(src).toMatch(/chatSessionId:\s*chatSessionKey,\s*\n\s*chatContext,/)
  })

  test('the turn resolves its capability config from that surface, not from the anchor', () => {
    const src = read('packages/agent-runtime/src/gateway.ts')
    expect(src).toContain('configForTurn(sessionId, resolvedChatContext)')
    expect(src).toContain('capabilityScope: resolvedChatContext === \'workspace\' ? \'workspace\' : \'project\'')
    // The tool filter must use the turn's config, not `this.config`.
    expect(src).toContain('filterDisabledCapabilityTools(assembledTools, turnConfig)')
  })
})
