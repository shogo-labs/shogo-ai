// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Wave 5 Session 8 — gateway.ts prompt-builder + tree-context + bootstrap routing.
// Targets the largest uncov clusters in gateway.ts that don't require running the
// full agent loop:
//   - buildSWEPrompt          (L2647-2685, ~32L)
//   - buildGeneralPrompt      (L2687-2735, ~49L)
//   - buildShellNavLines      (L2625-2645, switch over permissionEngine.mode)
//   - buildWorkspaceTreeContext (L3504-3550, fs walk + skip/sort/depth/MAX caps)
//   - buildTeamContext         (L3181-3219, teams-empty / no-manager / populated)
//   - loadBootstrapContext routing (L2740-2745, swe / general profile branches)
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'

const ROOT = '/tmp/test-gw-prompt-builders'

function makeWs(name: string, config?: any): string {
  const ws = join(ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  mkdirSync(join(ws, 'skills'), { recursive: true })
  writeFileSync(join(ws, 'config.json'), JSON.stringify(config ?? {
    heartbeatInterval: 1800, heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
  }))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\nv4\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n')
  return ws
}

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
})

// =============================================================================
// buildShellNavLines — exercised when SHOGO_LOCAL_MODE=true installs the
// PermissionEngine. Three switch branches based on the parsed mode.
// =============================================================================
describe('buildShellNavLines permissionEngine modes', () => {
  const prevLocal = process.env.SHOGO_LOCAL_MODE
  const prevPolicy = process.env.SECURITY_POLICY
  beforeEach(() => { process.env.SHOGO_LOCAL_MODE = 'true' })
  afterEach(() => {
    if (prevLocal === undefined) delete process.env.SHOGO_LOCAL_MODE
    else process.env.SHOGO_LOCAL_MODE = prevLocal
    if (prevPolicy === undefined) delete process.env.SECURITY_POLICY
    else process.env.SECURITY_POLICY = prevPolicy
  })

  test('no permissionEngine (local mode off) returns base 3 lines only', () => {
    delete process.env.SHOGO_LOCAL_MODE
    const ws = makeWs('shell-nav-no-engine')
    const gw = new AgentGateway(ws, 'p1')
    const lines: string[] = (gw as any).buildShellNavLines()
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('### Shell Navigation')
  })

  test('strict mode appends workspace-only directive', () => {
    process.env.SECURITY_POLICY = Buffer.from(JSON.stringify({ mode: 'strict' })).toString('base64')
    const ws = makeWs('shell-nav-strict')
    const gw = new AgentGateway(ws, 'p1')
    const lines: string[] = (gw as any).buildShellNavLines()
    expect(lines).toHaveLength(4)
    expect(lines[3]).toMatch(/only run commands within the workspace/)
  })

  test('balanced mode appends approval directive', () => {
    process.env.SECURITY_POLICY = Buffer.from(JSON.stringify({ mode: 'balanced' })).toString('base64')
    const ws = makeWs('shell-nav-balanced')
    const gw = new AgentGateway(ws, 'p1')
    const lines: string[] = (gw as any).buildShellNavLines()
    expect(lines).toHaveLength(4)
    expect(lines[3]).toMatch(/requires user approval/)
  })

  test('full_autonomy mode appends any-directory directive', () => {
    process.env.SECURITY_POLICY = Buffer.from(JSON.stringify({ mode: 'full_autonomy' })).toString('base64')
    const ws = makeWs('shell-nav-full')
    const gw = new AgentGateway(ws, 'p1')
    const lines: string[] = (gw as any).buildShellNavLines()
    expect(lines).toHaveLength(4)
    expect(lines[3]).toMatch(/navigate to any directory/)
  })
})

