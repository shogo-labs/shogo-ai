// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Route-agnostic grading helpers: a file read with `cat` counts as a read, a
 * heredoc counts as a write, `rm` counts as a delete — and secrets saved to
 * `.env` aren't "inlined".
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EvalResult, ToolCallRecord } from './types'
import {
  configuredRecurringReminder,
  deletedFileAnyRoute,
  execFileWrites,
  execInlinesSecret,
  execIsGrep,
  execIsSearch,
  execReadPaths,
  fileWrites,
  isCanvasSourcePath,
  builtCanvasV2Only,
  listWorkspaceFiles,
  pathMatches,
  readFileAnyRoute,
  searchedAnyRoute,
  splitShellCommand,
  wroteEnvFile,
  wroteFileAnyRoute,
  writtenContent,
} from './eval-helpers'

function call(name: string, input: Record<string, unknown>, extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { name, input, output: null, ...extra }
}

function result(toolCalls: ToolCallRecord[], extra: Partial<EvalResult> = {}): EvalResult {
  return { toolCalls, finalTurnToolCalls: toolCalls, responseText: '', allResponseText: '', ...extra } as unknown as EvalResult
}

const exec = (command: string) => call('exec', { command })

describe('pathMatches', () => {
  test('string matchers match exact, suffix, and cd-relative paths', () => {
    expect(pathMatches('src/App.tsx', 'src/App.tsx')).toBe(true)
    expect(pathMatches('/workspace/src/App.tsx', 'src/App.tsx')).toBe(true)
    expect(pathMatches('./src/App.tsx', 'src/App.tsx')).toBe(true)
    expect(pathMatches('App.tsx', 'src/App.tsx')).toBe(true)
    expect(pathMatches('src/MyApp.tsx', 'src/App.tsx')).toBe(false)
    expect(pathMatches('/etc/App.tsx', 'src/App.tsx')).toBe(false)
  })

  test('regex and predicate matchers', () => {
    expect(pathMatches('reports/a.md', /^reports\//)).toBe(true)
    expect(pathMatches('x/.env', p => p.endsWith('.env'))).toBe(true)
  })
})

describe('shell parsing', () => {
  test('splitShellCommand splits on operators and drops heredoc bodies', () => {
    expect(splitShellCommand('cd app && ls -la; cat a | head\ncat > f <<EOF\nrm -rf /\nEOF')).toEqual([
      'cd app', 'ls -la', 'cat a', 'head', 'cat > f <<EOF',
    ])
  })

  test('execReadPaths finds cat/head/tail/sed -n targets but not writes', () => {
    expect(execReadPaths('cat src/App.tsx')).toEqual(['src/App.tsx'])
    expect(execReadPaths('head -n 50 data.csv && tail -20 log.txt')).toEqual(['data.csv', 'log.txt'])
    expect(execReadPaths("sed -n '1,40p' server.tsx")).toEqual(['server.tsx'])
    expect(execReadPaths('sudo cat /etc/hosts')).toEqual(['/etc/hosts'])
    expect(execReadPaths('cat > notes.md <<EOF\nhi\nEOF')).toEqual([])
    expect(execReadPaths("sed -i 's/a/b/' file.txt")).toEqual([])
  })

  test('execIsSearch vs execIsGrep', () => {
    expect(execIsSearch('ls src')).toBe(true)
    expect(execIsSearch('find . -name "*.ts"')).toBe(true)
    expect(execIsSearch('git ls-files')).toBe(true)
    expect(execIsSearch('echo hi')).toBe(false)
    expect(execIsGrep('ls src')).toBe(false)
    expect(execIsGrep('rg TODO src')).toBe(true)
    expect(execIsGrep('git grep -n foo')).toBe(true)
  })

  test('execFileWrites catches redirects, heredocs and tee', () => {
    expect(execFileWrites('echo hi > out.txt')).toEqual([{ path: 'out.txt', content: 'echo hi > out.txt' }])
    expect(execFileWrites("cat > src/a.ts <<'EOF'\nexport const a = 1\nEOF")).toEqual([{ path: 'src/a.ts', content: 'export const a = 1' }])
    expect(execFileWrites('echo x | tee -a log.md')).toEqual([{ path: 'log.md', content: ' tee -a log.md' }])
    expect(execFileWrites('ls 2>/dev/null')).toEqual([])
    expect(execFileWrites('cmd 2>&1')).toEqual([])
  })
})

describe('read / search / write helpers', () => {
  test('readFileAnyRoute accepts read_file or exec', () => {
    expect(readFileAnyRoute(result([call('read_file', { path: 'src/App.tsx' })]), 'src/App.tsx')).toBe(true)
    expect(readFileAnyRoute(result([exec('cat ./src/App.tsx')]), 'src/App.tsx')).toBe(true)
    expect(readFileAnyRoute(result([exec('cat src/Other.tsx')]), 'src/App.tsx')).toBe(false)
    expect(readFileAnyRoute(result([]))).toBe(false)
  })

  test('searchedAnyRoute accepts search, read_file, and exec search', () => {
    expect(searchedAnyRoute(result([call('search', { query: 'x' })]))).toBe(true)
    expect(searchedAnyRoute(result([exec('rg -n foo')]))).toBe(true)
    expect(searchedAnyRoute(result([exec('bun test')]))).toBe(false)
  })

  test('fileWrites covers write_file, edit_file and exec', () => {
    const r = result([
      call('write_file', { path: './src/a.tsx', content: 'A' }),
      call('edit_file', { path: 'src/b.tsx', old_string: 'x', new_string: 'B' }),
      exec("cat > src/c.tsx <<EOF\nC\nEOF"),
    ])
    expect(fileWrites(r).map(w => [w.path, w.content, w.via])).toEqual([
      ['src/a.tsx', 'A', 'write_file'],
      ['src/b.tsx', 'B', 'edit_file'],
      ['src/c.tsx', 'C', 'exec'],
    ])
    expect(wroteFileAnyRoute(r, 'src/c.tsx', 'C')).toBe(true)
    expect(wroteFileAnyRoute(r, 'src/c.tsx', /^D/)).toBe(false)
    expect(writtenContent(r, /src\/[ab]/)).toBe('A\nB')
  })

  test('wroteEnvFile accepts write_file or echo >> .env', () => {
    expect(wroteEnvFile(result([call('write_file', { path: '.env', content: 'API_KEY=1' })]), 'API_KEY')).toBe(true)
    expect(wroteEnvFile(result([exec('echo "API_KEY=1" >> .env')]), 'API_KEY')).toBe(true)
    expect(wroteEnvFile(result([exec('echo "API_KEY=1" >> .env.example')]), 'API_KEY')).toBe(false)
  })

  test('canvas v2 detection: src/ code without canvas_* tools', () => {
    expect(isCanvasSourcePath('src/App.tsx')).toBe(true)
    expect(isCanvasSourcePath('/w/canvas/Board.jsx')).toBe(true)
    expect(isCanvasSourcePath('server.tsx')).toBe(false)
    const v2 = result([call('write_file', { path: 'src/App.tsx', content: 'x' })])
    expect(builtCanvasV2Only(v2)).toBe(true)
    expect(builtCanvasV2Only(result([...v2.toolCalls, call('canvas_create', {})]))).toBe(false)
    expect(builtCanvasV2Only(result([]))).toBe(false)
  })
})

describe('execInlinesSecret', () => {
  const SECRET = 'ghp_FAKEFAKEFAKE'
  test('flags secrets inlined in a command', () => {
    expect(execInlinesSecret(result([exec(`GITHUB_TOKEN=${SECRET} gh pr list`)]), SECRET)).toBe(true)
    expect(execInlinesSecret(result([exec(`curl -H "Authorization: Bearer ${SECRET}" https://api.github.com`)]), SECRET)).toBe(true)
  })

  test('does not flag saving the secret to .env', () => {
    expect(execInlinesSecret(result([exec(`echo "GITHUB_TOKEN=${SECRET}" >> .env`)]), SECRET)).toBe(false)
    expect(execInlinesSecret(result([exec(`cat >> .env <<EOF\nGITHUB_TOKEN=${SECRET}\nEOF`)]), SECRET)).toBe(false)
    expect(execInlinesSecret(result([exec(`echo "GITHUB_TOKEN=${SECRET}" | tee -a .env`)]), SECRET)).toBe(false)
    expect(execInlinesSecret(result([exec('gh pr list')]), SECRET)).toBe(false)
  })

  test('still flags a secret written to .env and then reused inline', () => {
    expect(execInlinesSecret(result([exec(`echo "T=${SECRET}" >> .env && curl -H "x: ${SECRET}" x`)]), SECRET)).toBe(true)
  })
})

describe('deletedFileAnyRoute', () => {
  test('delete_file, rm, and rm -rf of a parent directory', () => {
    expect(deletedFileAnyRoute(result([call('delete_file', { path: 'src/Settings.tsx' })]), 'src/Settings.tsx')).toBe(true)
    expect(deletedFileAnyRoute(result([exec('rm -f src/Settings.tsx')]), 'src/Settings.tsx')).toBe(true)
    expect(deletedFileAnyRoute(result([exec('rm -rf src/settings')]), 'src/settings/Page.tsx')).toBe(true)
    expect(deletedFileAnyRoute(result([exec('rm src/Other.tsx')]), 'src/Settings.tsx')).toBe(false)
    expect(deletedFileAnyRoute(result([exec('echo rm src/Settings.tsx')]), 'src/Settings.tsx')).toBe(false)
  })
})

describe('configuredRecurringReminder', () => {
  test('heartbeat or schedule counts', () => {
    expect(configuredRecurringReminder(result([call('heartbeat_configure', { interval: 3600 })]))).toBe(true)
    expect(configuredRecurringReminder(result([call('schedule_create', { cron: '0 9 * * 1' })]))).toBe(true)
  })

  test('only a recurring, successful calendar event counts', () => {
    const recurring = call('GOOGLECALENDAR_CREATE_EVENT', { input: '{"recurrence":["RRULE:FREQ=WEEKLY;BYDAY=FR"]}' })
    expect(configuredRecurringReminder(result([recurring]))).toBe(true)
    expect(configuredRecurringReminder(result([{ ...recurring, error: true }]))).toBe(false)
    expect(configuredRecurringReminder(result([call('GOOGLECALENDAR_CREATE_EVENT', { summary: 'One-off' })]))).toBe(false)
    expect(configuredRecurringReminder(result([call('GOOGLECALENDAR_FIND_EVENTS', { q: 'recurring' })]))).toBe(false)
  })
})

describe('listWorkspaceFiles', () => {
  test('lists workspace files, skipping node_modules, .git and src/generated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-helpers-'))
    try {
      for (const p of ['src/App.tsx', 'src/generated/x.ts', 'node_modules/a/i.js', '.git/HEAD', 'reports/a.md']) {
        mkdirSync(join(dir, p, '..'), { recursive: true })
        writeFileSync(join(dir, p), 'x')
      }
      expect(listWorkspaceFiles(result([], { workspaceDir: dir } as Partial<EvalResult>)).sort()).toEqual(['reports/a.md', 'src/App.tsx'])
      expect(listWorkspaceFiles(result([]))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
