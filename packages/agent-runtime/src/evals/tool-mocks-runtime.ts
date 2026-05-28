/**
 * Runtime helpers for tool-mock installation.
 *
 * Converts the over-the-wire `ToolMockInstallBody` envelope (sent from
 * Playwright demo specs / eval suite via POST /agent/tool-mocks) into:
 *
 *   1) `fns`            — async tool-execute overrides the gateway can
 *                         call directly. Each fn awaits a sleep before
 *                         resolving so demo recordings have realistic
 *                         pacing instead of 0ms responses.
 *   2) `syntheticDefs`  — descriptions + paramKeys for tools that don't
 *                         yet exist in the base tool set (e.g. Composio
 *                         tools that haven't been installed in this
 *                         project) so the agent still sees them.
 *   3) `hiddenTools`    — names that should NOT appear in the tool list
 *                         until connect promotes them.
 *
 * The latency model has four layers, resolved per call:
 *
 *   per-pattern.delayMs > spec.delayMs > install defaults.delayMs
 *     > tool-class default (browser/web/install/etc.) > runtime fallback
 *
 * All mocks are async so the awaiter at the gateway dispatch sites
 * works for both eval (delayMs: 0, instant) and demo (paced) installs.
 *
 * Used by:
 *   apps/api/src/server.ts  → forwards the install body unchanged to:
 *   packages/agent-runtime/src/server.ts → POST /agent/tool-mocks → here
 */

import type { ToolMockInstallBody, ToolMockMap, ToolMockSpec } from './tool-mocks'

export type CompiledMocks = {
  fns: Record<string, (params: Record<string, any>) => Promise<any>>
  syntheticDefs: Record<string, { description: string; paramKeys: string[] }>
  hiddenTools: Set<string>
  defaults: { delayMs: number; jitterMs: number }
}

/**
 * Resolve an action-specific delay for tool calls when no explicit
 * delayMs is set on the spec / pattern / install body. Browser navigates
 * are slow, clicks are fast, integration installs feel like OAuth, etc.
 *
 * Heuristic only — never fires when the caller sets `delayMs`. Eval
 * suite passes `defaults: { delayMs: 0 }` so test cases stay instant.
 */
export function resolveToolClassDelay(toolName: string, params: Record<string, any>): number | null {
  if (toolName === 'browser') {
    const action = String(params?.action ?? '').toLowerCase()
    if (action === 'navigate') return 2200
    if (action === 'screenshot' || action === 'snapshot' || action === 'extract' || action === 'text') return 1100
    if (action === 'click' || action === 'fill' || action === 'select' || action === 'scroll' || action === 'wait_for') return 600
    if (action === 'evaluate') return 800
    if (action === 'close') return 200
    return 800
  }
  if (toolName === 'web') return 1500
  if (toolName === 'search_integrations') return 600
  if (toolName === 'connect') return 1800
  if (toolName === 'image_gen' || toolName === 'generate_image') return 2400
  if (/_LIST_|_SEARCH_|_RETRIEVE_|_GET_|_FETCH_/.test(toolName)) return 1800
  if (/_CREATE_|_UPDATE_|_PAUSE_|_DELETE_|_REPLY|_SEND_/.test(toolName)) return 700
  return null
}

/**
 * Normalize the install body. Older eval callers POST a bare map of
 * tool→spec; newer demo callers POST `{ mocks, defaults? }`.
 */
export function normalizeInstallBody(
  raw: ToolMockInstallBody | ToolMockMap | Record<string, any>,
): { mocks: ToolMockMap; defaults?: { delayMs?: number; jitterMs?: number } } {
  if (raw && typeof raw === 'object' && 'mocks' in (raw as any)) {
    return { mocks: (raw as any).mocks ?? {}, defaults: (raw as any).defaults }
  }
  return { mocks: (raw as ToolMockMap) ?? {} }
}

/**
 * Compile the install body into the gateway-friendly shape. Pure /
 * deterministic apart from `Math.random()` jitter — tests can stub
 * `randomFn` to make timing assertions stable.
 */
export function compileInstallBody(
  raw: ToolMockInstallBody | ToolMockMap | Record<string, any>,
  opts: {
    /** Override the random source for deterministic tests. Returns a value in [0, 1). */
    randomFn?: () => number
    /** Override the sleep impl for tests (default `setTimeout`). */
    sleepFn?: (ms: number) => Promise<void>
  } = {},
): CompiledMocks {
  const { mocks, defaults } = normalizeInstallBody(raw)
  const baseDelay = typeof defaults?.delayMs === 'number' ? defaults.delayMs : 1200
  const jitter    = typeof defaults?.jitterMs === 'number' ? defaults.jitterMs : 400

  const random = opts.randomFn ?? Math.random
  const sleep  = opts.sleepFn ?? ((ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve()))

  const pickDelayMs = (
    toolName: string,
    params: Record<string, any>,
    perPattern?: number,
    perSpec?: number,
  ): number => {
    const explicit = perPattern ?? perSpec ?? defaults?.delayMs
    let target: number
    if (typeof explicit === 'number') {
      target = explicit
    } else {
      const cls = resolveToolClassDelay(toolName, params)
      target = cls ?? baseDelay
    }
    if (target <= 0) return 0
    const jittered = target + Math.round((random() * 2 - 1) * jitter)
    return Math.max(0, jittered)
  }

  const fns: Record<string, (params: Record<string, any>) => Promise<any>> = {}
  const syntheticDefs: Record<string, { description: string; paramKeys: string[] }> = {}
  const hiddenTools = new Set<string>()

  for (const [toolName, spec] of Object.entries(mocks)) {
    const s = spec as ToolMockSpec
    if ((s as any).type === 'static') {
      const stat = s as Extract<ToolMockSpec, { type: 'static' }>
      const resp = stat.response
      const specDelay = typeof stat.delayMs === 'number' ? stat.delayMs : undefined
      fns[toolName] = async (params: Record<string, any>) => {
        await sleep(pickDelayMs(toolName, params, undefined, specDelay))
        return resp
      }
    } else if ((s as any).type === 'pattern') {
      const pat = s as Extract<ToolMockSpec, { type: 'pattern' }>
      const patterns = pat.patterns
      const defaultResp = pat.default ?? { ok: true }
      const specDelay = typeof pat.delayMs === 'number' ? pat.delayMs : undefined
      const defaultDelay = typeof pat.defaultDelayMs === 'number' ? pat.defaultDelayMs : undefined
      fns[toolName] = async (params: Record<string, any>) => {
        const paramsStr = JSON.stringify(params).toLowerCase()
        for (const p of patterns) {
          const allMatch = Object.values(p.match).every(
            (substr: any) => paramsStr.includes(String(substr).toLowerCase())
          )
          if (allMatch) {
            const perPatternDelay = typeof p.delayMs === 'number' ? p.delayMs : undefined
            await sleep(pickDelayMs(toolName, params, perPatternDelay, specDelay))
            return p.response
          }
        }
        await sleep(pickDelayMs(toolName, params, defaultDelay, specDelay))
        return defaultResp
      }
    }

    if ((s as any).description || (s as any).paramKeys) {
      syntheticDefs[toolName] = {
        description: (s as any).description || `External integration tool: ${toolName}`,
        paramKeys: (s as any).paramKeys || [],
      }
    }
    if ((s as any).hidden) {
      hiddenTools.add(toolName)
    }
  }

  return { fns, syntheticDefs, hiddenTools, defaults: { delayMs: baseDelay, jitterMs: jitter } }
}