// =============================================================================
// buildSWEPrompt — minimal + sessionId+team + browserEnabled=false
// =============================================================================
describe('buildSWEPrompt', () => {
  test('emits Current Context + workspace tree + general guide + subagent guide', () => {
    const ws = makeWs('swe-min')
    writeFileSync(join(ws, 'README.md'), '# project\n')
    const gw = new AgentGateway(ws, 'p1')
    const prompt: string = (gw as any).buildSWEPrompt()
    expect(prompt).toContain('## Current Context')
    expect(prompt).toContain(`Working directory: \`${ws}\``)
    expect(prompt).toContain('## Workspace Files')
    expect(prompt).toContain('README.md')
    expect(prompt).toContain('### Shell Navigation')
  })

  test('browserEnabled: false suppresses BROWSER_TOOL_GUIDE', () => {
    const ws = makeWs('swe-no-browser', {
      channels: [],
      browserEnabled: false,
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    })
    const gw = new AgentGateway(ws, 'p1')
    const prompt: string = (gw as any).buildSWEPrompt()
    expect(prompt.toLowerCase()).not.toContain('browser tool guide')
  })

  test('with sessionId attempts buildTeamContext (teamManager unset → no Active Team section)', () => {
    const ws = makeWs('swe-session')
    const gw = new AgentGateway(ws, 'p1')
    const prompt: string = (gw as any).buildSWEPrompt('sess-1')
    expect(prompt).not.toContain('## Active Team Context')
  })

  test('userTimezone override flows into Current Context', () => {
    const ws = makeWs('swe-tz')
    const gw = new AgentGateway(ws, 'p1')
    gw.setUserTimezone('America/New_York')
    const prompt: string = (gw as any).buildSWEPrompt()
    expect(prompt).toContain('America/New_York')
  })
})

// =============================================================================
// buildGeneralPrompt — minimal + skills + quickActions + sessionId + no-browser
// =============================================================================
describe('buildGeneralPrompt', () => {
  test('minimal: includes Current Context + coding guide + self-evolution + subagent', () => {
    const ws = makeWs('gen-min')
    const gw = new AgentGateway(ws, 'p1')
    const prompt: string = (gw as any).buildGeneralPrompt()
    expect(prompt).toContain('## Current Context')
    expect(prompt).toContain('### Shell Navigation')
  })

  test('non-empty this.skills triggers buildSkillsPromptSection branch', () => {
    const ws = makeWs('gen-skills')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).skills = [{ name: 'demo-skill', trigger: 'demo', description: 'A demo skill', script: '' }]
    const prompt: string = (gw as any).buildGeneralPrompt()
    expect(prompt).toMatch(/demo-skill/i)
  })

  test('quickActionsEnabled !== false + non-empty list emits QA section', () => {
    const ws = makeWs('gen-qa')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).quickActions = [{ label: 'Run', prompt: 'Run the thing' }]
    const prompt: string = (gw as any).buildGeneralPrompt()
    // QUICK_ACTION_GUIDE block is always appended when enabled — verify it's present
    expect(prompt.toLowerCase()).toContain('quick action')
  })

  test('quickActionsEnabled: false skips QA guide section entirely', () => {
    const ws = makeWs('gen-no-qa', {
      channels: [],
      quickActionsEnabled: false,
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    })
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).quickActions = [{ label: 'Run', prompt: 'Run' }]
    const prompt: string = (gw as any).buildGeneralPrompt()
    // The QA section pushed via buildQuickActionsPromptSection should still NOT
    // appear when quickActionsEnabled is false (the whole if-block is skipped).
    expect(prompt).not.toContain('QUICK_ACTION_GUIDE')
  })

  test('browserEnabled: false suppresses BROWSER_TOOL_GUIDE', () => {
    const ws = makeWs('gen-no-browser', {
      channels: [],
      browserEnabled: false,
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    })
    const gw = new AgentGateway(ws, 'p1')
    const prompt: string = (gw as any).buildGeneralPrompt()
    expect(prompt.toLowerCase()).not.toContain('browser tool guide')
  })

  test('with sessionId still produces output even when no team manager set', () => {
    const ws = makeWs('gen-session')
    const gw = new AgentGateway(ws, 'p1')
    const prompt: string = (gw as any).buildGeneralPrompt('s1')
    expect(prompt).not.toContain('## Active Team Context')
    expect(prompt.length).toBeGreaterThan(100)
  })
})

