// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { api } from '../api'

describe('api.generateProjectName', () => {
  test('sends projectId and returns the AI source', async () => {
    const calls: Array<{ body: any; signal?: AbortSignal }> = []
    const http = {
      request: async (_path: string, options: { body: any; signal?: AbortSignal }) => {
        calls.push(options)
        return {
          data: { name: 'Task Tracker', description: 'Track daily tasks.', source: 'ai' },
        }
      },
    }

    const result = await api.generateProjectName(
      http as any,
      'Build a task tracker',
      'workspace-1',
      'project-1',
    )

    expect(result.source).toBe('ai')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({
      prompt: 'Build a task tracker',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  test('retries once and preserves the heuristic source response', async () => {
    let attempts = 0
    const http = {
      request: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary timeout')
        return {
          data: { name: 'Task Tracker', description: '', source: 'heuristic' },
        }
      },
    }

    const result = await api.generateProjectName(http as any, 'Build a task tracker')

    expect(attempts).toBe(2)
    expect(result.source).toBe('heuristic')
  })
})
