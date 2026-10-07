// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Architectural regression test: every route that resolves a project's
 * runtime must pin to the workspace's home region before resolving.
 *
 * Production bug: a US visitor opened an EU-homed project. Chat and
 * agent-proxy were pinned to the EU, so the agent built the app on the EU VM,
 * but `sandbox/url` and the preview render/wake routes resolved the runtime
 * locally — booting a second, US VM seeded with the starter template. The
 * canvas iframe showed "Project Ready / Start building your app!" while the
 * real app sat on the other VM.
 *
 * Source check (same shape as `trust-resolver-wiring.test.ts`): for each
 * handler, `pinChatToHomeRegion(` must appear before the first runtime
 * resolver call. The pin's behavior itself is covered by
 * `chat-region-pin.test.ts`, and the agent-proxy route by
 * `agent-proxy-region-pin.integration.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')

const RESOLVERS = /resolveProjectPodUrl\(|getProjectPodUrl\(|new MetalSubstrate\(\)\.getStatus\(|projectChatRoutes\(/

function handlerBody(start: string): string {
  const from = src.indexOf(start)
  if (from === -1) throw new Error(`handler not found in server.ts: ${start}`)
  const rest = src.slice(from + start.length)
  const next = rest.search(/\n(app\.(get|post|all|put|delete|use)\(|const \w+Handler = async)/)
  return next === -1 ? rest : rest.slice(0, next)
}

const ROUTES: Array<[label: string, start: string]> = [
  ['GET sandbox/url', "app.get('/api/projects/:projectId/sandbox/url'"],
  ['GET preview wake', "app.get('/api/preview/:projectId/wake'"],
  ['preview render', 'const previewRenderHandler = async'],
  ['preview port render', 'const previewPortRenderHandler = async'],
  ['GET runtime/status', "app.get('/api/projects/:projectId/runtime/status'"],
  ['legacy preview proxy', "app.all('/api/projects/:projectId/preview/*'"],
  ['GET ports/listening', "app.get('/api/projects/:projectId/ports/listening'"],
  ['GET chat/status', "app.get('/api/projects/:projectId/chat/status'"],
]

describe('runtime-resolving routes pin to the home region first', () => {
  for (const [label, start] of ROUTES) {
    test(label, () => {
      const body = handlerBody(start)
      const pinAt = body.indexOf('pinChatToHomeRegion(')
      const resolveAt = body.search(RESOLVERS)
      expect(resolveAt).toBeGreaterThan(-1)
      expect(pinAt).toBeGreaterThan(-1)
      expect(pinAt).toBeLessThan(resolveAt)
    })
  }
})

describe('metal runtime resolution records the preview region', () => {
  test('sandbox/url and preview wake remember the region after a metal resolve', () => {
    for (const start of [
      "app.get('/api/projects/:projectId/sandbox/url'",
      "app.get('/api/preview/:projectId/wake'",
    ]) {
      expect(handlerBody(start)).toContain('rememberMetalPreviewRegion(projectId)')
    }
  })
})
