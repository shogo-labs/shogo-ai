// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Root-cause evals: a configurable setting is silently overridden by a
 * hardcoded value. A good plan finds where the value is actually consumed,
 * proves the hardcode is the cause, and replaces it with the setting — not
 * by raising the constant or bolting on an env override.
 */
import { spawnSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { AgentEval, EvalResult } from './types'
import { readWorkspaceFile, searchedCode } from './eval-helpers'

// ---------------------------------------------------------------------------
// Fixture 1: a small TS RAG app whose pipeline ignores the token setting
// ---------------------------------------------------------------------------

export const RAG_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'rag-app', private: true, type: 'module', scripts: { test: 'bun test' } },
    null,
    2,
  ) + '\n',
  'src/config/llm.ts': `export const MODEL = 'gpt-4o-mini'
export const TEMPERATURE = 0.2
export const MAX_INPUT_TOKENS = 4096
`,
  'src/rag/tokens.ts': `/** Whitespace tokenizer — close enough for budgeting. */
export function countTokens(text: string): number {
  return text.split(/\\s+/).filter(Boolean).length
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const words = text.split(/\\s+/).filter(Boolean)
  return words.slice(0, Math.max(0, maxTokens)).join(' ')
}
`,
  'src/rag/retriever.ts': `export interface Doc {
  id: string
  text: string
}

export function retrieve(query: string, docs: Doc[], k = 5): Doc[] {
  const terms = query.toLowerCase().split(/\\W+/).filter(Boolean)
  return docs
    .map((doc) => ({
      doc,
      score: terms.filter((t) => doc.text.toLowerCase().includes(t)).length,
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => r.doc)
}
`,
  'src/rag/pipeline.ts': `import { MAX_INPUT_TOKENS } from '../config/llm'
import { retrieve, type Doc } from './retriever'
import { truncateToTokens } from './tokens'

export function buildContext(chunks: string[]): string {
  const ctx = chunks.join('\\n\\n')
  return truncateToTokens(ctx, MAX_INPUT_TOKENS)
}

export function buildPrompt(question: string, docs: Doc[]): string {
  const chunks = retrieve(question, docs).map((d) => d.text)
  return [
    'Answer the question using only the context below.',
    '',
    'Context:',
    buildContext(chunks),
    '',
    \`Question: \${question}\`,
  ].join('\\n')
}
`,
  'src/settings/store.ts': `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export interface Settings {
  maxInputTokens: number
  temperature: number
}

export const DEFAULT_SETTINGS: Settings = { maxInputTokens: 32000, temperature: 0.2 }

const SETTINGS_PATH = join(process.cwd(), 'data', 'settings.json')
let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  let stored: Partial<Settings> = {}
  if (existsSync(SETTINGS_PATH)) {
    try {
      stored = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    } catch {
      stored = {}
    }
  }
  cache = { ...DEFAULT_SETTINGS, ...stored }
  return cache
}

/** Pass \`{ persist: false }\` to change settings in memory only (tests). */
export function updateSettings(patch: Partial<Settings>, opts: { persist?: boolean } = {}): Settings {
  cache = { ...getSettings(), ...patch }
  if (opts.persist !== false) {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
    writeFileSync(SETTINGS_PATH, JSON.stringify(cache, null, 2))
  }
  return cache
}

export function resetSettingsCache(): void {
  cache = null
}
`,
  'data/settings.json': JSON.stringify({ maxInputTokens: 32000, temperature: 0.2 }, null, 2) + '\n',
  'src/ui/SettingsPanel.tsx': `import type { Settings } from '../settings/store'

export interface SettingsPanelProps {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  return (
    <form>
      <label>
        Max input tokens
        <input
          type="number"
          min={256}
          value={settings.maxInputTokens}
          onChange={(e) => onChange({ maxInputTokens: Number(e.currentTarget.value) })}
        />
      </label>
      <label>
        Temperature
        <input
          type="number"
          step={0.1}
          value={settings.temperature}
          onChange={(e) => onChange({ temperature: Number(e.currentTarget.value) })}
        />
      </label>
    </form>
  )
}
`,
  'src/rag/__tests__/pipeline.test.ts': `import { describe, expect, test } from 'bun:test'
import { buildContext } from '../pipeline'

describe('buildContext', () => {
  test('joins retrieved chunks', () => {
    expect(buildContext(['alpha beta', 'gamma'])).toBe('alpha beta gamma')
  })
})
`,
}

