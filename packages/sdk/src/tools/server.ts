// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Framework-agnostic server handlers that expose installed integration
 * tools to the user's pod app via a same-origin `/api/tools/*` mount.
 *
 * Mirrors the shape of `@shogo-ai/sdk/voice/server`: each handler is a
 * `(Request) => Promise<Response>` you can drop into any Web-standard
 * router (Hono, Next.js route handlers, Bun.serve, etc.).
 *
 * In a Shogo-managed pod, the runtime injects `RUNTIME_AUTH_SECRET` and
 * `RUNTIME_PORT`. These handlers detect those, then proxy each request
 * to the agent runtime's `/agent/tools/*` HTTP API on `127.0.0.1`,
 * attaching the runtime token as `x-runtime-token`. The browser never
 * sees the token — calls leave the SPA same-origin and stop at this
 * sidecar.
 *
 * @example Hono
 * ```ts
 * import { Hono } from 'hono'
 * import { createToolsHandlers } from '@shogo-ai/sdk/tools/server'
 *
 * const tools = createToolsHandlers({})
 *
 * const app = new Hono()
 * app.post('/api/tools/execute', (c) => tools.execute(c.req.raw))
 * app.get('/api/tools/schemas', (c) => tools.list(c.req.raw))
 * ```
 *
 * Outside a managed pod (no `RUNTIME_AUTH_SECRET` + `RUNTIME_PORT`),
 * the handlers return `501 Not Implemented` so misconfiguration is loud
 * instead of silent.
 */

/**
 * Runtime-token proxy options. When `createToolsHandlers()` detects
 * these (either passed explicitly or auto-detected from env), the
 * returned handlers proxy to the agent runtime over `127.0.0.1`.
 *
 * Auto-detection looks for:
 *   - `process.env.RUNTIME_AUTH_SECRET` (pod-injected runtime token)
 *   - `process.env.RUNTIME_PORT` (pod-injected agent runtime port)
 */
export interface ToolsProxyOptions {
  runtimeToken: string
  /** Port the agent runtime is listening on inside the pod (e.g. 8080). */
  runtimePort: number
  /** Custom fetch impl (forwarded to the proxy fetches). */
  fetch?: typeof fetch
}

export interface ToolsHandlersConfig {
  /**
   * Explicitly opt into runtime-token proxy mode with the given options.
   * If omitted, `createToolsHandlers()` will auto-detect proxy mode from
   * process env (`RUNTIME_AUTH_SECRET` + `RUNTIME_PORT`).
   */
  proxy?: ToolsProxyOptions
  /** Custom fetch impl (forwarded to the proxy fetches). */
  fetch?: typeof fetch
  /** Optional structured logger. */
  logger?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void
}

export interface ToolsHandlers {
  /**
   * `POST /api/tools/execute` — body `{ tool: string, args?: object }`.
   * Returns the raw `{ ok, data?, error? }` from the agent runtime.
   */
  execute: (req: Request) => Promise<Response>
  /**
   * `GET /api/tools/schemas` — returns `{ tools: Array<{ name, description, parameters }> }`.
   */
  list: (req: Request) => Promise<Response>
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

const NOOP_LOGGER: NonNullable<ToolsHandlersConfig['logger']> = () => {
  /* noop */
}

/**
 * Resolve the runtime-token proxy options — explicit `config.proxy` wins,
 * else read from env vars that every Shogo-managed pod has injected.
 */
function resolveProxyOptions(config: ToolsHandlersConfig): ToolsProxyOptions | null {
  if (config.proxy) {
    if (!config.proxy.runtimeToken || !config.proxy.runtimePort) {
      throw new Error('createToolsHandlers: proxy requires runtimeToken and runtimePort')
    }
    return config.proxy
  }
  if (typeof process === 'undefined' || !process.env) return null
  const runtimeToken = process.env.RUNTIME_AUTH_SECRET
  const portRaw = process.env.RUNTIME_PORT
  if (!runtimeToken || !portRaw) return null
  const runtimePort = parseInt(portRaw, 10)
  if (!Number.isFinite(runtimePort) || runtimePort <= 0) return null
  return {
    runtimeToken,
    runtimePort,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  }
}

/**
 * Build proxy handlers that forward requests to the agent runtime
 * over `127.0.0.1` using the runtime token.
 */
function createProxyHandlers(
  proxy: ToolsProxyOptions,
  log: NonNullable<ToolsHandlersConfig['logger']>,
): ToolsHandlers {
  const fetchImpl = proxy.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'createToolsHandlers proxy: global fetch is unavailable; pass proxy.fetch',
    )
  }
  const apiBase = `http://127.0.0.1:${proxy.runtimePort}`

  async function passThrough(
    method: 'GET' | 'POST',
    path: string,
    req: Request,
    label: string,
  ): Promise<Response> {
    if (req.method !== method) return json({ error: 'Method Not Allowed' }, 405)
    try {
      const init: RequestInit = {
        method,
        headers: { 'x-runtime-token': proxy.runtimeToken },
      }
      if (method === 'POST') {
        const body = await req.text()
        init.body = body
        init.headers = {
          ...(init.headers as Record<string, string>),
          'content-type': req.headers.get('content-type') ?? 'application/json',
        }
      }
      const upstream = await fetchImpl(`${apiBase}${path}`, init)
      const text = await upstream.text()
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      const ct = upstream.headers.get('content-type')
      if (ct) headers['content-type'] = ct
      return new Response(text, { status: upstream.status, headers })
    } catch (err) {
      log('error', `proxy ${label} failed`, {
        error: err instanceof Error ? err.message : String(err),
      })
      return json({ error: `${label} proxy failed` }, 502)
    }
  }

  return {
    execute: (req) => passThrough('POST', '/agent/tools/execute', req, 'execute'),
    list: (req) => passThrough('GET', '/agent/tools/schemas', req, 'list'),
  }
}

function notImplemented(label: string): (req: Request) => Promise<Response> {
  return async () =>
    json(
      {
        error: 'Not Implemented',
        detail:
          `${label} requires runtime-token proxy mode. ` +
          `Set RUNTIME_AUTH_SECRET and RUNTIME_PORT in env, or pass an explicit ` +
          `proxy option. In a Shogo-managed pod these are injected automatically.`,
      },
      501,
    )
}

export function createToolsHandlers(config: ToolsHandlersConfig = {}): ToolsHandlers {
  const log = config.logger ?? NOOP_LOGGER

  const proxy = resolveProxyOptions(config)
  if (proxy) return createProxyHandlers(proxy, log)

  return {
    execute: notImplemented('tools.execute'),
    list: notImplemented('tools.list'),
  }
}
