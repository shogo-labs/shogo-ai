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
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { createBoardTools } from '../board-tools'
import type { ToolContext } from '../gateway-tools'
import { isSafeRelativePath, manifestHints, parseSystemManifest } from '../system-manifest'
import { CompanyWorld, type WorldSeed } from './company-sim/world'

export type SyntheticToolDef = { description: string; paramKeys: string[]; parameters?: unknown }

export type CompiledMocks = {
  fns: Record<string, (params: Record<string, any>) => any | Promise<any>>
  syntheticDefs: Record<string, SyntheticToolDef>
  hiddenTools: Set<string>
  defaults: { delayMs: number; jitterMs: number }
  /** The company simulation, when the install body carried a `sim` seed. */
  world: CompanyWorld | null
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
 * Pattern-mock matching for one `match` entry. When the call carries the
 * named param as a string (e.g. exec `command`), the substring must appear
 * in that param — so `{ command: 'stripe' }` matches `stripe customers list`
 * but not a `curl` whose JSON happens to contain `"timeout"`-style noise.
 * Patterns whose key isn't a param of the call (e.g. `{ url: 'acme' }` on a
 * `web({ query })` search) keep matching against the whole params JSON.
 */
export function matchesParam(params: Record<string, any> | undefined, paramsStr: string, key: string, substr: unknown): boolean {
  const raw = String(substr)
  const value = params?.[key]
  // `re:<pattern>` matches a case-insensitive regex against that param only
  // (never the whole JSON), e.g. `{ command: 're:(^|[\\s;&|(])gh\\s' }`.
  if (raw.startsWith('re:')) {
    if (typeof value !== 'string') return false
    try {
      return new RegExp(raw.slice(3), 'i').test(value)
    } catch {
      return false
    }
  }
  const haystack = typeof value === 'string' ? value.toLowerCase() : paramsStr
  return haystack.includes(raw.toLowerCase())
}

/**
 * Normalize the install body. Older eval callers POST a bare map of
 * tool→spec; newer demo callers POST `{ mocks, defaults? }`.
 */