// ---------------------------------------------------------------------------
// Fixture 2: an HTTP client that ignores the configured timeout
// ---------------------------------------------------------------------------

export const TIMEOUT_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'status-dashboard', private: true, type: 'module', scripts: { test: 'bun test' } },
    null,
    2,
  ) + '\n',
  'src/settings/settings.ts': `export interface AppSettings {
  apiBaseUrl: string
  requestTimeoutMs: number
  retries: number
}

const defaults: AppSettings = {
  apiBaseUrl: 'https://status.example.com',
  requestTimeoutMs: 30000,
  retries: 2,
}

let current: AppSettings = { ...defaults }

export function settings(): AppSettings {
  return current
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  current = { ...current, ...patch }
  return current
}

export function resetSettings(): void {
  current = { ...defaults }
}
`,
  'src/http/client.ts': `export interface RequestOptions {
  method?: string
  body?: unknown
  timeout: number
}

async function request(url: string, opts: RequestOptions): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeout)
  try {
    return await fetch(url, {
      method: opts.method ?? 'GET',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export function createClient(baseUrl: string) {
  return {
    get: (path: string) => request(baseUrl + path, { timeout: 5000 }),
    post: (path: string, body: unknown) =>
      request(baseUrl + path, { method: 'POST', body, timeout: 5000 }),
  }
}
`,
  'src/services/status.ts': `import { createClient } from '../http/client'
import { settings } from '../settings/settings'

export async function fetchStatus(): Promise<{ ok: boolean }> {
  const client = createClient(settings().apiBaseUrl)
  const res = await client.get('/v1/status')
  return (await res.json()) as { ok: boolean }
}
`,
  'src/ui/Preferences.tsx': `import { saveSettings, settings } from '../settings/settings'

export function Preferences() {
  const s = settings()
  return (
    <label>
      Request timeout (seconds)
      <input
        type="number"
        defaultValue={s.requestTimeoutMs / 1000}
        onChange={(e) => saveSettings({ requestTimeoutMs: Number(e.currentTarget.value) * 1000 })}
      />
    </label>
  )
}
`,
  'src/http/__tests__/client.test.ts': `import { describe, expect, test } from 'bun:test'
import { createClient } from '../client'

describe('createClient', () => {
  test('exposes get and post', () => {
    const client = createClient('https://example.com')
    expect(typeof client.get).toBe('function')
    expect(typeof client.post).toBe('function')
  })
})
`,
}

// ---------------------------------------------------------------------------
// Validators (exported for unit tests)
// ---------------------------------------------------------------------------

type PlanCallInput = { name?: unknown; overview?: unknown; plan?: unknown; todos?: unknown }

function planCalls(r: EvalResult): PlanCallInput[] {
  return r.toolCalls
    .filter((tc) => tc.name === 'create_plan' || tc.name === 'update_plan')
    .map((tc) => tc.input as PlanCallInput)
}

/** Markdown body of the latest create_plan/update_plan call, or ''. */
export function planBody(r: EvalResult): string {
  const calls = planCalls(r)
  for (let i = calls.length - 1; i >= 0; i--) {
    if (typeof calls[i].plan === 'string') return calls[i].plan as string
  }
  return ''
}

function planTodosText(r: EvalResult): string {
  const calls = planCalls(r)
  const last = calls[calls.length - 1]
  return last && Array.isArray(last.todos) ? JSON.stringify(last.todos) : ''
}