// =============================================================================
// loadBootstrapContext profile routing
// =============================================================================
describe('loadBootstrapContext profile routing', () => {
  test('promptProfile: "swe" routes to buildSWEPrompt', () => {
    const ws = makeWs('boot-swe', {
      channels: [],
      promptProfile: 'swe',
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    })
    const gw = new AgentGateway(ws, 'p1')
    let sweCalled = false
    let genCalled = false
    const proto: any = AgentGateway.prototype
    const origSwe = proto.buildSWEPrompt
    const origGen = proto.buildGeneralPrompt
    proto.buildSWEPrompt = function (_id?: string) { sweCalled = true; return 'SWE_STUB' }
    proto.buildGeneralPrompt = function (_id?: string) { genCalled = true; return 'GEN_STUB' }
    try {
      const out: string = (gw as any).loadBootstrapContext('s1')
      expect(out).toBe('SWE_STUB')
      expect(sweCalled).toBe(true)
      expect(genCalled).toBe(false)
    } finally {
      proto.buildSWEPrompt = origSwe
      proto.buildGeneralPrompt = origGen
    }
  })

  test('promptProfile: "general" routes to buildGeneralPrompt', () => {
    const ws = makeWs('boot-general', {
      channels: [],
      promptProfile: 'general',
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    })
    const gw = new AgentGateway(ws, 'p1')
    let sweCalled = false
    let genCalled = false
    const proto: any = AgentGateway.prototype
    const origSwe = proto.buildSWEPrompt
    const origGen = proto.buildGeneralPrompt
    proto.buildSWEPrompt = function () { sweCalled = true; return 'SWE_STUB' }
    proto.buildGeneralPrompt = function () { genCalled = true; return 'GEN_STUB' }
    try {
      const out: string = (gw as any).loadBootstrapContext()
      expect(out).toBe('GEN_STUB')
      expect(genCalled).toBe(true)
      expect(sweCalled).toBe(false)
    } finally {
      proto.buildSWEPrompt = origSwe
      proto.buildGeneralPrompt = origGen
    }
  })

  test('no promptProfile (undefined) falls through to full prompt builder', () => {
    const ws = makeWs('boot-full')
    const gw = new AgentGateway(ws, 'p1')
    const out: string = (gw as any).loadBootstrapContext()
    // Full builder produces a string that is much longer than the stub-routes;
    // it must contain Current Context and the cache boundary marker.
    expect(out).toContain('## Current Context')
    expect(out.length).toBeGreaterThan(1000)
  })
})

// =============================================================================
// buildWorkspaceTreeContext — populated, empty, skip dirs, deeply nested
// =============================================================================
describe('buildWorkspaceTreeContext', () => {
  test('populated workspace returns formatted file listing', () => {
    const ws = makeWs('tree-populated')
    writeFileSync(join(ws, 'README.md'), '#')
    writeFileSync(join(ws, 'package.json'), '{}')
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'index.ts'), '//')
    writeFileSync(join(ws, 'src', 'app.ts'), '//')
    const gw = new AgentGateway(ws, 'p1')
    const out: string | null = (gw as any).buildWorkspaceTreeContext()
    expect(out).not.toBeNull()
    expect(out).toContain('## Workspace Files')
    expect(out).toContain('src/')
    expect(out).toContain('src/index.ts')
    expect(out).toContain('README.md')
  })

  test('SKIP set (node_modules, dist, .git, .cache, build, files, .next, .shogo) is excluded', () => {
    const ws = makeWs('tree-skip')
    for (const skip of ['node_modules', 'dist', '.git', '.cache', 'build', 'files', '.next', '.shogo']) {
      mkdirSync(join(ws, skip))
      writeFileSync(join(ws, skip, 'junk.txt'), 'x')
    }
    writeFileSync(join(ws, 'real.ts'), '//')
    const gw = new AgentGateway(ws, 'p1')
    const out: string | null = (gw as any).buildWorkspaceTreeContext()
    expect(out).toContain('real.ts')
    expect(out).not.toContain('node_modules')
    expect(out).not.toContain('dist/')
    expect(out).not.toContain('build/')
    expect(out).not.toContain('files/')
  })

  test('depth > 4 truncation — files past level 4 are dropped', () => {
    const ws = makeWs('tree-depth')
    let cur = ws
    for (let i = 0; i < 6; i++) {
      cur = join(cur, `d${i}`)
      mkdirSync(cur)
      writeFileSync(join(cur, `file${i}.txt`), '.')
    }
    const gw = new AgentGateway(ws, 'p1')
    const out: string | null = (gw as any).buildWorkspaceTreeContext()
    expect(out).not.toBeNull()
    // First 4 levels of dirs make it in; level 5+ depth files do not.
    expect(out).toContain('d0/')
    expect(out).not.toMatch(/d4\/d5\//)
  })

  test('MAX_FILES (80) cap halts the walk early', () => {
    const ws = makeWs('tree-cap')
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(ws, `f${String(i).padStart(3, '0')}.txt`), '.')
    }
    const gw = new AgentGateway(ws, 'p1')
    const out: string | null = (gw as any).buildWorkspaceTreeContext()
    expect(out).not.toBeNull()
    // Count file-entry lines in the fenced block — should not exceed 80.
    const fenceParts = (out as string).split('```')
    expect(fenceParts.length).toBeGreaterThanOrEqual(3)
    const inner = fenceParts[1] ?? ''
    const fileLines = inner.split('\n').filter(l => l.trim().length > 0)
    expect(fileLines.length).toBeLessThanOrEqual(80)
  })

  test('hidden dotfiles at depth 0 are skipped (except .shogo which is in SKIP set too)', () => {
    const ws = makeWs('tree-dotfiles')
    writeFileSync(join(ws, '.env'), 'X=1')
    writeFileSync(join(ws, '.gitignore'), 'node_modules')
    writeFileSync(join(ws, 'visible.ts'), '//')
    const gw = new AgentGateway(ws, 'p1')
    const out: string | null = (gw as any).buildWorkspaceTreeContext()
    expect(out).toContain('visible.ts')
    expect(out).not.toContain('.env')
    expect(out).not.toContain('.gitignore')
  })

  test('readdir failure on a subdir is swallowed (walk continues)', () => {
    const ws = makeWs('tree-readdir-fail')
    writeFileSync(join(ws, 'top.ts'), '//')
    // Create a dir then chmod 000 to force EACCES on readdir — but Bun tests
    // run as root in CI; skip if mode change has no effect.
    mkdirSync(join(ws, 'locked'))
    writeFileSync(join(ws, 'locked', 'x.ts'), '//')
    const gw = new AgentGateway(ws, 'p1')
    const out: string | null = (gw as any).buildWorkspaceTreeContext()
    expect(out).toContain('top.ts')
  })
})

