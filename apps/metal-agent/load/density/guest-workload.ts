// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The guest-side workload a density soak drives.
 *
 * An **agent turn** is a fixed sequence of timed steps, each recording its
 * wall-clock ms, so the same work can be compared across N:
 *
 *   cpu     a bounded hash loop, calibrated to ~3 s on an idle host
 *   install `bun install` on a seeded Vite+React template (cache primed once)
 *   build   `vite build` of that template
 *   git     edit 20 files, `git add` + `commit`
 *   llm     a sleep sampled from a distribution — NOT counted as latency
 *
 * The **app role** is a tiny HTTP server in the guest that a host-side loop
 * hits at a constant rate, recording p50/p95 response time.
 *
 * Everything goes through the guest's PTY (`test-harness/guest-exec.ts`), the
 * same path the workspace-drive e2e uses, so no new guest API is needed.
 */

import { guestExec } from '../../src/test-harness/guest-exec'

/**
 * Wait until a freshly assigned guest answers on its runtime port.
 *
 * `assign` returns as soon as the microVM is up, but the runtime inside it needs
 * another moment before it serves `/terminal/sessions`. Without this the first
 * command of a run loses the race and the whole soak aborts at baseline.
 */
export async function waitForGuest(url: string, timeoutMs = 120_000, token = 'e2e'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/terminal/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-runtime-token': token },
        body: JSON.stringify({ cols: 80, rows: 24 }),
        signal: AbortSignal.timeout(5_000),
      })
      if (res.ok) return
      lastErr = `HTTP ${res.status}`
    } catch (err: any) {
      lastErr = err?.message ?? String(err)
    }
    await sleep(1_000)
  }
  throw new Error(`guest at ${url} never answered within ${timeoutMs}ms (last: ${lastErr})`)
}

export interface TurnTimings {
  cpuMs: number
  installMs: number
  buildMs: number
  gitMs: number
  llmWaitMs: number
  ok: boolean
  error?: string
}

export interface TurnOptions {
  /** Where the seeded template lives in the guest. */
  dir?: string
  /** `llm_wait` range in ms (default 5–30 s). */
  llmWaitMs?: [number, number]
  /** Skip the llm sleep (baseline calibration). */
  skipLlmWait?: boolean
  /** Per-step timeout. */
  timeoutMs?: number
}

export const DEFAULT_TEMPLATE_DIR = '/app/workspace/density/tpl'
export const APP_SERVER_PORT = 8099

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The seeded Vite+React template, written once per VM. */
const TEMPLATE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'density-tpl',
      private: true,
      type: 'module',
      scripts: { build: 'vite build' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: { '@vitejs/plugin-react': '^4.3.1', typescript: '^5.5.4', vite: '^5.4.2' },
    },
    null,
    2,
  ),
  'index.html': '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
  'vite.config.ts': "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()] })\n",
  'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', target: 'ES2020', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true, noEmit: true }, include: ['src'] }, null, 2),
  'src/main.tsx': "import { createRoot } from 'react-dom/client'\nimport { App } from './App'\ncreateRoot(document.getElementById('root')!).render(<App />)\n",
  'src/App.tsx': "export function App() {\n  return <main><h1>density</h1><p>soak template</p></main>\n}\n",
  'cpu.ts': [
    "import { createHash } from 'crypto'",
    "const h = createHash('sha256')",
    "let buf = Buffer.alloc(1 << 20, 7)",
    'const deadline = Date.now() + 3000',
    'let n = 0',
    'while (Date.now() < deadline) {',
    '  h.update(buf)',
    '  buf = h.copy().digest()',
    '  n++',
    '}',
    "console.log('hashes', n)",
  ].join('\n'),
  'app-server.ts': [
    "const port = Number(process.env.PORT ?? '8099')",
    'Bun.serve({',
    '  port,',
    '  hostname: "0.0.0.0",',
    '  fetch(req) {',
    '    const url = new URL(req.url)',
    '    if (url.pathname === "/health") return Response.json({ ok: true })',
    '    return Response.json({ ok: true, path: url.pathname, ts: Date.now() })',
    '  },',
    '})',
    "console.log('app-server listening on', port)",
  ].join('\n'),
}


/**
 * Seed the template and prime the package cache once per VM, so the `install`
 * step measures CPU and disk rather than the npm registry.
 */
