// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Browser advertisement contract (issue #1044).
 *
 * A `browser` tool exists on the main agent only when
 * `mainAgentBrowserAvailable()` (browser-capability.ts) says so. Personal
 * workspaces have no orchestration, so `browser` is stripped there unless the
 * `personalBrowserEnabled` flag (or SHOGO_PERSONAL_BROWSER=1) is set.
 *
 * Historically the tool filter, the inlined BROWSER_TOOL_GUIDE and the
 * Capabilities Index disagreed: the personal agent was told to
 * `agent_spawn({ type: "browser" })` and handed the full browser workflow while
 * the tool was removed — the "I can browse" / "I cannot open it" contradiction.
 *
 * This proves every originating surface AGREES for all FOUR states of
 * (capabilityProfile × personalBrowserEnabled):
 *   1. registered tool names           (filterDisabledCapabilityTools → filterSubagentOnlyTools)
 *   2. the inlined guide               (buildSWEPrompt → mainAgentBrowserAvailable)
 *   3. the Capabilities Index `browser` line   (buildCapabilitiesIndex)
 *   4. the Capabilities Index `subagentTypes`  (buildCapabilitiesIndex)
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { createTools, filterDisabledCapabilityTools, filterSubagentOnlyTools, type ToolContext } from '../gateway-tools'
import { buildCapabilitiesIndex } from '../guide-registry'
import { BROWSER_TOOL_GUIDE } from '../optimized-prompts'
import { FileStateCache } from '../file-state-cache'
import { AgentGateway, type GatewayConfig } from '../gateway'
import { isPersonalBrowserEnabled, mainAgentBrowserAvailable, browserIsDelegated } from '../browser-capability'

const ROOT = '/tmp/test-browser-advertisement-contract'

const prevEnv = process.env.SHOGO_PERSONAL_BROWSER
afterEach(() => {
  if (prevEnv === undefined) delete process.env.SHOGO_PERSONAL_BROWSER
  else process.env.SHOGO_PERSONAL_BROWSER = prevEnv
})

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
})

type Profile = 'team' | 'personal'

interface State {
  name: string
  profile: Profile
  flag: boolean
  /** Expected: browser tool is registered + advertised. */
  advertised: boolean
  /** Expected: browsing is delegated (subagent) rather than direct. */
  delegated: boolean
}

const STATES: State[] = [
  { name: 'team / flag off', profile: 'team', flag: false, advertised: true, delegated: true },
  { name: 'team / flag on', profile: 'team', flag: true, advertised: true, delegated: true },
  { name: 'personal / flag off', profile: 'personal', flag: false, advertised: false, delegated: false },
  { name: 'personal / flag on', profile: 'personal', flag: true, advertised: true, delegated: false },
]

function makeConfig(state: State, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    heartbeatInterval: 1800,
    heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    ...(state.profile === 'personal' ? { capabilityProfile: 'personal' as const } : {}),
    personalBrowserEnabled: state.flag,
    ...overrides,
  }
}

function makeCtx(config: GatewayConfig): ToolContext {
  return {
    workspaceDir: join(ROOT, 'ctx'),
    channels: new Map(),
    config,
    projectId: 'test',
    workspaceId: 'workspace-1',
    fileStateCache: new FileStateCache(),
  }
}

/** The gateway's main-agent tool pipeline (gateway.ts: filterDisabled → filterSubagentOnly). */
function registeredToolNames(config: GatewayConfig): Set<string> {
  const tools = createTools(makeCtx(config))
  return new Set(filterSubagentOnlyTools(filterDisabledCapabilityTools(tools, config), config).map(t => t.name))
}

/** The `subagentTypes` list embedded in the Capabilities Index `subagent` line. */
function subagentTypes(index: string): string[] {
  const line = index.split('\n').find((l) => l.startsWith('- **subagent**'))
  const list = line?.match(/— (.*)\. Read/)?.[1] ?? ''
  return list.split(', ')
}

