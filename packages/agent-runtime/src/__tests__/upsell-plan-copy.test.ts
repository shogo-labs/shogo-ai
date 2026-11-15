// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-398 — the copy an agent reads must sell the same plan the UI sells.
//
// SHO-397 retired the Pro plan at checkout, but the publish tool description
// and the code-agent guide still told the agent "first publish requires the
// Pro plan or higher", so the agent pitched a plan the card next to it no
// longer offers. This pins the plan name on every agent-facing string.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { createTools } = await import('../gateway-tools')
const { buildCodeAgentGeneralGuide } = await import('../code-agent-prompt')

/** The plan retired in v2.5.0 — a `pro` checkout is remapped to Business. */
const RETIRED_PLAN = 'Pro'
/** The plan that actually unlocks publishing, staging and advanced models. */
const PAID_PLAN = 'Business'

function publishToolDescription(): string {
  const dir = mkdtempSync(join(tmpdir(), 'publish-copy-'))
  try {
    const ctx: any = {
      workspaceDir: dir,
      channels: new Map(),
      config: {
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      },
      projectId: 'proj-publish-copy',
      sessionId: 'sess-publish-copy',
      mainSessionIds: ['sess-publish-copy'],
    }
    const tool = createTools(ctx).find((t: any) => t.name === 'publish')
    expect(tool).toBeTruthy()
    return String(tool.description)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('agent-facing plan copy (SHO-398)', () => {
  test('the publish tool names the plan that is on sale', () => {
    const description = publishToolDescription()
    expect(description).toContain(`requires the ${PAID_PLAN} plan`)
    expect(description).not.toMatch(new RegExp(`requires the ${RETIRED_PLAN}\\b`))
  })

  test('the code-agent guide names the same plan', () => {
    const guide = String(buildCodeAgentGeneralGuide())
    expect(guide).toContain(`requires the ${PAID_PLAN} plan`)
    expect(guide).not.toMatch(new RegExp(`requires the ${RETIRED_PLAN}\\b`))
  })
})
