// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initWorkspaceMembers,
  listAvailableWorkspaceProjects,
  listWorkspaceMembers,
  mountWorkspaceMember,
  unmountWorkspaceMember,
} from '../workspace-members'

describe('workspace member registry', () => {
  it('mounts and unmounts a host project without restarting the runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shogo-workspace-members-'))
    const projectRoot = join(root, 'real-project')
    mkdirSync(projectRoot, { recursive: true })
    const previous = {
      WORKSPACE_RUNTIME: process.env.WORKSPACE_RUNTIME,
      WORKSPACE_ID: process.env.WORKSPACE_ID,
      WORKSPACE_DIR: process.env.WORKSPACE_DIR,
      WORKSPACE_PROJECT_IDS: process.env.WORKSPACE_PROJECT_IDS,
      WORKSPACE_AVAILABLE_PROJECTS: process.env.WORKSPACE_AVAILABLE_PROJECTS,
    }
    try {
      process.env.WORKSPACE_RUNTIME = 'true'
      process.env.WORKSPACE_ID = 'ws-test'
      process.env.WORKSPACE_DIR = root
      process.env.WORKSPACE_PROJECT_IDS = ''
      process.env.WORKSPACE_AVAILABLE_PROJECTS = JSON.stringify([
        { id: 'project-1', name: 'Project One', description: 'A test project' },
        { id: 'project-2', name: 'Project Two', description: 'Another test project' },
      ])

      initWorkspaceMembers()
      expect(listAvailableWorkspaceProjects()).toHaveLength(2)
      expect(listWorkspaceMembers()).toEqual([])

      const mounted = await mountWorkspaceMember({
        id: 'project-1',
        realPath: projectRoot,
        readonly: true,
      })
      expect(mounted.readonly).toBe(true)
      expect(listWorkspaceMembers().map((member) => member.id)).toEqual(['project-1'])
      expect(readFileSync(join(root, 'WORKSPACE.md'), 'utf8')).toContain('Project One')

      await mountWorkspaceMember({ id: 'project-2' })
      expect(listWorkspaceMembers().map((member) => member.id)).toEqual(['project-1', 'project-2'])
      expect(await unmountWorkspaceMember('project-2')).toBe(true)
      expect(listWorkspaceMembers().map((member) => member.id)).toEqual(['project-1'])
      expect(await unmountWorkspaceMember('project-1')).toBe(true)
      expect(listWorkspaceMembers()).toEqual([])
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})