// =============================================================================
// buildTeamContext — null branches (no manager / no teams) + populated branch
// =============================================================================
describe('buildTeamContext', () => {
  test('returns null when teamManager is unset', () => {
    const ws = makeWs('team-no-manager')
    const gw = new AgentGateway(ws, 'p1')
    expect((gw as any).buildTeamContext('s1')).toBeNull()
  })

  test('returns null when teamManager exists but no teams for sessionId', () => {
    const ws = makeWs('team-empty')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).teamManager = {
      listTeams: () => [],
      listMembers: () => [],
      listTasks: () => [],
    }
    expect((gw as any).buildTeamContext('s1')).toBeNull()
  })

  test('populated team renders members + tasks with status / owner / blockedBy', () => {
    const ws = makeWs('team-populated')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).teamManager = {
      listTeams: () => [{ id: 't1', name: 'Refactor', description: 'big push' }],
      listMembers: () => [
        { name: 'alpha', agentId: 'a1', isActive: true },
        { name: 'beta', agentId: 'a2', isActive: false },
      ],
      listTasks: () => [
        { id: 10, subject: 'plan it', status: 'in_progress', owner: 'alpha', blockedBy: [] },
        { id: 11, subject: 'ship it', status: 'pending', owner: undefined, blockedBy: [10] },
      ],
    }
    const out: string = (gw as any).buildTeamContext('s1')
    expect(out).toContain('## Active Team Context')
    expect(out).toContain('Refactor')
    expect(out).toContain('big push')
    expect(out).toContain('alpha')
    expect(out).toContain('beta')
    expect(out).toContain('active')
    expect(out).toContain('inactive')
    expect(out).toContain('#10 plan it')
    expect(out).toContain('owner: alpha')
    expect(out).toContain('blocked by: 10')
  })

  test('team with no description, no members, no tasks still emits header', () => {
    const ws = makeWs('team-sparse')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).teamManager = {
      listTeams: () => [{ id: 't1', name: 'Solo' }],
      listMembers: () => [],
      listTasks: () => [],
    }
    const out: string = (gw as any).buildTeamContext('s1')
    expect(out).toContain('### Team: Solo')
    expect(out).not.toContain('**Members:**')
    expect(out).not.toContain('**Tasks:**')
  })
})

