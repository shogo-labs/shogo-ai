// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for `src/routes/security.ts` — project security scanner.
 *
 * The module only exports the route factory; all rule application,
 * package.json scanning, env scanning, and severity sorting are exercised
 * end-to-end through `POST /projects/:projectId/security/scan` using
 * controlled fixture directories created on disk.
 *
 * Coverage targets:
 *   - 404 when projectDir missing
 *   - File-extension + excludePath filters in SECURITY_RULES
 *   - Severity sorting (critical → info)
 *   - Summary counts match findings
 *   - package.json scan: unpinned (* / latest) versions, install hooks
 *   - .env scan: sensitive values flagged, placeholders skipped
 *   - .gitignore missing .env entry → SEC006 finding
 *   - SKIP_DIRS (node_modules, .git, ...) not scanned
 *   - SCANNABLE_EXTENSIONS filter — non-source files ignored
 *   - 500 error path
 *
 * We bypass npm audit + LLM analysis by *not* setting ANTHROPIC_API_KEY and
 * by working in a directory without a package-lock.json (auditDependencies
 * silently returns []).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('@shogo/model-catalog', () => ({
  getMaxOutputTokens: () => 8192,
}))

const originalAnthropic = process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_API_KEY

const { securityRoutes } = await import('../routes/security')

let workspacesDir: string
let app: ReturnType<typeof securityRoutes>

function makeApp(dir: string) {
  return securityRoutes({ workspacesDir: dir })
}

async function scan(projectId: string): Promise<{ status: number; body: any }> {
  const res = await app.fetch(
    new Request(`http://test/projects/${projectId}/security/scan`, { method: 'POST' }),
  )
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

function seedFile(projectId: string, relPath: string, content: string) {
  const full = join(workspacesDir, projectId, relPath)
  const parent = full.substring(0, full.lastIndexOf('/'))
  mkdirSync(parent, { recursive: true })
  writeFileSync(full, content, 'utf-8')
}

beforeEach(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), 'sec-test-'))
  app = makeApp(workspacesDir)
})

afterEach(() => {
  try { rmSync(workspacesDir, { recursive: true, force: true }) } catch {}
})

// Restore env after the whole file runs.
process.on('exit', () => {
  if (originalAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = originalAnthropic
})

// ─── Error paths ──────────────────────────────────────────────────────

describe('POST /projects/:projectId/security/scan — project not found', () => {
  test('returns 404 with project_not_found code when dir missing', async () => {
    const { status, body } = await scan('does-not-exist')
    expect(status).toBe(404)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('project_not_found')
  })
})

// ─── Rule application ─────────────────────────────────────────────────

describe('rule scanning', () => {
  test('flags hardcoded API key (SEC001) as critical', async () => {
    seedFile('p1', 'src/config.ts', `const x = 1\nconst apiKey = "abcd1234efgh5678ijkl9999"\n`)
    const { status, body } = await scan('p1')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const sec001 = body.findings.find((f: any) => f.id.startsWith('SEC001-'))
    expect(sec001).toBeDefined()
    expect(sec001.severity).toBe('critical')
    expect(sec001.file).toBe('src/config.ts')
    expect(sec001.line).toBe(2)
  })

  test('flags AWS access key id (SEC002)', async () => {
    seedFile('p1', 'src/aws.ts', `const ID = "AKIAIOSFODNN7EXAMPLE"\n`)
    const { body } = await scan('p1')
    const sec002 = body.findings.find((f: any) => f.id.startsWith('SEC002-'))
    expect(sec002).toBeDefined()
    expect(sec002.severity).toBe('critical')
  })

  test('flags PEM private key (SEC003)', async () => {
    seedFile('p1', 'src/keys.ts', `const k = \`-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\`\n`)
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id.startsWith('SEC003-'))).toBe(true)
  })

  test('flags dangerouslySetInnerHTML in .tsx (SEC010, high)', async () => {
    seedFile('p1', 'src/Comp.tsx', `export const C = () => <div dangerouslySetInnerHTML={{__html: x}} />\n`)
    const { body } = await scan('p1')
    const sec010 = body.findings.find((f: any) => f.id.startsWith('SEC010-'))
    expect(sec010).toBeDefined()
    expect(sec010.severity).toBe('high')
  })

  test('does NOT flag dangerouslySetInnerHTML in .ts (fileExtensions filter)', async () => {
    seedFile('p1', 'src/notjsx.ts', `const s = "dangerouslySetInnerHTML"\n`)
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id.startsWith('SEC010-'))).toBe(false)
  })

  test('flags eval() usage (SEC011)', async () => {
    seedFile('p1', 'src/runner.ts', `function run(x: string) { return eval(x) }\n`)
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id.startsWith('SEC011-'))).toBe(true)
  })

  test('excludes node_modules from scanning', async () => {
    seedFile('p1', 'node_modules/evil/index.ts', `const k = "AKIAIOSFODNN7EXAMPLE"\n`)
    seedFile('p1', 'src/safe.ts', `export {}\n`)
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.file.includes('node_modules'))).toBe(false)
  })

  test('excludes test files (excludePaths filter)', async () => {
    seedFile('p1', 'src/foo.test.ts', `const apiKey = "abcd1234efgh5678zzzzzz"\n`)
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id.startsWith('SEC001-'))).toBe(false)
  })

  test('skips non-scannable extensions (e.g. .png)', async () => {
    seedFile('p1', 'src/image.png', 'fake binary content with apiKey="abcd1234efgh5678zzzzzz"\n')
    const { body } = await scan('p1')
    expect(body.summary.filesScanned).toBe(0)
  })
})

// ─── Severity sorting + summary ───────────────────────────────────────