/** Body of a `## <title>` section (any heading level), up to the next heading of the same or higher level. */
export function planSection(body: string, title: string): string | null {
  const lines = body.split(/\r?\n/)
  const wanted = title.toLowerCase()
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,4})\s+(.*)$/.exec(lines[i])
    if (!m || !m[2].trim().toLowerCase().startsWith(wanted)) continue
    const level = m[1].length
    const out: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const next = /^(#{1,4})\s/.exec(lines[j])
      if (next && next[1].length <= level) break
      out.push(lines[j])
    }
    return out.join('\n').trim()
  }
  return null
}

export function hasPlanSections(r: EvalResult, titles: string[]): boolean {
  const body = planBody(r)
  return titles.every((t) => planSection(body, t) !== null)
}

/** The plan names at least one test, in a `Tests` section or a todo. */
export function planListsTest(r: EvalResult): boolean {
  const tests = planSection(planBody(r), 'Tests')
  if (tests && /test/i.test(tests)) return true
  return /test/i.test(planTodosText(r))
}

/** True if read_file was called on a path ending with `suffix`. */
export function readFileCalled(r: EvalResult, suffix: string): boolean {
  return r.toolCalls.some((tc) => {
    if (tc.name !== 'read_file') return false
    const p = (tc.input as { path?: unknown }).path
    return typeof p === 'string' && p.replace(/\\/g, '/').endsWith(suffix)
  })
}

export interface WorkaroundSpec {
  /** Patterns that mean "the hardcode was raised/kept". */
  raise: RegExp[]
}

const ENV_OVERRIDE = /process\.env|\benv(ironment)?[\s-]+(var(iable)?|override|flag)|\.env\b/i

/**
 * The text the plan actually commits to: the `Changes` section plus todos.
 * Without a `Changes` section, the whole body minus `Options considered`
 * (where rejected workarounds are legitimately discussed).
 */
export function primaryFixText(r: EvalResult): string {
  const body = planBody(r)
  const changes = planSection(body, 'Changes')
  if (changes !== null) return `${changes}\n${planTodosText(r)}`
  const options = planSection(body, 'Options considered')
  const rest = options ? body.replace(options, '') : body
  return `${rest}\n${planTodosText(r)}`
}