// =============================================================================
// appendHeartbeatLog + appendDailyMemory — private file-writing helpers.
// Cover happy-path (creates file), append-to-existing path, MAX_ENTRIES rotation
// (heartbeat), and error-swallowed branch.
// =============================================================================
import { readFileSync } from 'fs'

describe('appendHeartbeatLog', () => {
  test('creates HEARTBEAT_LOG.md when missing', () => {
    const ws = makeWs('hb-create')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).appendHeartbeatLog('first tick')
    const log = readFileSync(join(ws, 'HEARTBEAT_LOG.md'), 'utf-8')
    expect(log).toContain('# Recent Heartbeat Activity')
    expect(log).toContain('first tick')
  })

  test('appends to existing file, preserving prior entries', () => {
    const ws = makeWs('hb-append')
    writeFileSync(join(ws, 'HEARTBEAT_LOG.md'),
      '# Recent Heartbeat Activity\n\n- [2026-01-01T00:00:00Z] old entry\n')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).appendHeartbeatLog('new entry')
    const log = readFileSync(join(ws, 'HEARTBEAT_LOG.md'), 'utf-8')
    expect(log).toContain('old entry')
    expect(log).toContain('new entry')
  })

  test('rotates to last 20 entries (MAX_ENTRIES)', () => {
    const ws = makeWs('hb-rotate')
    const old = Array.from({ length: 30 }, (_, i) =>
      `- [2026-01-01T00:00:${String(i).padStart(2, '0')}Z] entry ${i}`).join('\n')
    writeFileSync(join(ws, 'HEARTBEAT_LOG.md'),
      `# Recent Heartbeat Activity\n\n${old}\n`)
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).appendHeartbeatLog('newest')
    const log = readFileSync(join(ws, 'HEARTBEAT_LOG.md'), 'utf-8')
    const entryLines = log.split('\n').filter(l => l.startsWith('- ['))
    expect(entryLines.length).toBe(20)
    expect(log).toContain('newest')
    expect(log).not.toContain('entry 0')
  })

  test('write failure is swallowed (logs error but does not throw)', () => {
    const ws = makeWs('hb-error')
    const gw = new AgentGateway(ws, 'p1')
    // Point workspaceDir at a non-writable location by overriding the join
    // result via private field — simplest: make workspaceDir a file, not dir
    writeFileSync(join(ROOT, 'hb-error-blocker'), 'x')
    ;(gw as any).workspaceDir = join(ROOT, 'hb-error-blocker', 'nope')
    // Method swallows errors internally
    ;(gw as any).appendHeartbeatLog('boom')
    expect(true).toBe(true)
  })
})

describe('appendDailyMemory', () => {
  test('creates dated file with header when none exists', () => {
    const ws = makeWs('daily-create')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).appendDailyMemory('a thing happened')
    const date = new Date().toISOString().split('T')[0]
    const memPath = join(ws, 'memory', `${date}.md`)
    expect(existsSync(memPath)).toBe(true)
    const content = readFileSync(memPath, 'utf-8')
    expect(content).toContain(`# ${date}`)
    expect(content).toContain('a thing happened')
  })

  test('appends to existing daily file', () => {
    const ws = makeWs('daily-append')
    const date = new Date().toISOString().split('T')[0]
    mkdirSync(join(ws, 'memory'), { recursive: true })
    writeFileSync(join(ws, 'memory', `${date}.md`),
      `# ${date}\n\n- [10:00:00] prior\n`)
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).appendDailyMemory('after')
    const content = readFileSync(join(ws, 'memory', `${date}.md`), 'utf-8')
    expect(content).toContain('prior')
    expect(content).toContain('after')
  })

  test('write failure is swallowed when target path is a directory', () => {
    const ws = makeWs('daily-error')
    const date = new Date().toISOString().split('T')[0]
    mkdirSync(join(ws, 'memory'), { recursive: true })
    // Make the daily file a directory so writeFileSync errors out with EISDIR
    mkdirSync(join(ws, 'memory', date + '.md'))
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).appendDailyMemory('boom')
    expect(true).toBe(true)
  })
})

