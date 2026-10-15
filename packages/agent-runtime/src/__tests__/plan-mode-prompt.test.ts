// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { READ_ONLY_COMMANDS } from '../read-only-command'
import {
  applyInteractionModePrompt,
  ASK_MODE_PROMPT,
  autoFloorTierFor,
  buildPlanModePrompt,
  filterToolsForMode,
  missingCodePlanSections,
  PLAN_DELIVERY_NUDGE,
  PLAN_MODE_ALLOWED_TOOLS,
  PLAN_MODE_REMINDER,
  planWrittenInsteadOfCreated,
} from '../plan-mode-prompt'

describe('planWrittenInsteadOfCreated', () => {
  const chatPlan = '## Problem\nTimeouts at 5s.\n\n## Root cause\n`src/http/client.ts:24` hardcodes 5000.\n\n## Changes\n- read the setting'
  test('a plan-mode reply that holds a plan but called no plan tool', () => {
    expect(planWrittenInsteadOfCreated('plan', ['read_file', 'grep'], chatPlan)).toBe(true)
  })
  test('not when the plan was delivered, or the agent asked the user', () => {
    expect(planWrittenInsteadOfCreated('plan', ['read_file', 'create_plan'], chatPlan)).toBe(false)
    expect(planWrittenInsteadOfCreated('plan', ['update_plan'], chatPlan)).toBe(false)
    expect(planWrittenInsteadOfCreated('plan', ['ask_user'], chatPlan)).toBe(false)
  })
  test('design and rollout plans written in chat count too', () => {
    expect(planWrittenInsteadOfCreated('plan', ['read_file'], '## REST → GraphQL Migration Plan\n### Overview\n...')).toBe(true)
    expect(planWrittenInsteadOfCreated('plan', [], '## Architecture\n### Phase 1: Extract\n...\n### Phase 2: Load\n...')).toBe(true)
  })
  test('not outside plan mode, and not for an ordinary answer', () => {
    expect(planWrittenInsteadOfCreated('plan', [], '## How the refresh flow works\n### Access tokens\n### Refresh tokens')).toBe(false)
    expect(planWrittenInsteadOfCreated('agent', [], chatPlan)).toBe(false)
    expect(planWrittenInsteadOfCreated('plan', [], 'The timeout comes from `src/http/client.ts`. ## Problem')).toBe(false)
    expect(planWrittenInsteadOfCreated('plan', [], '## Problem\nOnly one heading here.')).toBe(false)
  })
  test('a heading that merely mentions plans is not a plan', () => {
    expect(planWrittenInsteadOfCreated('plan', [], '## Pricing plans\n### Free\n### Pro')).toBe(false)
    expect(planWrittenInsteadOfCreated('plan', [], '## How the plan cache is invalidated\n### Writes\n### Reads')).toBe(false)
    expect(planWrittenInsteadOfCreated('plan', [], '## Migration Plan\nJust one heading.')).toBe(false)
  })
  test('the nudge asks for create_plan with the same plan', () => {
    expect(PLAN_DELIVERY_NUDGE).toContain('Call `create_plan` now with that plan')
  })
})

describe('missingCodePlanSections', () => {
  test('a code plan without the root-cause sections reports both', () => {
    expect(missingCodePlanSections('## Problem\nx\n## Changes\n- `src/http/client.ts`: read the setting')).toEqual(['Root cause', 'Options considered'])
  })
  test('headings at any level and in any case count', () => {
    expect(missingCodePlanSections('### root cause\nsrc/a.ts:3\n# Options Considered\n1. a')).toEqual([])
    expect(missingCodePlanSections('## Root cause\nsrc/a.py:3')).toEqual(['Options considered'])
  })
  test('plans that name no source file are not code plans', () => {
    expect(missingCodePlanSections('## Itinerary\nDay 1: Lisbon')).toEqual([])
  })
})

/** Backticked identifiers that look like tool names (lowercase snake_case), minus the read-only exec commands. */
function advertisedTools(prompt: string): string[] {
  const commands = new Set<string>(READ_ONLY_COMMANDS)
  return [...prompt.matchAll(/`([a-z][a-z_]*)`/g)].map((m) => m[1]).filter((name) => !commands.has(name))
}

