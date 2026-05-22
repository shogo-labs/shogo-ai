// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Regression test for the desktop / cloud TOOLS_PROXY_URL convention.
 *
 * Background: the agent-runtime's web-search, Composio, and embeddings
 * clients all build URLs as `${TOOLS_PROXY_URL}/<service>/...`, which only
 * works when the env var ends with `/api/tools` (the path under which the
 * proxy router is mounted in `apps/api/src/server.ts`). The cloud paths
 * (`knative-project-manager.ts`, `warm-pool-controller.ts`) had this
 * right, but the desktop `RuntimeManager` was setting it to `/api`, which
 * routed the proxy fallback through the `requireAuth` middleware and 401'd
 * any cloud-authed desktop install on first web search.
 *
 * The fix centralized the suffix in `cloud-urls.ts` (`buildToolsProxyUrl`,
 * `buildAiProxyUrl`) so all three managers can't drift independently. The
 * helpers themselves are unit-tested in `cloud-urls.test.ts`; this file
 * pins the desktop call site to the helper so a future inline-string
 * regression doesn't quietly reintroduce the original bug.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MANAGER_PATH = join(import.meta.dir, '..', 'lib', 'runtime', 'manager.ts')
const KNATIVE_PATH = join(import.meta.dir, '..', 'lib', 'knative-project-manager.ts')
const WARM_POOL_PATH = join(import.meta.dir, '..', 'lib', 'warm-pool-controller.ts')

function readSource(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('TOOLS_PROXY_URL / AI_PROXY_URL convention', () => {
  test('desktop RuntimeManager builds proxy URLs via the centralized helpers', () => {
    const src = readSource(MANAGER_PATH)
    expect(src).toContain('buildToolsProxyUrl')
    expect(src).toContain('buildAiProxyUrl')
    expect(src).toMatch(
      /runtimeEnv\.TOOLS_PROXY_URL\s*=\s*buildToolsProxyUrl\(/,
    )
    expect(src).toMatch(/buildAiProxyUrl\(/)
  })

  test('cloud KnativeProjectManager uses the same helpers', () => {
    const src = readSource(KNATIVE_PATH)
    expect(src).toContain('buildToolsProxyUrl')
    expect(src).toContain('buildAiProxyUrl')
  })

  test('warm-pool controller uses the same helpers', () => {
    const src = readSource(WARM_POOL_PATH)
    expect(src).toContain('buildToolsProxyUrl')
    expect(src).toContain('buildAiProxyUrl')
  })

  test('no manager re-inlines the historical buggy `/api` suffix for TOOLS_PROXY_URL', () => {
    // The original bug was `TOOLS_PROXY_URL = http://localhost:${apiPort}/api`
    // (missing `/tools`). A future re-inline would silently re-break cloud-authed
    // desktop installs. We forbid the pattern entirely — the helper is the only
    // sanctioned producer of this value.
    for (const path of [MANAGER_PATH, KNATIVE_PATH, WARM_POOL_PATH]) {
      const src = readSource(path)
      expect(src).not.toMatch(/TOOLS_PROXY_URL.*=.*`[^`]*\/api`/)
      expect(src).not.toMatch(/TOOLS_PROXY_URL.*['"]\s*[^'"]*\/api['"]/)
    }
  })
})
