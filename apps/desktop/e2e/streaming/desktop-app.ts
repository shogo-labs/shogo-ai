// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Harness for the desktop streaming e2e: starts the fake model, a Metro dev
 * server for THIS checkout, and the dev Electron app wired to both. It never
 * touches a developer's own running Shogo (separate user-data dir, a free API
 * port, and its own Metro port).
 */
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mainAppWindow } from '../electron-helpers'
import { FakeLlmServer } from './fake-llm-server'
import { installOwnStreamTap, installProbe } from './stream-probe'
import { installReactProfiler } from './react-profile'

const DESKTOP_DIR = path.resolve(__dirname, '..', '..')
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..')
const MOBILE_DIR = path.join(REPO_ROOT, 'apps', 'mobile')
export const REPORT_DIR = path.join(REPO_ROOT, 'test-results', 'streaming-e2e')

const t0 = Date.now()
export function log(message: string): void {
  console.log(`[streaming-e2e +${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`)
}

/** Saves a screenshot and the visible text, to see where a run got stuck. */
export async function snapshotFailure(page: Page, name: string): Promise<void> {
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(REPORT_DIR, `${name}.png`) })
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '')
    fs.writeFileSync(path.join(REPORT_DIR, `${name}.txt`), `${page.url()}\n\n${text}`)
  } catch { /* the page may be gone */ }
}

export interface Harness {
  /** Set when running the Electron build; null for the plain browser target. */
  app: ElectronApplication | null
  page: Page
  llm: FakeLlmServer
  devUrl: string
  apiUrl: string
  projectId: string
  /** Path of the project chat, e.g. /projects/<id>?chatSessionId=<id>. */
  projectPath: string
  /** The chat session the window opened with (a workspace session bound to the project). */
  sessionId: string
  workspaceId: string
  /** Renderer console errors and uncaught exceptions from every app window since launch. */
  rendererErrors: string[]
  /** `[StreamTrace]` summaries the API and runtime printed (set SHOGO_STREAM_TRACE=1). */
  streamTraces(): Array<Record<string, any>>
  close(): Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

/** Desktop's preferred API port; a developer's own Shogo usually holds it. */
const PREFERRED_API_PORT = 39100

async function waitForHttp(url: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = (err as Error).message
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${what} did not become ready at ${url} within ${timeoutMs}ms (${lastError})`)
}

interface MetroHandle {
  url: string
  stop(): void
}

/**
 * Metro for this checkout. Set SHOGO_E2E_DEV_URL to reuse a server you already
 * run from this worktree instead of starting one.
 */
async function startMetro(extraEnv: Record<string, string> = {}, extraArgs: string[] = []): Promise<MetroHandle> {
  const provided = process.env.SHOGO_E2E_DEV_URL
  if (provided) {
    await waitForHttp(provided, 30_000, 'SHOGO_E2E_DEV_URL')
    return { url: provided, stop() {} }
  }

  const port = await freePort()
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  const logPath = path.join(REPORT_DIR, 'metro.log')
  const log = fs.openSync(logPath, 'w')
  const child: ChildProcess = spawn(process.execPath, ['scripts/start-web.mjs', '--port', String(port), ...extraArgs], {
    cwd: MOBILE_DIR,
    env: { ...process.env, CI: '1', BROWSER: 'none', EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1', ...extraEnv },
    stdio: ['ignore', log, log],
    detached: true,
  })
  const url = `http://localhost:${port}`
  try {
    await waitForHttp(url, 240_000, `Metro (log: ${logPath})`)
  } catch (err) {
    try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ }
    throw err
  }
  return {
    url,
    stop() {
      try { process.kill(-child.pid!, 'SIGTERM') } catch { /* gone */ }
    },
  }
}