const NEGATED = /\b(not|no|never|don't|do not|avoid|instead of|rather than|without|reject(ed)?)\b/i

/**
 * True when the primary fix raises/keeps the hardcode or adds an env override.
 * Lines that negate the workaround ("don't add an env override") are ignored.
 */
export function proposesWorkaround(r: EvalResult, spec: WorkaroundSpec): boolean {
  return primaryFixText(r)
    .split(/\r?\n|(?<=\.)\s+/)
    .filter((line) => !NEGATED.test(line))
    .some((line) => ENV_OVERRIDE.test(line) || spec.raise.some((re) => re.test(line)))
}

function planText(r: EvalResult): string {
  return `${planBody(r)}\n${planTodosText(r)}`
}

export const RAG_WORKAROUND: WorkaroundSpec = {
  raise: [
    /MAX_INPUT_TOKENS\s*(=|:|to|→|->)\s*`?(?!4096\b)\d{4,}/i,
    /(raise|increase|bump)\w*\s+(the\s+)?`?MAX_INPUT_TOKENS/i,
  ],
}

export const TIMEOUT_WORKAROUND: WorkaroundSpec = {
  raise: [
    /timeout:\s*(?!5000\b)\d{4,}/i,
    /5000\s*(→|->|to)\s*`?\d{4,}/i,
    /(raise|increase|bump)\w*\s+(the\s+)?(hardcoded\s+|default\s+)?(`timeout`|timeout)\b(?!\s+setting)/i,
  ],
}

/** All `.test.ts(x)` files under `src/` in the post-run workspace. */
export function workspaceTestFiles(r: EvalResult): string[] {
  const dir = r.workspaceDir
  if (!dir) return []
  const root = join(dir, 'src')
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules') continue
      const childAbs = join(abs, name)
      const childRel = `${rel}/${name}`
      if (statSync(childAbs).isDirectory()) walk(childAbs, childRel)
      else if (/\.test\.tsx?$/.test(name)) out.push(childRel)
    }
  }
  walk(root, 'src')
  return out
}

/** A test file sets maxInputTokens to a non-default value (or mocks the settings module). */
export function addedNonDefaultSettingTest(r: EvalResult): boolean {
  return workspaceTestFiles(r).some((rel) => {
    const src = readWorkspaceFile(r, rel)
    if (!src.includes('maxInputTokens')) return false
    return /maxInputTokens\s*[:=]\s*(?!32000\b)\d/.test(src) || /mock\.module\([^)]*settings/.test(src)
  })
}

const testRunCache = new Map<string, boolean>()

/** Runs `bun test` in the workspace once and caches the outcome. */
export function workspaceTestsPass(r: EvalResult): boolean {
  const dir = r.workspaceDir
  if (!dir) return false
  const cached = testRunCache.get(dir)
  if (cached !== undefined) return cached
  const bun = process.versions.bun ? process.execPath : 'bun'
  const res = spawnSync(bun, ['test'], {
    cwd: dir,
    timeout: 120_000,
    windowsHide: true,
    encoding: 'utf-8',
    env: { ...process.env, NODE_ENV: 'test' },
  })
  const ok = res.status === 0
  testRunCache.set(dir, ok)
  return ok
}

export function _resetWorkspaceTestCacheForTests(): void {
  testRunCache.clear()
}

export function ragPipelineUsesSetting(r: EvalResult): boolean {
  const src = readWorkspaceFile(r, 'src/rag/pipeline.ts')
  return /getSettings\s*\(\s*\)/.test(src) && src.includes('maxInputTokens')
}

export function ragPipelineDropsConstant(r: EvalResult): boolean {
  const src = readWorkspaceFile(r, 'src/rag/pipeline.ts')
  return src.length > 0 && !src.includes('MAX_INPUT_TOKENS')
}

/** The constant was left at 4096 or removed — not raised. */
export function ragConstantNotRaised(r: EvalResult): boolean {
  const src = readWorkspaceFile(r, 'src/config/llm.ts')
  return !/MAX_INPUT_TOKENS\s*=\s*(?!4096\b)\d+/.test(src)
}

// ---------------------------------------------------------------------------
// Evals
// ---------------------------------------------------------------------------

const PLAN_SECTIONS = ['Root cause', 'Options considered']

const ROOT_CAUSE_PLAN_HARDCODED_LIMIT: AgentEval = {
  id: 'root-cause-plan-hardcoded-limit',
  name: 'Root cause (plan): hardcoded token limit overrides the setting',
  category: 'root-cause',
  level: 3,
  input:
    "Make a plan first, do not change anything yet: users report RAG answers ignore the 'Max input tokens' setting — context is always cut at 4096 tokens.",
  workspaceFiles: RAG_FIXTURE,
  maxScore: 100,
  validationCriteria: [
    {
      id: 'searched-code',
      description: 'Searched the code with rg (exec)',
      points: 15,
      phase: 'intention',
      validate: (r) => searchedCode(r),
    },
    {
      id: 'read-consumer-and-source',
      description: 'Read both rag/pipeline.ts and settings/store.ts',
      points: 15,
      phase: 'intention',
      validate: (r) => readFileCalled(r, 'rag/pipeline.ts') && readFileCalled(r, 'settings/store.ts'),
    },
    {
      id: 'plan-replaces-hardcode',
      description: 'Plan replaces MAX_INPUT_TOKENS in the pipeline with getSettings().maxInputTokens',
      points: 25,
      phase: 'execution',
      validate: (r) => {
        const text = planText(r)
        return text.includes('MAX_INPUT_TOKENS') && text.includes('getSettings') && primaryFixText(r).includes('maxInputTokens')
      },
    },
    {
      id: 'plan-sections',
      description: 'Plan has Root cause and Options considered sections',
      points: 15,
      phase: 'execution',
      validate: (r) => hasPlanSections(r, PLAN_SECTIONS),
    },
    {
      id: 'plan-lists-test',
      description: 'Plan lists a test',
      points: 15,
      phase: 'execution',
      validate: planListsTest,
    },
    {
      id: 'no-workaround',
      description: 'Primary fix does not raise the constant, add an env override, or keep the hardcode',
      points: 15,
      phase: 'execution',
      validate: (r) => planBody(r).length > 0 && !proposesWorkaround(r, RAG_WORKAROUND),
    },
  ],
  tags: ['root-cause', 'plan'],
}

const ROOT_CAUSE_PLAN_TIMEOUT: AgentEval = {
  id: 'root-cause-plan-timeout',
  name: 'Root cause (plan): hardcoded request timeout overrides the setting',
  category: 'root-cause',
  level: 3,
  input: 'Make a plan first, do not change anything yet: requests time out after 5s even though I set the timeout to 30s in settings.',
  workspaceFiles: TIMEOUT_FIXTURE,
  maxScore: 100,
  validationCriteria: [
    {
      id: 'searched-code',
      description: 'Searched the code with rg (exec)',
      points: 15,
      phase: 'intention',
      validate: (r) => searchedCode(r),
    },
    {
      id: 'read-consumer-and-source',
      description: 'Read both http/client.ts and settings/settings.ts',
      points: 15,
      phase: 'intention',
      validate: (r) => readFileCalled(r, 'http/client.ts') && readFileCalled(r, 'settings/settings.ts'),
    },
    {
      id: 'plan-replaces-hardcode',
      description: 'Plan replaces the hardcoded 5000ms timeout with settings().requestTimeoutMs',
      points: 25,
      phase: 'execution',
      validate: (r) => /5000|5\s?s\b|hardcode/i.test(planText(r)) && primaryFixText(r).includes('requestTimeoutMs'),
    },
    {
      id: 'plan-sections',
      description: 'Plan has Root cause and Options considered sections',
      points: 15,
      phase: 'execution',
      validate: (r) => hasPlanSections(r, PLAN_SECTIONS),
    },
    {
      id: 'plan-lists-test',
      description: 'Plan lists a test',
      points: 15,
      phase: 'execution',
      validate: planListsTest,
    },
    {
      id: 'no-workaround',
      description: 'Primary fix does not raise the hardcoded timeout or add an env override',
      points: 15,
      phase: 'execution',
      validate: (r) => planBody(r).length > 0 && !proposesWorkaround(r, TIMEOUT_WORKAROUND),
    },
  ],
  tags: ['root-cause', 'plan'],
}

const ROOT_CAUSE_AGENT_HARDCODED_LIMIT: AgentEval = {
  id: 'root-cause-agent-hardcoded-limit',
  name: 'Root cause (agent): fix the pipeline to honor the token setting',
  category: 'root-cause',
  level: 3,
  input: 'Fix it: RAG ignores the Max input tokens setting.',
  workspaceFiles: RAG_FIXTURE,
  maxScore: 100,
  validationCriteria: [
    {
      id: 'pipeline-drops-constant',
      description: 'rag/pipeline.ts no longer references MAX_INPUT_TOKENS',
      points: 20,
      phase: 'execution',
      validate: ragPipelineDropsConstant,
    },
    {
      id: 'pipeline-reads-setting',
      description: 'rag/pipeline.ts reads getSettings().maxInputTokens',
      points: 25,
      phase: 'execution',
      validate: ragPipelineUsesSetting,
    },
    {
      id: 'non-default-setting-test',
      description: 'A test asserts a non-default maxInputTokens is honored',
      points: 20,
      phase: 'execution',
      validate: addedNonDefaultSettingTest,
    },
    {
      id: 'bun-test-passes',
      description: '`bun test` passes in the workspace',
      points: 20,
      phase: 'execution',
      validate: workspaceTestsPass,
    },
    {
      id: 'constant-not-raised',
      description: 'MAX_INPUT_TOKENS was not raised as a workaround',
      points: 15,
      phase: 'execution',
      validate: ragConstantNotRaised,
    },
  ],
  tags: ['root-cause', 'agent'],
}

export const ROOT_CAUSE_EVALS: AgentEval[] = [
  ROOT_CAUSE_PLAN_HARDCODED_LIMIT,
  ROOT_CAUSE_PLAN_TIMEOUT,
  ROOT_CAUSE_AGENT_HARDCODED_LIMIT,
]