describe('plan mode prompt', () => {
  for (const searchEnabled of [false, true]) {
    test(`every advertised tool is allowed in plan mode (searchEnabled=${searchEnabled})`, () => {
      const tools = advertisedTools(buildPlanModePrompt({ searchEnabled }))
      expect(tools.length).toBeGreaterThan(5)
      for (const name of tools) {
        expect({ name, allowed: PLAN_MODE_ALLOWED_TOOLS.has(name) }).toEqual({ name, allowed: true })
      }
      expect(tools.includes('search')).toBe(searchEnabled)
    })
  }

  test('requires the investigation protocol and the code-change plan sections', () => {
    const prompt = buildPlanModePrompt({ searchEnabled: false })
    expect(prompt).toContain('Investigation protocol (required before `create_plan`)')
    for (const heading of ['## Problem', '## Root cause', '## Options considered', '## Changes', '## Tests', '## Verification', '## Risks']) {
      expect(prompt).toContain(`\`${heading}\``)
    }
    expect(prompt).toContain('`path:line`')
    expect(prompt).toContain('Self-check before calling `create_plan`')
  })

  test('a change request always ends in create_plan, never a snippet to apply by hand', () => {
    const prompt = buildPlanModePrompt({ searchEnabled: false })
    expect(prompt).toContain('Every plan you produce is delivered through `create_plan`')
    expect(prompt).toContain('design and rollout plans as much as code changes')
    expect(prompt).toContain('even when the user does not say "plan"')
    expect(prompt).toContain('Never answer with a plan or a snippet in chat instead')
    expect(prompt).toContain('The editing tools (edit_file, write_file) do not exist in plan mode, and `exec` only runs read-only commands')
    expect(prompt).not.toContain('git_history')
    expect(prompt).toContain("`git log -S '<literal>'`")
  })

  test('no longer asks for a concise plan', () => {
    expect(buildPlanModePrompt({ searchEnabled: true }).toLowerCase()).not.toContain('concise')
  })

  test('keeps the no-mutation rule and the create_plan/update_plan exception', () => {
    const prompt = buildPlanModePrompt({ searchEnabled: false })
    expect(prompt).toContain('You MUST NOT edit source files, run mutating commands, or otherwise change the workspace before the user clicks Build.')
    expect(prompt).toContain('Exception: you may create or update the plan artifact using create_plan/update_plan')
  })
})

describe('PLAN_MODE_ALLOWED_TOOLS', () => {
  test('includes the exploration tools and nothing that mutates', () => {
    for (const name of ['exec', 'impact_radius', 'read_lints', 'read_file']) {
      expect(PLAN_MODE_ALLOWED_TOOLS.has(name)).toBe(true)
    }
    for (const name of ['write_file', 'edit_file', 'delete_file', 'terminal_exec', 'exec_wait', 'publish']) {
      expect(PLAN_MODE_ALLOWED_TOOLS.has(name)).toBe(false)
    }
  })
})

describe('applyInteractionModePrompt', () => {
  test('plan prepends the plan prompt and closes with the reminder', () => {
    const out = applyInteractionModePrompt('BASE', 'plan', { searchEnabled: false })
    expect(out.startsWith('## PLAN MODE ACTIVE')).toBe(true)
    expect(out.endsWith(`\n\n---\n\nBASE\n\n---\n\n${PLAN_MODE_REMINDER}`)).toBe(true)
    expect(PLAN_MODE_REMINDER).toContain('finish by calling `create_plan`')
    expect(PLAN_MODE_REMINDER).toContain('Do not write the plan into your reply')
  })
  test('ask prepends the unchanged ask prompt', () => {
    expect(applyInteractionModePrompt('BASE', 'ask', { searchEnabled: false })).toBe(`${ASK_MODE_PROMPT}\n\n---\n\nBASE`)
    expect(ASK_MODE_PROMPT).toContain('You have no tools available.')
  })
  test('agent mode is unchanged', () => {
    expect(applyInteractionModePrompt('BASE', 'agent', { searchEnabled: true })).toBe('BASE')
    expect(applyInteractionModePrompt('BASE', undefined, { searchEnabled: true })).toBe('BASE')
  })
})

describe('filterToolsForMode', () => {
  const ran: string[] = []
  const tools = ['read_file', 'exec', 'write_file', 'create_plan', 'search'].map((name) => ({
    name,
    label: name,
    description: name,
    parameters: {},
    execute: async (_id: string, params: any) => {
      ran.push(params.command)
      return { content: [], details: {} }
    },
  })) as unknown as AgentTool[]
  test('plan keeps registered allowlisted tools only', () => {
    expect(filterToolsForMode(tools, 'plan').map((t) => t.name)).toEqual(['read_file', 'exec', 'create_plan', 'search'])
    expect(filterToolsForMode(tools.filter((t) => t.name !== 'search'), 'plan').map((t) => t.name)).not.toContain('search')
  })
  test('plan-mode exec only runs read-only commands', async () => {
    const exec = filterToolsForMode(tools, 'plan').find((t) => t.name === 'exec')!
    const refused = await exec.execute('t1', { command: 'rm -rf src' } as any)
    expect(JSON.stringify(refused.content)).toContain('Read-only mode')
    await exec.execute('t2', { command: "rg -n 'TODO'" } as any)
    expect(ran).toEqual(["rg --no-config -n 'TODO'"])
  })
  test('ask has no tools; agent keeps all', () => {
    expect(filterToolsForMode(tools, 'ask')).toEqual([])
    expect(filterToolsForMode(tools, 'agent')).toBe(tools)
  })
})

describe('autoFloorTierFor', () => {
  test('plan turns get a standard floor', () => {
    expect(autoFloorTierFor('plan')).toBe('standard')
    expect(autoFloorTierFor('agent')).toBeUndefined()
    expect(autoFloorTierFor('ask')).toBeUndefined()
    expect(autoFloorTierFor(undefined)).toBeUndefined()
  })
})
