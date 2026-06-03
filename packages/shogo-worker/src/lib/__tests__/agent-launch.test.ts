// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Smoke tests for the MIT `shogo` agent launcher (argv + env shape).
 * buildAgentSpawn is pure, so no spawn / network / runtime binary is needed.
 */
import { describe, test, expect } from 'bun:test'
import { resolve as resolvePath } from 'node:path'
import { buildAgentSpawn } from '../../commands/agent.ts'
import type { ResolvedRuntime } from '../runtime-resolver.ts'

const runtime: ResolvedRuntime = { path: '/home/u/.shogo/runtime/agent-runtime', source: 'home' }
const config = { apiKey: 'shogo_sk_test123', cloudUrl: 'https://studio.shogo.ai' }

describe('buildAgentSpawn', () => {
  test('interactive launch: argv + billing env point at the proxy', () => {
    const plan = buildAgentSpawn({
      flags: { cwd: '/work/repo' },
      config,
      runtime,
      baseEnv: {},
    })

    expect(plan.bin).toBe('/home/u/.shogo/runtime/agent-runtime')
    expect(plan.args).toEqual(['interactive'])
    expect(plan.cwd).toBe(resolvePath('/work/repo'))

    expect(plan.env.SHOGO_INTERACTIVE).toBe('1')
    expect(plan.env.SHOGO_INTERACTIVE_CWD).toBe(resolvePath('/work/repo'))
    expect(plan.env.PROJECT_DIR).toBe(resolvePath('/work/repo'))
    expect(plan.env.WORKSPACE_DIR).toBe(resolvePath('/work/repo'))
    expect(plan.env.SHOGO_API_URL).toBe('https://studio.shogo.ai')
    expect(plan.env.SHOGO_API_KEY).toBe('shogo_sk_test123')
    expect(plan.env.AI_PROXY_URL).toBe('https://studio.shogo.ai/api/ai/v1')
    expect(plan.env.AI_PROXY_TOKEN).toBe('shogo_sk_test123')
  })

  test('headless -p adds the print argv + SHOGO_PRINT_PROMPT', () => {
    const plan = buildAgentSpawn({
      flags: { print: 'review this', cwd: '/work/repo' },
      config,
      runtime,
      baseEnv: {},
    })
    expect(plan.args).toEqual(['interactive', '-p', 'review this'])
    expect(plan.env.SHOGO_PRINT_PROMPT).toBe('review this')
  })

  test('--no-tui and --model are threaded through', () => {
    const plan = buildAgentSpawn({
      flags: { noTui: true, model: 'claude-sonnet', cwd: '/work/repo' },
      config,
      runtime,
      baseEnv: {},
    })
    expect(plan.args).toEqual(['interactive', '--no-tui'])
    expect(plan.env.SHOGO_MODEL).toBe('claude-sonnet')
  })

  test('trailing slash on cloudUrl is stripped before building proxy URL', () => {
    const plan = buildAgentSpawn({
      flags: { cwd: '/work/repo' },
      config: { apiKey: 'shogo_sk_x', cloudUrl: 'https://example.dev/' },
      runtime,
      baseEnv: {},
    })
    expect(plan.env.SHOGO_API_URL).toBe('https://example.dev')
    expect(plan.env.AI_PROXY_URL).toBe('https://example.dev/api/ai/v1')
  })

  test('base env is preserved (e.g. PATH) and not clobbered', () => {
    const plan = buildAgentSpawn({
      flags: { cwd: '/work/repo' },
      config,
      runtime,
      baseEnv: { PATH: '/usr/bin', HOME: '/home/u' },
    })
    expect(plan.env.PATH).toBe('/usr/bin')
    expect(plan.env.HOME).toBe('/home/u')
  })

  test('empty -p (no value) still routes to headless argv', () => {
    const plan = buildAgentSpawn({
      flags: { print: '', cwd: '/work/repo' },
      config,
      runtime,
      baseEnv: {},
    })
    expect(plan.args).toEqual(['interactive', '-p', ''])
    expect(plan.env.SHOGO_PRINT_PROMPT).toBe('')
  })
})
