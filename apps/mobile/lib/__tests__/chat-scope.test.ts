// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local vs cloud matrix for chat scoping. Workspace vs project scoping was
 * fixed in 7+ separate commits after 2.0, each time in one screen and one
 * mode; this pins every surface in both modes at once.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  currentChatScopeEnv,
  resolveChatScope,
  type ChatScope,
  type ChatScopeEnv,
  type ChatScopeSurface,
} from '../chat-scope'

const LOCAL: ChatScopeEnv = { workspaceRuntimeEnabled: true, projectWorkspaceRuntimeEnabled: true }
const CLOUD: ChatScopeEnv = { workspaceRuntimeEnabled: true, projectWorkspaceRuntimeEnabled: false }

const cases: Array<[string, ChatScopeSurface, { local: ChatScope; cloud: ChatScope }]> = [
  ['home draft', { surface: 'home-draft' }, { local: 'workspace', cloud: 'workspace' }],
  [
    'project page, initial tab handed a workspace draft',
    { surface: 'project-tab', isInitialSession: true, requestedScope: 'workspace' },
    { local: 'workspace', cloud: 'workspace' },
  ],
  [
    'project page, initial tab opened as a project chat',
    { surface: 'project-tab', isInitialSession: true, requestedScope: 'project' },
    { local: 'workspace', cloud: 'project' },
  ],
  [
    'project page, later tab',
    { surface: 'project-tab', isInitialSession: false, requestedScope: 'workspace' },
    { local: 'workspace', cloud: 'project' },
  ],
  [
    'project chat route, workspace session',
    { surface: 'project-chat', requestedScope: 'workspace' },
    { local: 'workspace', cloud: 'workspace' },
  ],
  [
    'project chat route, project session',
    { surface: 'project-chat', requestedScope: 'project' },
    { local: 'project', cloud: 'project' },
  ],
]

describe('resolveChatScope matrix', () => {
  for (const [name, input, expected] of cases) {
    it(`${name}: local=${expected.local}, cloud=${expected.cloud}`, () => {
      expect(resolveChatScope(input, LOCAL)).toBe(expected.local)
      expect(resolveChatScope(input, CLOUD)).toBe(expected.cloud)
    })
  }

  it('falls back to project scope everywhere when workspace sessions are off', () => {
    const off: ChatScopeEnv = { workspaceRuntimeEnabled: false, projectWorkspaceRuntimeEnabled: false }
    for (const [, input] of cases) expect(resolveChatScope(input, off)).toBe('project')
  })
})

describe('currentChatScopeEnv follows the build mode', () => {
  const original = process.env.EXPO_PUBLIC_LOCAL_MODE
  afterEach(() => {
    if (original === undefined) delete process.env.EXPO_PUBLIC_LOCAL_MODE
    else process.env.EXPO_PUBLIC_LOCAL_MODE = original
  })

  it('local build pins project tabs to the workspace session', () => {
    process.env.EXPO_PUBLIC_LOCAL_MODE = 'true'
    expect(currentChatScopeEnv()).toEqual(LOCAL)
  })

  it('cloud build keeps project tabs project-scoped', () => {
    process.env.EXPO_PUBLIC_LOCAL_MODE = 'false'
    expect(currentChatScopeEnv()).toEqual(CLOUD)
  })
})

describe('server contract behind the cloud branch', () => {
  it('/api/local/projects (pinned project sessions) is only mounted in local mode', () => {
    // If this changes, revisit isProjectWorkspaceRuntimeEnabled(): cloud
    // project tabs are project-scoped only because these routes are absent.
    const server = readFileSync(resolve(import.meta.dir, '../../../api/src/server.ts'), 'utf8')
    const mount = server.indexOf("app.route('/api/local/projects'")
    expect(mount).toBeGreaterThan(-1)
    const gate = server.lastIndexOf("if (process.env.SHOGO_LOCAL_MODE === 'true') {", mount)
    expect(gate).toBeGreaterThan(-1)
    const between = server.slice(gate, mount)
    const depth = [...between].reduce((d, ch) => d + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0)
    expect(depth).toBeGreaterThan(0)
  })
})
