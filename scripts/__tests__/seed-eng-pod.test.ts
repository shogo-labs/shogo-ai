// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  APPLY_PROMPT,
  BRIEFING_NAME,
  configFromEnv,
  parseFlags,
  readBriefingPrompt,
  readReply,
  REAPPLY_PROMPT,
  seedEngPod,
  TEAM_CHANNEL,
  type SeedConfig,
  type SeedDeps,
} from '../demo/seed-eng-pod'
import { PROJECT_NAMES } from '../../packages/agent-runtime/src/eng-pod-manifest-gen'

/** A small in-memory stand-in for the API the seed talks to. */
function fakeApi(opts: { applyCreatesTeam?: boolean; promptsOnAttempt?: number } = {}) {
  const state = {
    projects: [] as Array<{ id: string; name: string }>,
    channels: [] as Array<{ id: string; name: string }>,
    schedules: [] as any[],
    calls: [] as string[],
    asked: [] as string[],
    files: [] as Array<{ path: string; content: string }>,
    groups: [] as any[],
    prompts: new Set<string>(),
  }
  let n = 0
  const api: SeedDeps['api'] = async (method, path, body: any) => {
    state.calls.push(`${method} ${path}`)
    if (method === 'PUT' && path.includes('/files/')) {
      state.files.push({ path, content: body.content })
      return { ok: true }
    }
    if (method === 'GET' && path.endsWith('/user-groups')) return { groups: state.groups }
    if (method === 'POST' && path.endsWith('/user-groups')) {
      state.groups.push(body)
      return { group: body }
    }
    if (method === 'GET' && path.endsWith('/files/AGENTS.md')) {
      if (!state.prompts.has(path.split('/')[2]!)) throw new Error('404')
      return { content: 'prompt' }
    }
    if (method === 'GET' && path.startsWith('/projects?')) return { items: state.projects }
    if (method === 'POST' && path === '/projects') {
      const p = { id: `p${++n}`, name: body.name }
      state.projects.push(p)
      return { data: p }
    }
    if (method === 'GET' && path.endsWith('/conversations')) return { conversations: state.channels }
    if (method === 'GET' && path.endsWith('/schedules')) return { schedules: state.schedules }
    if (method === 'POST' && path.endsWith('/schedules')) {
      const s = { id: `s${++n}`, ...body }
      state.schedules.push(s)
      return { schedule: s }
    }
    if (method === 'PATCH' && path.includes('/schedules/')) {
      Object.assign(state.schedules.find((s) => path.endsWith(s.id))!, body)
      return {}
    }
    return {}
  }
  const askCoordinator = async (message: string) => {
    state.asked.push(message)
    if (opts.applyCreatesTeam !== false && !state.channels.length) {
      state.projects.push({ id: `p${++n}`, name: PROJECT_NAMES.builder }, { id: `p${++n}`, name: PROJECT_NAMES.reviewer })
      state.channels.push({ id: 'c1', name: TEAM_CHANNEL })
    }
    if (state.asked.length >= (opts.promptsOnAttempt ?? 1)) {
      for (const p of state.projects) if (p.name !== PROJECT_NAMES.coordinator) state.prompts.add(p.id)
    }
    return 'Applied: created #eng, 2 projects'
  }
  return { state, api, askCoordinator }
}

const config = (over: Partial<SeedConfig> = {}): SeedConfig => ({
  workspaceId: 'ws1',
  githubRepo: 'acme/checkout',
  githubInstallationId: 42,
  briefingCron: '0 9 * * 1-5',
  briefingTimezone: 'UTC',
  briefingPrompt: 'Post the briefing',
  manifestYaml: 'version: 1\n',
  maintainerUserIds: ['u1'],
  flags: { resetRepo: false, runBriefing: false, slack: false },
  ...over,
})