function ensureDesktopBuild(): void {
  if (fs.existsSync(path.join(DESKTOP_DIR, 'dist', 'main.js')) && !process.env.SHOGO_E2E_REBUILD) return
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const result = spawnSync('npm', ['run', 'build'], { cwd: DESKTOP_DIR, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('apps/desktop build failed')
}

/** fetch() from inside the app window, so it carries the session cookie. */
export async function apiFetch<T = any>(page: Page, route: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ route, init }) => {
      const base = ((window as any).shogoDesktop?.apiUrl ?? (window as any).__E2E_API_URL) as string
      const res = await fetch(`${base}${route}`, {
        method: init?.method ?? 'GET',
        credentials: 'include',
        headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
      const text = await res.text()
      let body: unknown = text
      try { body = JSON.parse(text) } catch { /* keep text */ }
      return { status: res.status, body }
    },
    { route, init },
  ) as Promise<{ status: number; body: T }>
}

export const composer = (page: Page): Locator => page.getByTestId('project-composer-input').filter({ visible: true }).first()
export const stopButton = (page: Page): Locator => page.getByTestId('stop-streaming')

export async function isStreaming(page: Page): Promise<boolean> {
  return (await stopButton(page).count()) > 0
}

export async function send(page: Page, text: string): Promise<void> {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await page.keyboard.press('Enter')
}

export async function queuedCount(page: Page): Promise<number> {
  return page.getByLabel('Queued message', { exact: true }).count()
}

export async function waitIdle(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(stopButton(page)).toHaveCount(0, { timeout: timeoutMs })
}

export async function launchDesktop(): Promise<Harness> {
  ensureDesktopBuild()

  // A developer's own Shogo may be running on the preferred port. This run
  // must leave it alone, and must not talk to it.
  const foreignOnPreferredPort = await isListening(PREFERRED_API_PORT)
  if (foreignOnPreferredPort) log(`port ${PREFERRED_API_PORT} is in use by another process; it must survive this run`)

  const llm = new FakeLlmServer()
  await llm.start()
  log(`fake model at ${llm.url}; starting Metro`)
  const metro = await startMetro()
  log(`Metro ready at ${metro.url}`)

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-streaming-e2e-'))
  const electronEntry = require.resolve('electron', { paths: [DESKTOP_DIR] })
  const executablePath = require(electronEntry) as unknown as string

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  delete env.SHOGO_SKIP_LOCAL_SERVER
  delete env.SHOGO_E2E_API_PORT

  const app = await electron.launch({
    executablePath,
    args: ['.', `--user-data-dir=${userData}`, '--no-sandbox'],
    cwd: DESKTOP_DIR,
    env: {
      ...env,
      SHOGO_E2E: '1',
      // Never share a port with an installed Shogo, which may be running.
      SHOGO_E2E_API_PORT_START: process.env.SHOGO_E2E_API_PORT_START ?? '39400',
      DESKTOP_DEV_URL: metro.url,
      LOCAL_LLM_BASE_URL: llm.url,
      LOCAL_LLM_BASIC_MODEL: 'fake-stream',
      LOCAL_LLM_ADVANCED_MODEL: 'fake-stream',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    timeout: 120_000,
  })

  log('Electron launched')
  const traceLines: string[] = []
  const collectTraces = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const at = line.indexOf('[StreamTrace] ')
      if (at >= 0) traceLines.push(line.slice(at + '[StreamTrace] '.length))
    }
  }
  app.process().stdout?.on('data', collectTraces)
  app.process().stderr?.on('data', collectTraces)
  const close = async () => {
    try { await app.close() } catch { /* already closed */ }
    if (foreignOnPreferredPort && !(await isListening(PREFERRED_API_PORT))) {
      console.error(`[streaming-e2e] WARNING: the process on port ${PREFERRED_API_PORT} is gone after this run`)
    }
    metro.stop()
    await llm.stop()
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  try {
    const page = await mainAppWindow(app, 120_000)
    log(`main window at ${page.url()}`)
    await page.waitForLoadState('domcontentloaded')
    const apiUrl = await page.evaluate(() => (window as any).shogoDesktop?.apiUrl as string)
    if (!apiUrl) throw new Error('window.shogoDesktop.apiUrl is missing: preload did not run')
    if (foreignOnPreferredPort && new URL(apiUrl).port === String(PREFERRED_API_PORT)) {
      throw new Error(`the app is using port ${PREFERRED_API_PORT}, which belongs to another process; refusing to run against it`)
    }

    // The local API (migrations, runtime manager) can take a while on a fresh data dir.
    await waitForHttp(`${apiUrl}/api/config`, 180_000, 'local API')
    log(`local API ready at ${apiUrl}`)

    const signIn = await apiFetch(page, '/api/local/auto-sign-in', { method: 'POST' })
    if (signIn.status >= 400) throw new Error(`auto-sign-in failed: ${JSON.stringify(signIn.body)}`)
    const onboarding = await apiFetch(page, '/api/onboarding/complete', { method: 'POST' })
    if (onboarding.status >= 400) throw new Error(`onboarding failed: ${JSON.stringify(onboarding.body)}`)

    log('signed in, onboarding complete')

    // Create a project through the API, then open it like a user would.
    const workspaces = await apiFetch<any>(page, '/api/workspaces')
    const list: any[] = workspaces.body?.items ?? workspaces.body?.data ?? workspaces.body ?? []
    const workspace = list.find((w) => w?.kind === 'team') ?? list[0]
    if (!workspace?.id) throw new Error(`no workspace found: ${JSON.stringify(workspaces.body).slice(0, 300)}`)
    const created = await apiFetch<any>(page, '/api/projects', {
      method: 'POST',
      body: { name: 'Streaming E2E', workspaceId: workspace.id, tier: 'starter', status: 'draft', accessLevel: 'anyone' },
    })
    const projectId: string | undefined = created.body?.data?.id ?? created.body?.id
    if (!projectId) throw new Error(`project create failed (${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`)
    const projectPath = `/projects/${encodeURIComponent(projectId)}`
    log(`created project ${projectId} in workspace ${workspace.id} (${workspace.kind})`)

    await installOwnStreamTap(page)
    if (process.env.SHOGO_E2E_REACT_PROFILE === '1') await installReactProfiler(page)
    await page.goto(new URL(projectPath, metro.url).toString(), { waitUntil: 'domcontentloaded' })
    await expect(composer(page)).toBeVisible({ timeout: 180_000 }).catch(async (err) => {
      await snapshotFailure(page, 'project-composer-missing')
      throw err
    })
    log('project composer visible')
    await waitIdle(page, 120_000)

    const opened = await findOpenedChat(page, projectId)
    log(`project ${projectId} ready; chat ${opened.sessionId}`)
    await installProbe(page)
    const rendererErrors: string[] = []
    watchErrors(page, rendererErrors)
    app.on('window', (w) => watchErrors(w, rendererErrors))
    return { app, page, llm, devUrl: metro.url, apiUrl, projectId, projectPath, sessionId: opened.sessionId, workspaceId: opened.workspaceId, rendererErrors, streamTraces: () => traceLines.flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }), close }
  } catch (err) {
    await close()
    throw err
  }
}