export function normalizeInstallBody(
  raw: ToolMockInstallBody | ToolMockMap | Record<string, any>,
): { mocks: ToolMockMap; defaults?: { delayMs?: number; jitterMs?: number }; sim?: WorldSeed } {
  if (raw && typeof raw === 'object' && 'mocks' in (raw as any)) {
    return { mocks: (raw as any).mocks ?? {}, defaults: (raw as any).defaults, sim: (raw as any).sim }
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
    /** Real schemas for simulated tools (board_*, team_chat_*), keyed by tool name. */
    simSchemas?: Record<string, { description: string; parameters: unknown }>
    /** Workspace the simulated system_apply and template tools read and write shogo-system.yaml in. */
    workspaceDir?: string
  } = {},
): CompiledMocks {
  const { mocks, defaults, sim } = normalizeInstallBody(raw)
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

  const fns: Record<string, (params: Record<string, any>) => any | Promise<any>> = {}
  const syntheticDefs: Record<string, SyntheticToolDef> = {}
  const hiddenTools = new Set<string>()

  for (const [toolName, spec] of Object.entries(mocks)) {
    const s = spec as ToolMockSpec
    if ((s as any).type === 'static') {
      const stat = s as Extract<ToolMockSpec, { type: 'static' }>
      const resp = stat.response
      const specDelay = typeof stat.delayMs === 'number' ? stat.delayMs : undefined
      fns[toolName] = (params: Record<string, any>) => {
        if (resp === '__passthrough') return resp
        return sleep(pickDelayMs(toolName, params, undefined, specDelay)).then(() => resp)
      }
    } else if ((s as any).type === 'pattern') {
      const pat = s as Extract<ToolMockSpec, { type: 'pattern' }>
      const patterns = pat.patterns
      const defaultResp = pat.default ?? { ok: true }
      const specDelay = typeof pat.delayMs === 'number' ? pat.delayMs : undefined
      const defaultDelay = typeof pat.defaultDelayMs === 'number' ? pat.defaultDelayMs : undefined
      fns[toolName] = (params: Record<string, any>) => {
        const paramsStr = JSON.stringify(params ?? {}).toLowerCase()
        let response = defaultResp
        let delay = defaultDelay
        for (const p of patterns) {
          const allMatch = Object.entries(p.match).every(
            ([key, substr]: [string, any]) => matchesParam(params, paramsStr, key, substr),
          )
          if (allMatch) {
            response = p.response
            delay = typeof p.delayMs === 'number' ? p.delayMs : undefined
            break
          }
        }
        // Passthrough resolves synchronously (the real tool supplies its own
        // latency); callers that don't await the mock still see the sentinel.
        if (response === '__passthrough') return response
        return sleep(pickDelayMs(toolName, params, delay, specDelay)).then(() => response)
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

  // The simulation answers its tools statefully; per-eval mocks for the
  // same names are replaced so the world stays the one source of truth.
  let world: CompanyWorld | null = null
  if (sim) {
    world = new CompanyWorld(sim)
    const w = world
    for (const name of w.toolNames()) {
      fns[name] = async (params: Record<string, any>) => w.handle(name, params)
      const real = opts.simSchemas?.[name]
      const sys = sim.systemTools?.find((t) => t.name === name)
      if (real) syntheticDefs[name] = { description: real.description, paramKeys: [], parameters: real.parameters }
      else if (sys) syntheticDefs[name] = { description: sys.description, paramKeys: sys.paramKeys }
    }
    for (const name of w.hiddenTools()) hiddenTools.add(name)
    if (sim.admin && opts.workspaceDir) {
      Object.assign(fns, manifestToolFns(w, opts.workspaceDir))
      for (const name of ['work_template_list', 'work_template_add']) {
        const real = opts.simSchemas?.[name]
        if (real) syntheticDefs[name] = { description: real.description, paramKeys: [], parameters: real.parameters }
      }
    }
  }

  return { fns, syntheticDefs, hiddenTools, defaults: { delayMs: baseDelay, jitterMs: jitter }, world }
}

/**
 * system_apply and project_list against the simulated workspace, plus the
 * real template tools. The template tools only edit shogo-system.yaml, so
 * they run for real; system_apply parses that file and applies it to the
 * world.
 */
function manifestToolFns(world: CompanyWorld, workspaceDir: string): Record<string, (params: Record<string, any>) => Promise<any>> {
  const tools = createBoardTools({ workspaceDir, channels: new Map(), workspaceId: 'ws-sim', config: { channels: [] } } as unknown as ToolContext)
  const real = (name: string) => async (params: Record<string, any>) => {
    const t = tools.find((x) => x.name === name)!
    const out = await t.execute(`sim-${name}`, params as any)
    return (out as { details?: unknown }).details ?? out
  }
  return {
    work_template_list: real('work_template_list'),
    project_list: async () => ({
      workspaceId: 'ws-sim',
      currentProjectId: null,
      projects: world.snapshot().agents.map((a) => ({
        id: `proj-${a.key}`, name: a.name, description: null, manifestKey: a.key, isCurrent: false, onDisk: false, attachments: [],
        agent: { capabilities: a.capabilities, ...(a.heartbeatInterval ? { heartbeat: { enabled: true, interval: a.heartbeatInterval } } : {}) },
      })),
    }),
    work_template_add: real('work_template_add'),
    system_apply: async (params: Record<string, any>) => {
      const rel = typeof params.manifestPath === 'string' && params.manifestPath ? params.manifestPath : 'shogo-system.yaml'
      if (!isSafeRelativePath(rel)) return { error: `Unsafe manifestPath "${rel}"` }
      const abs = resolve(workspaceDir, rel)
      let source: string
      if (typeof params.manifest === 'string' && params.manifest.trim()) source = params.manifest
      else if (existsSync(abs)) source = readFileSync(abs, 'utf-8')
      else return { error: `No manifest at ${rel} and none given inline.`, code: 'manifest_missing' }
      const parsed = parseSystemManifest(source)
      if (!parsed.ok || !parsed.manifest) return { error: 'Manifest is invalid', issues: parsed.errors, hints: manifestHints(parsed.errors) }
      const dryRun = params.dryRun === true || params.dryRun === 'true'
      if (!dryRun && typeof params.manifest === 'string' && params.manifest.trim()) writeFileSync(abs, params.manifest)
      return world.applyManifest(parsed.manifest, dryRun)
    },
  }
}
