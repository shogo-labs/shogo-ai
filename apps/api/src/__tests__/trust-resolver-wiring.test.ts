// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Architectural regression tests for the live trust resolver wiring.
 *
 * The "Trust folder still shows restricted" bug was caused by trust
 * being a spawn-time env snapshot the running runtime had no way to
 * refresh. The fix moved trust to a live resolver:
 *
 *   - `manager.ts` must NOT bake TRUST_LEVEL into the spawn env.
 *   - `local-projects.ts` POST /:id/trust must ping the runtime's
 *     /internal/refresh-trust route after writing Postgres.
 *   - `gateway.ts` must call `refreshTrust()` at the start of every
 *     chat turn AND read trust from `getRuntimeTrust()`, never from
 *     `process.env.TRUST_LEVEL`.
 *   - `server.ts` must mount the /internal/refresh-trust route, seed
 *     the resolver at boot, and stop publishing `trustLevel` into the
 *     legacy global.
 *
 * These are source-regression checks (same shape as
 * `runtime-manager-proxy-urls.test.ts`): they read the source files
 * as text and pin invariants that are easy to silently regress. They
 * complement the behavioral unit tests in
 * `trust-resolver.test.ts`, `runtime-trust.test.ts`, and the
 * `GET /projects/:projectId/trust` block in `internal.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..', '..', '..')

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8')
}

describe('trust resolver wiring — manager.ts', () => {
  const src = read('apps/api/src/lib/runtime/manager.ts')

  test('runtimeEnv for external projects no longer includes TRUST_LEVEL', () => {
    // TRUST_LEVEL must not appear as an env-key assignment in
    // manager.ts. (It may appear in a comment explaining why it's
    // gone — that's why we look for the assignment shape, not the
    // bare token.)
    expect(src).not.toMatch(/^\s*TRUST_LEVEL:\s*/m)
  })

  test('LINKED_FOLDERS is still in the spawn env (immutable for runtime lifetime)', () => {
    // Sanity check that the test above didn't pass just because the
    // whole external branch was deleted by accident.
    expect(src).toMatch(/LINKED_FOLDERS:\s*JSON\.stringify/)
  })

  test('comment documents why TRUST_LEVEL is intentionally absent', () => {
    // A future dev reading the diff should see why TRUST_LEVEL was
    // removed, so they don't "fix" it by adding it back.
    expect(src).toMatch(/TRUST_LEVEL is deliberately NOT in the spawn env/i)
  })
})

describe('trust resolver wiring — local-projects.ts', () => {
  const src = read('apps/api/src/routes/local-projects.ts')

  test('POST /:id/trust pings the runtime after the DB write', () => {
    // The route block is hard to slice with a regex because of nested
    // braces inside the prisma update argument. Instead, anchor on
    // three ordered string occurrences in the file and assert their
    // lexical order matches execution order:
    //   1. the route registration
    //   2. the prisma update
    //   3. the ping helper invocation
    //
    // If a future refactor inverts steps 2 and 3 (the exact race the
    // fix prevents — pinging before the row is committed), this test
    // fails loudly.
    const routeIdx = src.indexOf("router.post('/:id/trust'")
    expect(routeIdx).toBeGreaterThan(-1)

    const updateIdx = src.indexOf('prisma.project.update', routeIdx)
    expect(updateIdx).toBeGreaterThan(routeIdx)

    const pingIdx = src.indexOf('pingRuntimeRefreshTrust(projectId)', updateIdx)
    expect(pingIdx).toBeGreaterThan(updateIdx)

    // And the ping must be reasonably close to the route — guards
    // against the helper being moved into an unrelated handler.
    expect(pingIdx - routeIdx).toBeLessThan(2000)
  })

  test('pingRuntimeRefreshTrust helper is defined and targets the right route', () => {
    expect(src).toMatch(/function pingRuntimeRefreshTrust\(projectId: string\)/)
    expect(src).toMatch(/\/internal\/refresh-trust/)
    expect(src).toMatch(/deriveWebhookToken/)
    // Must read agentPort from runtime.status() — otherwise it would
    // hit the wrong port for any non-default install.
    expect(src).toMatch(/agentPort/)
  })

  test('ping is fire-and-forget (does not await, swallows errors)', () => {
    const helperMatch = src.match(
      /function pingRuntimeRefreshTrust[\s\S]*?\n\}/,
    )
    expect(helperMatch).not.toBeNull()
    const helper = helperMatch?.[0] ?? ''
    // The whole body lives inside an IIFE so the route can return
    // immediately. If a future refactor `await`s it directly the
    // route latency couples to the runtime's responsiveness.
    expect(helper).toMatch(/;\s*\(async \(\) => \{/)
    expect(helper).toContain('catch')
  })
})

describe('trust resolver wiring — gateway.ts', () => {
  const src = read('packages/agent-runtime/src/gateway.ts')

  test('imports refreshTrust + getRuntimeTrust from the new modules', () => {
    expect(src).toMatch(/from ['"]\.\/runtime-trust['"]/)
    expect(src).toMatch(/from ['"]\.\/trust-resolver['"]/)
    expect(src).toMatch(/\bgetRuntimeTrust\b/)
    expect(src).toMatch(/\brefreshTrust\b/)
  })

  test('per-turn refresh runs at the top of _agentTurnInner', () => {
    // The whole point of the fix: every turn must reconcile with the
    // DB BEFORE the system prompt is built or any tool runs.
    // Anchor on the method DEFINITION (not its earlier call site) and use a
    // window wide enough to span the refresh + the system-prompt build, which
    // have drifted further apart as the turn setup grew.
    const inner = src.match(/private async _agentTurnInner\([\s\S]{0,4000}/)?.[0] ?? ''
    const refreshIdx = inner.indexOf('await refreshTrust()')
    const bootstrapIdx = inner.indexOf('loadBootstrapContext')
    expect(refreshIdx).toBeGreaterThanOrEqual(0)
    expect(bootstrapIdx).toBeGreaterThanOrEqual(0)
    // Refresh must happen before loadBootstrapContext (system prompt).
    expect(refreshIdx).toBeLessThan(bootstrapIdx)
  })

  test('system prompt builder no longer reads process.env.TRUST_LEVEL', () => {
    // The exact bug: env reads were a stale spawn-time value. The
    // whole module must read trust from getRuntimeTrust() going
    // forward; future regressions get caught here.
    expect(src).not.toMatch(/process\.env\.TRUST_LEVEL/)
  })
})

describe('trust resolver wiring — server.ts', () => {
  const src = read('packages/agent-runtime/src/server.ts')

  test('imports the resolver init + refresh', () => {
    expect(src).toMatch(
      /from ['"]\.\/trust-resolver['"]/,
    )
    expect(src).toMatch(/initTrustResolver/)
    expect(src).toMatch(/refreshTrust/)
  })

  test('TRUST_LEVEL env is no longer parsed at boot', () => {
    // The old code had: `const TRUST_LEVEL = process.env.TRUST_LEVEL === ...`
    // Any reintroduction of a top-level TRUST_LEVEL const would be a
    // regression to the broken architecture.
    expect(src).not.toMatch(/const TRUST_LEVEL[:\s]/)
    expect(src).not.toMatch(/process\.env\.TRUST_LEVEL/)
  })

  test('initTrustResolver runs at boot with the right shape', () => {
    expect(src).toMatch(/initTrustResolver\(\s*\{[\s\S]*?workspaceDir[\s\S]*?\}\s*\)/)
    // Best-effort initial refresh so the first chat turn doesn't have
    // to wait on its own refreshTrust() call.
    expect(src).toMatch(/refreshTrust\(\)\.catch/)
  })

  test('legacy global no longer advertises trustLevel (avoid stale-read bugs)', () => {
    // The whole point of the fix: globalThis.__SHOGO_AGENT_RUNTIME_CONFIG__
    // must not have a `trustLevel` field anymore. Out-of-tree readers
    // either go through getRuntimeTrust() (which goes through the
    // resolver) or get nothing — they must NEVER get a stale snapshot.
    const globalAssign =
      src.match(/__SHOGO_AGENT_RUNTIME_CONFIG__\s*=\s*\{[\s\S]*?\}/)?.[0] ?? ''
    expect(globalAssign).not.toContain('trustLevel')
    // But the immutable directory triplet must still be there for
    // any out-of-tree consumer that depends on it.
    expect(globalAssign).toContain('workspaceDir')
    expect(globalAssign).toContain('linkedFolders')
    expect(globalAssign).toContain('workingMode')
  })

  test('POST /internal/refresh-trust route is mounted with webhook auth', () => {
    const route =
      src.match(/app\.post\(['"]\/internal\/refresh-trust['"][\s\S]*?\}\)/)?.[0] ??
      ''
    expect(route.length).toBeGreaterThan(0)
    expect(route).toContain('verifyWebhookAuth')
    expect(route).toContain('await refreshTrust()')
    // Must return 401 when unauthorized (not silently succeed).
    expect(route).toMatch(/Unauthorized/)
  })
})

describe('trust resolver wiring — runtime-trust.ts', () => {
  const src = read('packages/agent-runtime/src/runtime-trust.ts')

  test('reads from trust-resolver (resolver is authoritative)', () => {
    expect(src).toMatch(/from ['"]\.\/trust-resolver['"]/)
    expect(src).toMatch(/isTrustResolverInitialized/)
    expect(src).toMatch(/getResolvedTrust/)
  })

  test('env-only fallback path is preserved for unit tests', () => {
    // Production no longer reads TRUST_LEVEL from env, but unit tests
    // pin trust via env. Removing this branch would silently break
    // every gateway-tools test in the suite.
    expect(src).toMatch(/process\.env\.TRUST_LEVEL/)
    expect(src).toMatch(/process\.env\.LINKED_FOLDERS/)
  })
})