/**
 * The same app in a plain Chromium tab: the local-mode API on a free port
 * (throwaway SQLite DB, fake model) plus this checkout's Metro web bundle. No
 * Electron needed, and it never touches a developer's running dev stack.
 */
export async function launchWeb(): Promise<Harness> {
  const llm = new FakeLlmServer()
  await llm.start()
  const apiPort = await freePort()
  const apiUrl = `http://localhost:${apiPort}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-streaming-web-e2e-'))
  const dbPath = path.join(dir, 'local.db')
  fs.mkdirSync(REPORT_DIR, { recursive: true })

  const localEnv: Record<string, string> = {
    SHOGO_LOCAL_MODE: 'true',
    DATABASE_URL: `file:${dbPath}`,
    BETTER_AUTH_SECRET: 'e2e-local-secret',
    BETTER_AUTH_URL: apiUrl,
    NODE_ENV: 'development',
    EXPO_PUBLIC_LOCAL_MODE: 'true',
    API_PORT: String(apiPort),
    EXPO_PUBLIC_API_PORT: String(apiPort),
    EXPO_PUBLIC_API_URL: apiUrl,
    EXPO_NO_DOTENV: '1',
    RATE_LIMIT_GLOBAL_MAX: '100000',
    SHOGO_RECORDING_BRIDGE: 'off',
    SHOGO_E2E: '1',
    LOCAL_LLM_BASE_URL: llm.url,
    LOCAL_LLM_BASIC_MODEL: 'fake-stream',
    LOCAL_LLM_ADVANCED_MODEL: 'fake-stream',
  }
  const baseEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) baseEnv[key] = value

  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  log('creating the local database')
  const push = spawnSync('bun', ['x', 'prisma', 'db', 'push', '--schema=prisma/schema.local.prisma', '--url', `file:${dbPath}`, '--accept-data-loss'], { cwd: REPO_ROOT, stdio: 'inherit', env: { ...baseEnv, ...localEnv } })
  if (push.status !== 0) throw new Error('prisma db push failed')

  const traceLines: string[] = []
  const collectTraces = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const at = line.indexOf('[StreamTrace] ')
      if (at >= 0) traceLines.push(line.slice(at + '[StreamTrace] '.length))
    }
  }
  const apiLogPath = path.join(REPORT_DIR, 'web-api.log')
  const apiLog = fs.openSync(apiLogPath, 'w')
  const api: ChildProcess = spawn('bun', ['--no-env-file', 'apps/api/src/entry.ts'], {
    cwd: REPO_ROOT,
    env: { ...baseEnv, ...localEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const pipeLog = (chunk: Buffer) => { fs.writeSync(apiLog, chunk); collectTraces(chunk) }
  api.stdout?.on('data', pipeLog)
  api.stderr?.on('data', pipeLog)

  let metro: MetroHandle | undefined
  let browser: Browser | undefined
  const close = async () => {
    try { await browser?.close() } catch { /* already closed */ }
    metro?.stop()
    try { process.kill(-api.pid!, 'SIGTERM') } catch { /* gone */ }
    await llm.stop()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  try {
    await waitForHttp(`${apiUrl}/api/health`, 180_000, `local API (log: ${apiLogPath})`)
    log(`local API ready at ${apiUrl}`)
    metro = await startMetro(localEnv, ['--clear'])
    log(`Metro ready at ${metro.url}`)

    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await page.addInitScript((url) => { (window as any).__E2E_API_URL = url }, apiUrl)
    await installOwnStreamTap(page)
    if (process.env.SHOGO_E2E_REACT_PROFILE === '1') await installReactProfiler(page)

    await page.goto(metro.url, { waitUntil: 'domcontentloaded', timeout: 240_000 })
    const signIn = await apiFetch(page, '/api/local/auto-sign-in', { method: 'POST' })
    if (signIn.status >= 400) throw new Error(`auto-sign-in failed: ${JSON.stringify(signIn.body)}`)
    const onboarding = await apiFetch(page, '/api/onboarding/complete', { method: 'POST' })
    if (onboarding.status >= 400) throw new Error(`onboarding failed: ${JSON.stringify(onboarding.body)}`)
    log('signed in, onboarding complete')

    const workspaces = await apiFetch<any>(page, '/api/workspaces')
    const list: any[] = workspaces.body?.items ?? workspaces.body?.data ?? workspaces.body ?? []
    const workspace = list.find((w) => w?.kind === 'team') ?? list[0]
    if (!workspace?.id) throw new Error(`no workspace found: ${JSON.stringify(workspaces.body).slice(0, 300)}`)
    const created = await apiFetch<any>(page, '/api/projects', {
      method: 'POST',
      body: { name: 'Streaming E2E', workspaceId: workspace.id, tier: 'starter', status: 'draft', accessLevel: 'anyone' },
    })
    const projectId: string | undefined = created.body?.data?.id ?? created.body?.id
    if (!projectId) throw new Error(`project create failed (${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`)
    const projectPath = `/projects/${encodeURIComponent(projectId)}`
    log(`created project ${projectId}`)

    await page.goto(new URL(projectPath, metro.url).toString(), { waitUntil: 'domcontentloaded' })
    await expect(composer(page)).toBeVisible({ timeout: 240_000 }).catch(async (err) => {
      await snapshotFailure(page, 'project-composer-missing')
      throw err
    })
    log('project composer visible')
    await waitIdle(page, 120_000)

    const opened = await findOpenedChat(page, projectId)
    log(`project ${projectId} ready; chat ${opened.sessionId}`)
    await installProbe(page)
    const rendererErrors: string[] = []
    watchErrors(page, rendererErrors)
    return { app: null, page, llm, devUrl: metro.url, apiUrl, projectId, projectPath, sessionId: opened.sessionId, workspaceId: opened.workspaceId, rendererErrors, streamTraces: () => traceLines.flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }), close }
  } catch (err) {
    await close()
    throw err
  }
}

/** Launches the Electron app, or the plain browser tab when SHOGO_E2E_TARGET=web. */
export function launchTarget(): Promise<Harness> {
  return process.env.SHOGO_E2E_TARGET === 'web' ? launchWeb() : launchDesktop()
}

/** The workspace chat session the project window opened with. */
async function findOpenedChat(page: Page, projectId: string): Promise<{ sessionId: string; workspaceId: string }> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const res = await apiFetch<any>(page, `/api/chat-sessions?contextId=${encodeURIComponent(projectId)}`)
    const items: any[] = res.body?.items ?? []
    const mine = items
      .filter((x) => x.contextType === 'workspace' && x.workspaceId)
      .sort((x, y) => String(y.lastActiveAt).localeCompare(String(x.lastActiveAt)))[0]
    if (mine) return { sessionId: mine.id, workspaceId: mine.workspaceId }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('the project window never created a workspace chat session')
}

/** Creates another chat in the project, the way the "new chat" button does. */
export async function createChatSession(page: Page, projectId: string, name = 'New chat'): Promise<string> {
  const res = await apiFetch<any>(page, `/api/local/projects/${encodeURIComponent(projectId)}/workspace-sessions`, {
    method: 'POST',
    body: { inferredName: name },
  })
  const id: string | undefined = res.body?.session?.id
  if (!id) throw new Error(`chat session create failed (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`)
  return id
}

/** URL of the SSE stream a window attaches to for a chat's live turn. */
export function chatStreamUrl(h: Pick<Harness, 'apiUrl' | 'workspaceId'>, sessionId: string): string {
  return `${h.apiUrl}/api/workspaces/${encodeURIComponent(h.workspaceId)}/chat/${encodeURIComponent(sessionId)}/stream`
}

/**
 * Starts a turn in another chat of the project without opening it, the way a
 * second window (or the island) would, and keeps reading its stream in the
 * page so the connection stays open like a real client's. Resolves once the
 * server accepted the request. Progress is in `window.__bgChats[sessionId]`.
 */
export async function startBackgroundTurn(
  page: Page,
  h: Pick<Harness, 'apiUrl' | 'workspaceId'>,
  sessionId: string,
  text: string,
  tag: string,
): Promise<number> {
  return page.evaluate(
    async ({ url, sessionId, text, tag }) => {
      const w = window as any
      w.__bgChats ??= {}
      const state = { status: 0, bytes: 0, ended: false, error: '', tokens: [] as number[], times: [] as number[] }
      const re = new RegExp(`t${tag}w(\\d{4})`, 'g')
      w.__bgChats[sessionId] = state
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-chat-session-id': sessionId },
        body: JSON.stringify({
          id: sessionId,
          sessionId,
          messages: [{ id: `m-${Date.now()}`, role: 'user', parts: [{ type: 'text', text }] }],
        }),
      })
      state.status = res.status
      void (async () => {
        try {
          const reader = res.body?.getReader()
          if (!reader) return
          const decoder = new TextDecoder()
          let carry = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            state.bytes += value?.length ?? 0
            const chunk = carry + decoder.decode(value, { stream: true })
            re.lastIndex = 0
            let m: RegExpExecArray | null
            let last = 0
            while ((m = re.exec(chunk))) {
              state.tokens.push(Number(m[1]))
              state.times.push(Date.now())
              last = m.index + m[0].length
            }
            carry = chunk.slice(Math.max(last, chunk.length - 24))
          }
        } catch (err) {
          state.error = String(err)
        } finally {
          state.ended = true
        }
      })()
      return res.status
    },
    { url: `${h.apiUrl}/api/workspaces/${encodeURIComponent(h.workspaceId)}/chat`, sessionId, text, tag },
  )
}

export async function backgroundTurnState(page: Page, sessionId: string): Promise<{ status: number; bytes: number; ended: boolean; error: string; tokens: number[]; times: number[] } | null> {
  return page.evaluate((id) => (window as any).__bgChats?.[id] ?? null, sessionId)
}

/** Strings the app must never show for a turn the user stopped or that completed. */
export const BOGUS_FALLBACKS = ['unable to generate a response', 'encountered an issue processing your message']

/**
 * Waits until the visible token count has stopped changing, then returns the
 * tokens. `settledAfterMs` is how long that took, which is how far the screen
 * was behind when the caller started waiting.
 */
export async function settleTokens(
  page: Page,
  tag: string,
  { quietMs = 700, timeoutMs = 20_000 } = {},
): Promise<{ sequence: number[]; settledAfterMs: number }> {
  const started = Date.now()
  let last = -1
  let lastChange = Date.now()
  let sequence: number[] = []
  while (Date.now() - started < timeoutMs) {
    sequence = (await page.evaluate((t) => (window as any).__probe.read(t), tag)) as number[]
    if (sequence.length !== last) {
      last = sequence.length
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= quietMs) break
    await page.waitForTimeout(100)
  }
  return { sequence, settledAfterMs: lastChange - started }
}

/** Reloads the window and waits for the chat to be usable again. */
export async function reloadApp(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(composer(page)).toBeVisible({ timeout: 180_000 })
  await ensureProbe(page)
}

/** Leaves the chat through the app's own router (no reload), to the home route. */
export async function leaveChat(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(composer(page)).toHaveCount(0, { timeout: 15_000 })
}

/** Comes back with the browser's back button; the project route remounts. */
export async function returnToChat(page: Page): Promise<void> {
  await page.goBack({ waitUntil: 'commit' })
  await expect(composer(page)).toBeVisible({ timeout: 60_000 })
}

function watchErrors(page: Page, into: string[]): void {
  page.on('pageerror', (err) => into.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') into.push(`console.error: ${msg.text().slice(0, 300)}`)
  })
}

/**
 * Finished turns fold earlier text into collapsed "Worked for ..." sections.
 * Opens every one of them so the whole reply can be read back. A toggle that
 * was already open is flipped back by the check on the visible token count.
 */
export async function expandWorkedSections(page: Page, tag: string): Promise<number> {
  const toggles = page.getByText(/^Worked for /)
  const count = await toggles.count()
  for (let i = 0; i < count; i++) {
    const before = (await page.evaluate((t) => (window as any).__probe.read(t).length, tag)) as number
    await toggles.nth(i).click().catch(() => undefined)
    await page.waitForTimeout(150)
    const after = (await page.evaluate((t) => (window as any).__probe.read(t).length, tag)) as number
    if (after < before) await toggles.nth(i).click().catch(() => undefined)
  }
  await page.waitForTimeout(150)
  return count
}

/** Installs the probe on a page again, e.g. after it was reloaded. */
export async function ensureProbe(page: Page): Promise<void> {
  const present = await page.evaluate(() => Boolean((window as any).__probe)).catch(() => false)
  if (!present) await installProbe(page)
}

export function writeReport(name: string, data: unknown): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  fs.writeFileSync(path.join(REPORT_DIR, `${name}.json`), JSON.stringify(data, null, 2))
}
