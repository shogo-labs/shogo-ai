// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  MEMORY_BUDGETS,
  buildCheckpoint,
  classifyCommand,
  evaluateBudgets,
  growthPercent,
  parseFootprint,
  parsePs,
  rolesMb,
  withinLeakBudget,
  type Checkpoint,
} from '../bench/memory-report'

describe('classifyCommand', () => {
  test('labels the desktop process tree', () => {
    expect(classifyCommand('/Applications/Shogo.app/Contents/MacOS/Shogo')).toBe('electron')
    expect(classifyCommand('bun --conditions=development /repo/apps/api/src/entry.ts')).toBe('api')
    expect(classifyCommand('bun /repo/packages/agent-runtime/src/server.ts')).toBe('agent-runtime')
    expect(classifyCommand('node /repo/node_modules/typescript/lib/tsserver.js')).toBe('tsserver')
    expect(classifyCommand('node /repo/node_modules/vite/bin/vite.js build --watch')).toBe('vite')
    expect(classifyCommand('/opt/shogo-ide/code-oss --user-data-dir /tmp')).toBe('code-oss')
    expect(classifyCommand('node /resources/mcp-packages/computer-use-mcp/dist/main.js')).toBe('mcp')
    expect(classifyCommand('/Users/me/Library/Caches/ms-playwright/chromium-1140/chrome')).toBe('chromium')
    expect(classifyCommand('bun run server.tsx')).toBe('project-server')
  })
})

describe('parsePs', () => {
  test('parses pid, ppid, rss, and the rest of the command', () => {
    const samples = parsePs('  10  1  2048 bun apps/api/src/entry.ts --port 8002\n  11  10  1024 node tsserver.js\n')
    expect(samples).toHaveLength(2)
    expect(samples[0]).toMatchObject({ pid: 10, ppid: 1, rssKb: 2048, role: 'api' })
    expect(samples[1].role).toBe('tsserver')
    expect(rolesMb(samples).api).toBe(2)
  })
})

describe('budgets', () => {
  test('growth and leak return', () => {
    expect(growthPercent(1677, 2107)).toBeCloseTo(25.6, 0)
    expect(withinLeakBudget(1000, 1040)).toBe(true)
    expect(withinLeakBudget(1000, 1100)).toBe(false)
  })

  test('the 2026-09-21 report passes idle and project-open but fails idle growth', () => {
    const checkpoints: Checkpoint[] = [
      { name: 'launch+60s-idle', at: '', electronMb: 507.8, otherMb: 619.1, totalMb: 1126.9, rolesMb: { api: 300 }, electronByTypeMb: {} },
      { name: 'project-open', at: '', electronMb: 571, otherMb: 1106, totalMb: 1677, rolesMb: { api: 340 }, electronByTypeMb: {} },
      { name: 'idle+1min', at: '', electronMb: 890.8, otherMb: 1216.2, totalMb: 2107.1, rolesMb: { api: 340 }, electronByTypeMb: {} },
    ]
    const failures = evaluateBudgets(checkpoints, MEMORY_BUDGETS)
    expect(failures.map((f) => f.check)).toEqual(['idle growth %'])
  })

  test('api over 350 MB fails that checkpoint', () => {
    const failures = evaluateBudgets([
      { name: 'launch+60s-idle', at: '', electronMb: 100, otherMb: 400, totalMb: 500, rolesMb: { api: 449 }, electronByTypeMb: {} },
    ])
    expect(failures.some((f) => f.check.includes('api'))).toBe(true)
  })
})

describe('buildCheckpoint', () => {
  test('excludes electron pids from the non-electron total and sums working sets', () => {
    const checkpoint = buildCheckpoint({
      name: 'launch-idle',
      electron: [{ pid: 1, type: 'Browser', workingSetKb: 200 * 1024 }],
      electronPids: [1],
      processes: [
        { pid: 1, ppid: 0, rssKb: 200 * 1024, command: 'Shogo', role: 'electron' },
        { pid: 2, ppid: 1, rssKb: 100 * 1024, command: 'bun apps/api/src/entry.ts', role: 'api' },
      ],
    })
    expect(checkpoint.electronMb).toBe(200)
    expect(checkpoint.otherMb).toBe(100)
    expect(checkpoint.totalMb).toBe(300)
    expect(checkpoint.rolesMb.api).toBe(100)
  })
})

describe('parseFootprint', () => {
  test('reads macOS phys_footprint', () => {
    expect(parseFootprint('phys_footprint: 512.5M\n')).toBe(512.5)
    expect(parseFootprint('phys_footprint: 1.5G\n')).toBe(1536)
    expect(parseFootprint('nope')).toBeNull()
  })
})