function makeWs(name: string, config: Record<string, unknown>): string {
  const ws = join(ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  mkdirSync(join(ws, 'skills'), { recursive: true })
  writeFileSync(join(ws, 'config.json'), JSON.stringify(config))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n')
  return ws
}

describe('predicate truth table (browser-capability.ts)', () => {
  for (const state of STATES) {
    test(`${state.name}: predicates match expectations`, () => {
      delete process.env.SHOGO_PERSONAL_BROWSER
      const config = makeConfig(state)
      expect(isPersonalBrowserEnabled(config)).toBe(state.flag)
      expect(browserIsDelegated(config)).toBe(state.delegated)
      expect(mainAgentBrowserAvailable(config)).toBe(state.advertised)
    })
  }

  test('SHOGO_PERSONAL_BROWSER=1 overrides the flag on a personal workspace', () => {
    process.env.SHOGO_PERSONAL_BROWSER = '1'
    const config = makeConfig(STATES[2]) // personal / flag off
    expect(isPersonalBrowserEnabled(config)).toBe(true)
    expect(mainAgentBrowserAvailable(config)).toBe(true)
    expect(registeredToolNames(config).has('browser')).toBe(true)
  })

  test('browserEnabled: false wins over the personal flag', () => {
    process.env.SHOGO_PERSONAL_BROWSER = '1'
    const config = makeConfig(STATES[3], { browserEnabled: false }) // personal / flag on
    expect(mainAgentBrowserAvailable(config)).toBe(false)
  })
})

describe('browser advertisement contract — all surfaces agree in all four states', () => {
  for (const state of STATES) {
    test(`${state.name}`, () => {
      delete process.env.SHOGO_PERSONAL_BROWSER
      const config = makeConfig(state)
      const available = mainAgentBrowserAvailable(config)
      const delegated = browserIsDelegated(config)

      // (1) registered tool names
      const registered = registeredToolNames(config)
      const hasBrowser = registered.has('browser')

      // (2+3) advertised surfaces driven by the same flags the gateway passes
      // to buildCapabilitiesIndex (gateway.ts ~3903-3911).
      const index = buildCapabilitiesIndex({ browser: available, browserDelegated: delegated })
      const indexAdvertisesBrowser = index.includes('- **browser**')
      const subagentListsBrowser = subagentTypes(index).includes('browser')

      // The contract: every surface reflects the exact same predicate value.
      expect(available).toBe(state.advertised)
      expect(delegated).toBe(state.delegated)
      expect(hasBrowser).toBe(state.advertised)
      expect(indexAdvertisesBrowser).toBe(state.advertised)
      expect(subagentListsBrowser).toBe(state.advertised && state.delegated)

      // Cross-surface agreement (this is the bug class: any two disagreeing).
      expect(indexAdvertisesBrowser).toBe(hasBrowser)
      expect(subagentListsBrowser).toBe(hasBrowser && delegated)

      // Wording must match delegation: a personal agent must never be pointed
      // at agent_spawn for the browser, and a team agent must not be told to
      // call `browser` directly.
      if (state.advertised && state.delegated) {
        expect(index).toContain('agent_spawn({ type: "browser"')
      } else if (state.advertised && !state.delegated) {
        expect(index).toContain('Call `browser` directly')
        expect(index).not.toContain('agent_spawn({ type: "browser"')
      } else {
        expect(index).not.toContain('agent_spawn({ type: "browser"')
      }
    })
  }
})

describe('browser advertisement contract — inlined guide matches registration', () => {
  for (const state of STATES) {
    test(`${state.name}: buildSWEPrompt includes BROWSER_TOOL_GUIDE iff browser is registered`, () => {
      delete process.env.SHOGO_PERSONAL_BROWSER
      const config = makeConfig(state)
      const ws = makeWs(`swe-${state.profile}-${state.flag ? 'on' : 'off'}`, {
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
        ...(state.profile === 'personal' ? { capabilityProfile: 'personal' } : {}),
        personalBrowserEnabled: state.flag,
        browserEnabled: true,
      })
      const gw = new AgentGateway(ws, 'p1')
      const prompt: string = (gw as any).buildSWEPrompt()
      const guideInlined = prompt.includes(BROWSER_TOOL_GUIDE)
      expect(guideInlined).toBe(state.advertised)
      // And the guide agrees with the registered tool list.
      expect(guideInlined).toBe(registeredToolNames(config).has('browser'))
    })
  }
})
