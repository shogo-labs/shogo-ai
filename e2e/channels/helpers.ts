/**
 * Shared helpers for channel integration tests.
 *
 * Environment variables:
 *   AGENT_URL       — Base URL of the agent runtime (required)
 *                     Local:   http://localhost:6200
 *                     Staging: https://studio-staging.shogo.ai/api/projects/<id>/agent-proxy
 *   AUTH_COOKIE     — Session cookie for authenticated environments (staging/prod)
 *                     e.g. "shogo.session_token=abc123..."
 *   WEBHOOK_SECRET  — Shared secret for webhook channel auth (if configured)
 *   TEST_TIMEOUT    — Per-test timeout in ms (default: 120000)
 */

export interface TestEnv {
  agentUrl: string
  authCookie?: string
  webhookSecret?: string
  testTimeout: number
}

export function getTestEnv(): TestEnv {
  const agentUrl = process.env.AGENT_URL
  if (!agentUrl) {
    throw new Error(
      'AGENT_URL is required. Set it to the agent runtime base URL.\n' +
      '  Local:   AGENT_URL=http://localhost:6200\n' +
      '  Staging: AGENT_URL=https://studio-staging.shogo.ai/api/projects/<PROJECT_ID>/agent-proxy'
    )
  }

  return {
    agentUrl: agentUrl.replace(/\/$/, ''),
    authCookie: process.env.AUTH_COOKIE,
    webhookSecret: process.env.WEBHOOK_SECRET,
    testTimeout: parseInt(process.env.TEST_TIMEOUT || '120000', 10),
  }
}

/**
 * Build headers for requests. Includes auth cookie when targeting
 * staging/production through the API proxy.
 */
export function buildHeaders(env: TestEnv, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  }

  if (env.authCookie) {
    headers['Cookie'] = env.authCookie
  }

  return headers
}

/**
 * Convenience wrapper around fetch that applies auth and base URL.
 */
export async function agentFetch(
  env: TestEnv,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${env.agentUrl}${path}`
  const headers = buildHeaders(env, options.headers as Record<string, string>)

  return fetch(url, {
    ...options,
    headers,
  })
}

/**
 * Parse an SSE stream and collect events until `done` returns true or timeout.
 */
export async function collectSSEEvents(
  env: TestEnv,
  path: string,
  opts: {
    maxEvents?: number
    timeoutMs?: number
    done?: (events: SSEEvent[]) => boolean
  } = {},
): Promise<SSEEvent[]> {
  const { maxEvents = 50, timeoutMs = 10_000, done } = opts
  const events: SSEEvent[] = []

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await agentFetch(env, path, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    })

    if (!res.ok || !res.body) {
      throw new Error(`SSE request failed: ${res.status} ${res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (events.length < maxEvents) {
      const { done: streamDone, value } = await reader.read()
      if (streamDone) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      let currentEvent: Partial<SSEEvent> = {}
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent.event = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          const raw = line.slice(6)
          try {
            currentEvent.data = JSON.parse(raw)
          } catch {
            currentEvent.data = raw
          }
        } else if (line === '') {
          if (currentEvent.event || currentEvent.data) {
            events.push(currentEvent as SSEEvent)
            currentEvent = {}
            if (done?.(events)) {
              reader.cancel()
              break
            }
          }
        }
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') throw err
  } finally {
    clearTimeout(timeout)
  }

  return events
}

export interface SSEEvent {
  event: string
  data: any
}

/**
 * Wait for the agent to be responsive before running tests.
 * Retries the health endpoint with exponential backoff.
 */
export async function waitForAgent(env: TestEnv, maxWaitMs = 30_000): Promise<void> {
  const start = Date.now()
  let delay = 1_000

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await agentFetch(env, '/health')
      if (res.ok) {
        const body = await res.json()
        if (body.status === 'ok') return
      }
    } catch {
      // retry
    }
    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 1.5, 5_000)
  }

  throw new Error(`Agent at ${env.agentUrl} not responsive after ${maxWaitMs}ms`)
}