describe('summary + sorting', () => {
  test('sorts findings critical → info and summary counts match', async () => {
    seedFile('p1', 'src/secret.ts', `const apiKey = "abcd1234efgh5678ijkl9999"\n`) // SEC001 critical
    seedFile('p1', 'src/comp.tsx', `<div dangerouslySetInnerHTML={{__html: x}}/>\n`) // SEC010 high
    seedFile('p1', 'src/cfg.ts', `const cfg = { debug: true }\n`)                    // SEC042 low
    const { body } = await scan('p1')

    expect(body.findings.length).toBeGreaterThanOrEqual(3)
    const severities = body.findings.map((f: any) => f.severity)
    const order = ['critical', 'high', 'medium', 'low', 'info']
    let lastIdx = -1
    for (const s of severities) {
      const i = order.indexOf(s)
      expect(i).toBeGreaterThanOrEqual(lastIdx)
      lastIdx = i
    }

    const s = body.summary
    expect(s.total).toBe(body.findings.length)
    expect(s.critical + s.high + s.medium + s.low + s.info).toBe(s.total)
    expect(s.filesScanned).toBeGreaterThan(0)
    expect(typeof s.durationMs).toBe('number')
    expect(s.aiAnalysis).toBe(false)
    expect(s.vulnerableDeps).toBe(0)
  })
})

// ─── package.json scanning ────────────────────────────────────────────

describe('package.json scanning', () => {
  test('flags wildcard "*" and "latest" versions as SEC071', async () => {
    seedFile('p1', 'package.json', JSON.stringify({
      name: 'x',
      dependencies: { 'pkg-a': '*', 'pkg-b': 'latest', 'pkg-c': '^1.2.3' },
    }))
    const { body } = await scan('p1')
    const ids = body.findings.map((f: any) => f.id)
    expect(ids).toContain('SEC071-pkg-a')
    expect(ids).toContain('SEC071-pkg-b')
    expect(ids).not.toContain('SEC071-pkg-c')
  })

  test('flags preinstall/postinstall scripts as SEC072', async () => {
    seedFile('p1', 'package.json', JSON.stringify({
      name: 'x',
      scripts: { postinstall: 'echo hi' },
    }))
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id === 'SEC072-scripts')).toBe(true)
  })

  test('silently skips malformed package.json', async () => {
    seedFile('p1', 'package.json', '{ not json')
    const { status, body } = await scan('p1')
    expect(status).toBe(200)
    expect(body.findings.some((f: any) => f.id.startsWith('SEC071'))).toBe(false)
    expect(body.findings.some((f: any) => f.id === 'SEC072-scripts')).toBe(false)
  })

  test('merges devDependencies + dependencies', async () => {
    seedFile('p1', 'package.json', JSON.stringify({
      name: 'x',
      dependencies: {},
      devDependencies: { 'dev-pkg': '*' },
    }))
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id === 'SEC071-dev-pkg')).toBe(true)
  })
})

// ─── .env scanning ────────────────────────────────────────────────────

describe('.env scanning', () => {
  test('flags secret-looking env values as SEC005', async () => {
    seedFile('p1', '.env', 'API_KEY=sk-live-1234567890abcdef\nDEBUG=true\n')
    const { body } = await scan('p1')
    const sec005 = body.findings.find((f: any) => f.id.startsWith('SEC005-.env'))
    expect(sec005).toBeDefined()
    expect(sec005.snippet).toContain('***REDACTED***')
    expect(sec005.severity).toBe('high')
  })

  test('skips placeholder values (empty / your- / change-me / xxx)', async () => {
    seedFile('p1', '.env', [
      'API_KEY=',
      'SECRET=""',
      'PASSWORD=change-me',
      'TOKEN=xxx',
      'PRIVATE_KEY=your-',
    ].join('\n'))
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id.startsWith('SEC005-'))).toBe(false)
  })

  test('skips comments and blank lines', async () => {
    seedFile('p1', '.env', '# AUTH_TOKEN=skipme\n\n')
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id.startsWith('SEC005-'))).toBe(false)
  })

  test('flags .env files even when .gitignore is missing', async () => {
    seedFile('p1', '.env', 'API_TOKEN=real-secret-value-12345\n')
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id.startsWith('SEC005-.env'))).toBe(true)
  })
})

describe('.gitignore scanning', () => {
  test('flags missing .env entry in .gitignore as SEC006', async () => {
    seedFile('p1', '.gitignore', 'node_modules\ndist\n')
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id === 'SEC006-gitignore')).toBe(true)
  })

  test('does not flag when .gitignore contains .env', async () => {
    seedFile('p1', '.gitignore', 'node_modules\n.env\n.env.local\n')
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id === 'SEC006-gitignore')).toBe(false)
  })

  test('does not flag SEC006 when .gitignore is absent entirely', async () => {
    seedFile('p1', 'src/x.ts', `export {}\n`)
    const { body } = await scan('p1')
    expect(body.findings.some((f: any) => f.id === 'SEC006-gitignore')).toBe(false)
  })
})

// ─── Empty project ────────────────────────────────────────────────────

describe('empty project', () => {
  test('returns 200 with zero findings', async () => {
    mkdirSync(join(workspacesDir, 'empty'), { recursive: true })
    const { status, body } = await scan('empty')
    expect(status).toBe(200)
    expect(body.findings).toEqual([])
    expect(body.summary.total).toBe(0)
    expect(body.summary.filesScanned).toBe(0)
  })
})

// ─── aiAnalysis flag reflects env var ─────────────────────────────────

describe('aiAnalysis summary flag', () => {
  test('aiAnalysis=false when ANTHROPIC_API_KEY is unset', async () => {
    mkdirSync(join(workspacesDir, 'p1'), { recursive: true })
    const { body } = await scan('p1')
    expect(body.summary.aiAnalysis).toBe(false)
  })
})