export async function primeWarmCache(url: string, dir = DEFAULT_TEMPLATE_DIR, timeoutMs = 300_000): Promise<void> {
  await waitForGuest(url)
  // Write each file with base64, one short command per file.
  //
  // Not a heredoc: guestExec wraps the command as `stty -echo; { <cmd> ; } ...`,
  // so the closing `; }` lands on the same line as the heredoc terminator and
  // the shell never sees a bare marker — it waits for the rest of the heredoc
  // until the command times out. (Two live runs died exactly there.) base64 is
  // also immune to the tty's 4 KiB canonical line limit.
  const mk = await guestExec(url, `mkdir -p ${dir}/src`, 30_000)
  if (mk.code !== 0) throw new Error(`creating ${dir} failed (exit ${mk.code}): ${mk.out.slice(-800)}`)
  for (const [rel, body] of Object.entries(TEMPLATE_FILES)) {
    const b64 = Buffer.from(body, 'utf8').toString('base64')
    const one = await guestExec(url, `printf %s '${b64}' | base64 -d > ${dir}/${rel}`, 30_000)
    if (one.code !== 0) throw new Error(`seeding ${dir}/${rel} failed (exit ${one.code}): ${one.out.slice(-800)}`)
  }
  const install = await guestExec(url, `cd ${dir} && bun install --frozen-lockfile 2>/dev/null || bun install`, timeoutMs)
  if (install.code !== 0) throw new Error(`priming bun cache failed (exit ${install.code}): ${install.out.slice(-800)}`)
  const git = await guestExec(
    url,
    `cd ${dir} && (git rev-parse --git-dir >/dev/null 2>&1 || (git init -q && git config user.email soak@shogo.ai && git config user.name soak && git add -A && git commit -qm seed))`,
    60_000,
  )
  if (git.code !== 0) throw new Error(`git init failed (exit ${git.code}): ${git.out.slice(-800)}`)
}

/** One agent turn. Each step is timed; a failed step ends the turn. */
export async function runAgentTurn(url: string, opts: TurnOptions = {}): Promise<TurnTimings> {
  const dir = opts.dir ?? DEFAULT_TEMPLATE_DIR
  const timeoutMs = opts.timeoutMs ?? 300_000
  const t: TurnTimings = { cpuMs: 0, installMs: 0, buildMs: 0, gitMs: 0, llmWaitMs: 0, ok: false }

  const step = async (name: keyof TurnTimings, cmd: string, timeout = timeoutMs): Promise<boolean> => {
    const t0 = performance.now()
    const r = await guestExec(url, cmd, timeout)
    ;(t[name] as number) = +(performance.now() - t0).toFixed(1)
    if (r.code !== 0) {
      t.error = `${name} exit ${r.code}: ${r.out.slice(-400)}`
      return false
    }
    return true
  }

  if (!(await step('cpuMs', `cd ${dir} && bun run cpu.ts`))) return t
  if (!(await step('installMs', `cd ${dir} && rm -rf node_modules && bun install`))) return t
  if (!(await step('buildMs', `cd ${dir} && bun x vite build`))) return t
  if (
    !(await step(
      'gitMs',
      `cd ${dir} && for i in $(seq 1 20); do echo "turn $i $(date +%s%N)" > src/edit-$i.txt; done && git add -A && git commit -qm "turn $(date +%s)"`,
    ))
  )
    return t

  if (!opts.skipLlmWait) {
    const [lo, hi] = opts.llmWaitMs ?? [5_000, 30_000]
    const wait = Math.round(lo + Math.random() * Math.max(0, hi - lo))
    const t0 = performance.now()
    await sleep(wait)
    t.llmWaitMs = +(performance.now() - t0).toFixed(1)
  }

  t.ok = true
  return t
}

export interface AppLoadHandle {
  /** Response times in ms, appended as they complete. */
  readonly latencies: number[]
  stop(): void
}

/**
 * Start the guest's app server and hit it from the host at a constant rate.
 * `guestUrl` is the assign response's URL; the app server listens on the same
 * guest IP at `APP_SERVER_PORT`.
 */
export async function startAppLoad(guestUrl: string, ratePerSec: number, port = APP_SERVER_PORT): Promise<AppLoadHandle> {
  await waitForGuest(guestUrl)
  const started = await guestExec(guestUrl, `cd ${DEFAULT_TEMPLATE_DIR} && (pkill -f app-server.ts || true) && nohup bun run app-server.ts >/tmp/app-server.log 2>&1 & sleep 1; curl -sf http://127.0.0.1:${port}/health`, 30_000)
  if (started.code !== 0) throw new Error(`app server did not come up (exit ${started.code}): ${started.out.slice(-400)}`)

  const guestIp = new URL(guestUrl).hostname
  const base = `http://${guestIp}:${port}`
  const latencies: number[] = []
  let stopped = false
  const intervalMs = Math.max(1, Math.round(1000 / Math.max(0.1, ratePerSec)))

  const loop = async () => {
    while (!stopped) {
      const t0 = performance.now()
      try {
        await fetch(`${base}/`, { signal: AbortSignal.timeout(10_000) })
        latencies.push(+(performance.now() - t0).toFixed(1))
      } catch {
        latencies.push(-1)
      }
      await sleep(intervalMs)
    }
  }
  void loop()

  return {
    latencies,
    stop() {
      stopped = true
    },
  }
}