describe('seedEngPod', () => {
  test('a fresh workspace gets the coordinator, the team, GitHub and the briefing', async () => {
    const fake = fakeApi()
    const logs: string[] = []
    const result = await seedEngPod(config(), { api: fake.api, askCoordinator: fake.askCoordinator, log: (l) => logs.push(l) })

    expect(fake.state.projects.map((p) => p.name)).toEqual([PROJECT_NAMES.coordinator, PROJECT_NAMES.builder, PROJECT_NAMES.reviewer])
    expect(fake.state.asked).toEqual([APPLY_PROMPT])
    // The manifest is written to the coordinator before it is asked to apply it.
    expect(fake.state.files).toEqual([
      { path: '/projects/p1/files/shogo-system.yaml', content: 'version: 1\n' },
    ])
    expect(fake.state.groups).toEqual([expect.objectContaining({ handle: 'maintainers', memberIds: ['u1'] })])
    expect(result.channelId).toBe('c1')
    expect(Object.keys(result.projectIds).sort()).toEqual(['builder', 'coordinator', 'reviewer'])
    expect(fake.state.calls.filter((c) => c.endsWith('/github/connect'))).toHaveLength(3)
    expect(fake.state.schedules).toHaveLength(1)
    expect(fake.state.schedules[0]).toMatchObject({
      name: BRIEFING_NAME,
      cronExpression: '0 9 * * 1-5',
      notifyConversationId: 'c1',
      enabled: true,
    })
    expect(result.todo).toEqual([])
    expect(fake.state.calls).toContain('POST /projects')
  })

  test('creates the coordinator from the eng-pod template', async () => {
    const created: any[] = []
    const fake = fakeApi()
    const api: SeedDeps['api'] = async (m, p, b) => {
      if (m === 'POST' && p === '/projects') created.push(b)
      return fake.api(m, p, b)
    }
    await seedEngPod(config(), { api, askCoordinator: fake.askCoordinator, log: () => {} })
    expect(created[0]).toMatchObject({ workspaceId: 'ws1', templateId: 'eng-pod', name: PROJECT_NAMES.coordinator })
  })

  test('running again applies the manifest again, adds no projects and refreshes the briefing', async () => {
    const fake = fakeApi()
    const deps = { api: fake.api, askCoordinator: fake.askCoordinator, log: () => {} }
    await seedEngPod(config(), deps)
    const projects = fake.state.projects.length
    await seedEngPod(config({ briefingCron: '30 8 * * 1-5' }), deps)
    expect(fake.state.projects).toHaveLength(projects)
    expect(fake.state.asked).toHaveLength(2)
    expect(fake.state.schedules).toHaveLength(1)
    expect(fake.state.schedules[0].cronExpression).toBe('30 8 * * 1-5')
  })

  test('asks again when the new projects were not reachable the first time', async () => {
    const fake = fakeApi({ promptsOnAttempt: 2 })
    await seedEngPod(config(), { api: fake.api, askCoordinator: fake.askCoordinator, log: () => {} })
    expect(fake.state.asked).toHaveLength(2)
    expect(fake.state.asked[0]).toBe(APPLY_PROMPT)
    expect(fake.state.asked[1]).toBe(REAPPLY_PROMPT)
  })

  test('gives up with a clear error when the prompts never land', async () => {
    const fake = fakeApi({ promptsOnAttempt: 99 })
    await expect(seedEngPod(config(), { api: fake.api, askCoordinator: fake.askCoordinator, log: () => {} })).rejects.toThrow(
      'did not write AGENTS.md',
    )
    expect(fake.state.asked).toHaveLength(3)
  })

  test('without a coordinator runtime it says what to do instead of failing', async () => {
    const fake = fakeApi()
    const result = await seedEngPod(config(), { api: fake.api, log: () => {} })
    expect(result.channelId).toBeNull()
    expect(result.todo.some((t) => t.includes('system_apply'))).toBe(true)
    expect(fake.state.schedules).toHaveLength(0)
  })

  test('fails loudly when system_apply does not produce the team', async () => {
    const fake = fakeApi({ applyCreatesTeam: false })
    await expect(seedEngPod(config(), { api: fake.api, askCoordinator: fake.askCoordinator, log: () => {} })).rejects.toThrow(
      'did not create #eng',
    )
  })

  test('flags: run the briefing now, reset the repo, bridge Slack', async () => {
    const fake = fakeApi()
    let reset = 0
    await seedEngPod(config({ flags: { resetRepo: true, runBriefing: true, slack: true } }), {
      api: fake.api,
      askCoordinator: fake.askCoordinator,
      resetRepo: async () => void reset++,
      log: () => {},
    })
    expect(reset).toBe(1)
    expect(fake.state.calls.some((c) => /POST \/workspaces\/ws1\/schedules\/s\d+\/run/.test(c))).toBe(true)
    expect(fake.state.calls).toContain('PATCH /workspaces/ws1/chat-mode')
  })

  test('--reset-repo needs a repo', async () => {
    const fake = fakeApi()
    await expect(
      seedEngPod(config({ flags: { resetRepo: true, runBriefing: false, slack: false } }), { api: fake.api, askCoordinator: fake.askCoordinator, log: () => {} }),
    ).rejects.toThrow('GITHUB_TEST_REPO')
  })

  test('without GitHub settings it asks for them', async () => {
    const fake = fakeApi()
    const result = await seedEngPod(config({ githubRepo: undefined, githubInstallationId: undefined }), {
      api: fake.api,
      askCoordinator: fake.askCoordinator,
      log: () => {},
    })
    expect(result.todo.some((t) => t.includes('GITHUB_INSTALLATION_ID'))).toBe(true)
    expect(fake.state.calls.some((c) => c.endsWith('/github/connect'))).toBe(false)
  })
})

describe('config', () => {
  test('parses flags and env', () => {
    expect(parseFlags(['--reset-repo', '--slack'])).toEqual({ resetRepo: true, runBriefing: false, slack: true })
    const c = configFromEnv({ WORKSPACE_ID: 'w', GITHUB_TEST_REPO: 'a/b', GITHUB_INSTALLATION_ID: '7' }, [])
    expect(c).toMatchObject({ workspaceId: 'w', githubRepo: 'a/b', githubInstallationId: 7, briefingCron: '0 9 * * 1-5', briefingTimezone: 'UTC' })
    expect(c.briefingPrompt).toContain('Shipped')
    expect(c.manifestYaml).toContain('anchor: coordinator')
  })

  test('rejects bad input', () => {
    expect(() => configFromEnv({}, [])).toThrow('WORKSPACE_ID')
    expect(() => configFromEnv({ WORKSPACE_ID: 'w', GITHUB_TEST_REPO: 'nope' }, [])).toThrow('<owner>/<repo>')
    expect(() => configFromEnv({ WORKSPACE_ID: 'w', GITHUB_INSTALLATION_ID: 'x' }, [])).toThrow('number')
  })

  test('the briefing prompt ships with the template', () => {
    expect(readBriefingPrompt()).toContain('Waiting on you')
  })
})

describe('readReply', () => {
  test('joins text deltas and ignores other events', async () => {
    const sse = ['data: {"type":"start-step"}', 'data: {"type":"text-delta","delta":"Applied "}', ': keep-alive', 'data: {"type":"text-delta","delta":"#eng"}', 'data: [DONE]', ''].join('\n')
    expect(await readReply(new Response(sse))).toBe('Applied #eng')
  })

  test('surfaces stream errors', async () => {
    expect(await readReply(new Response('data: {"type":"error","errorText":"no key"}\n'))).toBe('[error: no key]')
  })
})
