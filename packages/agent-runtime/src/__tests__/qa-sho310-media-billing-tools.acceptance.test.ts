// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-310 QA acceptance — what the agent actually sees when the proxy refuses
 * a media job for money reasons.
 *
 * AC2 (second half): a free workspace's `generate_video` shows the readable
 * "Video generation needs a paid plan" message *and* the `video_requires_paid_plan`
 * code, so the agent can tell an upgrade problem from a balance problem. AC2
 * (first half) also requires `list_media_models` to show video entries as
 * unavailable on a free workspace: the tool must pass the proxy's
 * `available: false` / `requires: 'paid_plan'` flags and the `video_note`
 * through instead of hiding them.
 *
 * AC3 (user-facing half): a balance refusal on an image carries the price in
 * its message rather than the bare usage-limit string.
 *
 * No network: `globalThis.fetch` is stubbed by URL.
 *
 *   bun test packages/agent-runtime/src/__tests__/qa-sho310-media-billing-tools.acceptance.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'

const TEST_DIR = join(import.meta.dir, '../../../../_tmp/qa-sho310-media-tools')
const PROXY = 'http://proxy.test/api/ai/v1'

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
const realFetch = globalThis.fetch
let routes: Array<{ prefix: string; handler: Handler }> = []
let calls: Array<{ url: string; init?: RequestInit }> = []

function on(prefix: string, handler: Handler) {
  routes.push({ prefix, handler })
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function ctx(config: Record<string, unknown> = {}): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      videoGenEnabled: true,
      ...config,
    } as any,
    projectId: 'test',
    aiProxyUrl: PROXY,
    aiProxyToken: 'pt',
  }
}

async function run(name: string, params: Record<string, unknown>, c = ctx()) {
  const tool = createTools(c).find((x) => x.name === name)
  if (!tool) throw new Error(`${name} not registered`)
  const result = await tool.execute('call-qa', params as any, undefined)
  return result.details as any
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  routes = []
  calls = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init })
    const route = routes.find((r) => url === r.prefix || url.startsWith(r.prefix))
    if (!route) return json({ error: `unrouted ${url}` }, 599)
    return route.handler(url, init)
  }) as any
})

// The stub outlives each test; restore the real fetch for the rest of the suite run.
process.on('exit', () => {
  globalThis.fetch = realFetch
})

describe('SHO-310 AC2 — generate_video tells an upgrade problem from a balance problem', () => {
  test('a free workspace 402 from the proxy carries the message and the code', async () => {
    on(`${PROXY}/videos/generations`, () =>
      json(
        {
          error: {
            message:
              'Video generation needs a paid plan (Basic or higher). Free workspaces can generate images.',
            type: 'billing_error',
            code: 'video_requires_paid_plan',
          },
        },
        402,
      ),
    )

    const out = await run('generate_video', { prompt: 'a wave at dusk' })

    expect(out.error).toContain('Video generation needs a paid plan')
    expect(out.code).toBe('video_requires_paid_plan')
    // One submit attempt, then nothing: no estimate/poll traffic either.
    expect(calls.filter((c) => c.url.includes('/videos/'))).toHaveLength(1)
  })

  test('a balance refusal keeps its own code instead of the upgrade one', async () => {
    on(`${PROXY}/videos/generations`, () =>
      json(
        {
          error: {
            message:
              'Usage limit reached. Enable usage-based pricing or upgrade your plan. This video costs about $3.12, and your workspace has less than that left.',
            type: 'billing_error',
            code: 'usage_limit_reached',
          },
        },
        402,
      ),
    )

    const out = await run('generate_video', { prompt: 'a wave at dusk' })

    expect(out.code).toBe('usage_limit_reached')
    // The price the proxy quoted is what the agent can repeat to the user.
    expect(out.error).toContain('$3.12')
    expect(out.error).not.toContain('paid plan')
  })

  test('a non-JSON 402 still yields a readable error and no bogus code', async () => {
    on(`${PROXY}/videos/generations`, () => new Response('upstream gateway error', { status: 402 }))

    const out = await run('generate_video', { prompt: 'a wave at dusk' })

    expect(typeof out.error).toBe('string')
    expect(out.error.length).toBeGreaterThan(0)
    expect(out.code).toBeUndefined()
  })
})

describe('SHO-310 AC2 — list_media_models passes the free-plan flags through', () => {
  test('video entries stay listed as available:false / requires paid_plan, with the note', async () => {
    on(`${PROXY}/media/models`, () =>
      json({
        currency: 'USD',
        videos: [
          { id: 'hf-kling-3.0-std', display_name: 'Kling 3.0 Standard', available: false, requires: 'paid_plan' },
        ],
        video_note: 'Video generation needs a paid plan (Basic or higher). Free workspaces can generate images.',
      }),
    )

    const out = await run('list_media_models', { kind: 'video' })

    expect(out.videos).toHaveLength(1)
    expect(out.videos[0].available).toBe(false)
    expect(out.videos[0].requires).toBe('paid_plan')
    expect(out.videos_note).toContain('paid plan')
  })

  test('a paid workspace listing carries no availability flag and no note', async () => {
    on(`${PROXY}/media/models`, () =>
      json({
        currency: 'USD',
        videos: [{ id: 'hf-kling-3.0-std', display_name: 'Kling 3.0 Standard', price_usd: 0.52 }],
      }),
    )

    const out = await run('list_media_models', { kind: 'video' })

    expect(out.videos[0].available).toBeUndefined()
    expect(out.videos[0].requires).toBeUndefined()
    expect(out.videos_note).toBeUndefined()
  })
})

describe('SHO-310 AC3 — an unaffordable image names its price', () => {
  test('the 402 message the agent sees quotes the job cost', async () => {
    on(`${PROXY}/images/generations`, () =>
      json(
        {
          error: {
            message:
              'Usage limit reached. Enable usage-based pricing or upgrade your plan. This image costs about $0.0412, and your workspace has less than that left.',
            type: 'billing_error',
            code: 'usage_limit_reached',
          },
        },
        402,
      ),
    )

    const out = await run('generate_image', { prompt: 'a cat, editorial portrait' })

    expect(out.error).toContain('$0.0412')
    expect(calls.filter((c) => c.url.includes('/images/generations'))).toHaveLength(1)
  })
})