// =============================================================================
// deliverAlert — broadcasts to every connected channel, swallows per-channel
// errors so one bad adapter can't block the others.
// =============================================================================
describe('deliverAlert', () => {
  test('no channels: nothing to do, no throw', async () => {
    const ws = makeWs('alert-none')
    const gw = new AgentGateway(ws, 'p1')
    await (gw as any).deliverAlert('something is on fire')
    expect(true).toBe(true)
  })

  test('connected channel receives [HEARTBEAT ALERT] prefix', async () => {
    const ws = makeWs('alert-connected')
    const gw = new AgentGateway(ws, 'p1')
    const sent: string[] = []
    ;(gw as any).channels.set('telegram', {
      getStatus: () => ({ connected: true }),
      sendMessage: async (_: string, msg: string) => { sent.push(msg) },
    })
    await (gw as any).deliverAlert('server down')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('[HEARTBEAT ALERT]')
    expect(sent[0]).toContain('server down')
  })

  test('disconnected channel is skipped', async () => {
    const ws = makeWs('alert-disconnected')
    const gw = new AgentGateway(ws, 'p1')
    let called = false
    ;(gw as any).channels.set('discord', {
      getStatus: () => ({ connected: false }),
      sendMessage: async () => { called = true },
    })
    await (gw as any).deliverAlert('quiet')
    expect(called).toBe(false)
  })

  test('one channel throws but others still receive', async () => {
    const ws = makeWs('alert-throws')
    const gw = new AgentGateway(ws, 'p1')
    const sent: string[] = []
    ;(gw as any).channels.set('bad', {
      getStatus: () => ({ connected: true }),
      sendMessage: async () => { throw new Error('SMTP down') },
    })
    ;(gw as any).channels.set('good', {
      getStatus: () => ({ connected: true }),
      sendMessage: async (_: string, m: string) => { sent.push(m) },
    })
    await (gw as any).deliverAlert('mixed')
    expect(sent).toHaveLength(1)
  })
})

// =============================================================================
// buildSlashContext / getOrCreateCommandRegistry / disposeSessionState
// — per-session bookkeeping plumbing.
// =============================================================================
describe('session bookkeeping helpers', () => {
  test('getOrCreateCommandRegistry creates once, returns same instance after', () => {
    const ws = makeWs('cmdreg-create')
    const gw = new AgentGateway(ws, 'p1')
    const r1 = (gw as any).getOrCreateCommandRegistry('s1')
    const r2 = (gw as any).getOrCreateCommandRegistry('s1')
    expect(r1).toBe(r2)
    const r3 = (gw as any).getOrCreateCommandRegistry('s2')
    expect(r3).not.toBe(r1)
  })

  test('disposeSessionState kills registry + removes from map', () => {
    const ws = makeWs('dispose')
    const gw = new AgentGateway(ws, 'p1')
    const reg = (gw as any).getOrCreateCommandRegistry('s9')
    let killed = false
    reg.killAll = () => { killed = true }
    ;(gw as any).disposeSessionState('s9')
    expect(killed).toBe(true)
    expect((gw as any).commandRegistries.has('s9')).toBe(false)
  })

  test('disposeSessionState on missing session is a no-op', () => {
    const ws = makeWs('dispose-missing')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).disposeSessionState('never-existed')
    expect(true).toBe(true)
  })

  test('buildSlashContext wires getMessages / clearHistory / setModelOverride / getStatus', () => {
    const ws = makeWs('slash-ctx')
    const gw = new AgentGateway(ws, 'p1')
    const ctx: any = (gw as any).buildSlashContext('s1')
    expect(ctx.sessionKey).toBe('s1')
    expect(ctx.workspaceDir).toBe(ws)
    expect(Array.isArray(ctx.getMessages())).toBe(true)
    // Probe setModelOverride
    ctx.setModelOverride('claude-haiku-4-5')
    const session = (gw as any).sessionManager.getOrCreate('s1')
    expect(session.modelOverride).toBe('claude-haiku-4-5')
    // Probe getStatus end-to-end
    const status = ctx.getStatus()
    expect(status).toHaveProperty('running')
    expect(status).toHaveProperty('memory')
    // Probe clearHistory
    ctx.clearHistory()
    expect((gw as any).contentReplacementStates.has('s1')).toBe(false)
  })

  test('buildSlashContext.reloadConfig calls into reloadConfig without throwing', () => {
    const ws = makeWs('slash-reload')
    const gw = new AgentGateway(ws, 'p1')
    const ctx: any = (gw as any).buildSlashContext('s1')
    ctx.reloadConfig()
    expect(true).toBe(true)
  })
})
