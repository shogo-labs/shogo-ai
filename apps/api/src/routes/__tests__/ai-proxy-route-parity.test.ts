// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Route-parity guard for the proxy routers.
 *
 * A cloud-authed desktop runs the bundled api as a gateway: requests that need
 * a provider key must be answered by Shogo Cloud, which holds the key and bills
 * the workspace. That decision used to be applied by hand, one route at a time,
 * and it drifted — chat, responses and Anthropic messages forwarded while
 * images, video, 3D and transcription kept resolving a local key and answered
 * `provider_not_configured` on a machine whose key was saved in cloud admin
 * (SHO-74). `tools-proxy.ts` and `integrations.ts` grew their own forwarders
 * in the same way, and `voice.ts` still has routes with no cloud branch at all.
 *
 * So the parity is checked in CI rather than remembered. Every route in a
 * router listed below must be one of:
 *   1. under a forwarded prefix (a `router.use` that answers it in cloud),
 *   2. calling a cloud-forwarding helper, or
 *   3. on that router's allowlist, with a written reason.
 * A route with none of those fails, naming the route and the file. An
 * allowlist entry that has become forwarding (the gap got fixed) or that no
 * longer matches a registered route also fails, so the list cannot rot.
 *
 * Adding another router that talks to providers is one entry in `ROUTERS`.
 */

import { describe, expect, test } from 'bun:test'

type LocalOnlyEntry = string | { reason: string; readsCloudState?: boolean }

interface RouterSpec {
  /** Short name used in failure messages. */
  name: string
  /** Router source, relative to this test file. */
  file: string
  /** Path prefixes answered by a `router.use` cloud forwarder. */
  forwardedPrefixes?: () => string[]
  /**
   * Every registered route delegates to this handler, which does the cloud
   * forward once for all of them. The guard then checks the delegate's body
   * instead of each one-line registration.
   */
  delegatesTo?: string
  /** Routes that must stay on the local instance, with the reason why. */
  localOnly: Record<string, LocalOnlyEntry>
}

/**
 * Call shapes that mean "this route leaves for Shogo Cloud". Explicit on
 * purpose: a new helper must be added here, which is the moment to think about
 * whether it really forwards. The gate check itself is deliberately *not* a
 * marker — `/ai/proxy/health` reports the gate without serving a request.
 */
const CLOUD_FORWARD_CALLS = [
  'getShogoCloudUrl(',
  'forwardChatCompletionsToCloud(',
  'forwardResponsesToCloud(',
  'forwardAnthropicToCloud(',
  'forwardToShogoCloud(',
  'forwardToCloud(',
  'forwardRequest(',
  'forwardIntegrationsToCloud(',
  // Forwards `/api/ai/v1/live/sessions` to cloud itself when the gate is on,
  // so the routes that call it already work on a cloud-authed desktop.
  'createLiveWebRtcSession(',
  // Delegates to `voice-media.ts`, which forwards under the same gate. Every
  // hosted media route — the two legacy aliases and the registry-dispatched
  // `/voice/op/:opId` — goes through that file's one executor.
  'handleVoiceTts(',
  'handleVoiceMusic(',
  'handleVoiceOp(',
  'forwardVoiceToCloud(',
]

const ROUTE_RE = /router\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/g

const PRE_EXISTING = 'KNOWN GAP — '

/** `voice.ts`: hosted voice mode, Twilio telephony and convai admin. */
const VOICE_LOCAL_ONLY: Record<string, LocalOnlyEntry> = {
  // Real gaps: these resolve a *local* provider credential, so on a
  // cloud-authed desktop they 503 instead of reaching the cloud's key.
  '/voice/signed-url':
    `${PRE_EXISTING}resolves the local ELEVENLABS_API_KEY (resolveElevenLabsClient); hosted voice mode needs a desktop→cloud branch`,
  '/voice/twilio/available-numbers/:projectId':
    `${PRE_EXISTING}needs the cloud Twilio account to list numbers; by definition the desktop has none`,
  '/voice/twilio/provision-number/:projectId':
    `${PRE_EXISTING}buys a number on the cloud Twilio account and creates the convai agent with the cloud key`,
  '/voice/twilio/outbound/:projectId':
    `${PRE_EXISTING}places the call with cloud TWILIO_* + ElevenLabs credentials`,
  '/voice/twilio/number/:projectId':
    `${PRE_EXISTING}releases a number on the cloud Twilio account`,
  '/projects/:projectId/agents/sync':
    `${PRE_EXISTING}pushes project agents to ElevenLabs convai with the local ELEVENLABS_API_KEY`,

  // Local by design: no provider credential involved.
  '/voice/live/delegate/:chatSessionId':
    'local by design: model calls go through the local AI proxy, which forwards chat',
  '/voice/translator/chat/:chatSessionId':
    'local by design: LLM stream via the AI proxy; the rest is local DB persistence',
  '/voice/transcript/:chatSessionId':
    'local by design: writes a ChatMessage row, no provider call',
  '/voice/config/:projectId':
    'local by design: reads the project voice config from the local DB',
  '/voice/usage/:projectId':
    'local by design: aggregates local call/usage rows',
  '/voice/calls/:projectId':
    'local by design: reads the local call log',
  '/voice/calls/:projectId/:callId':
    'local by design: reads one local call row',
  '/voice/elevenlabs/webhook':
    'local by design: inbound webhook delivered by ElevenLabs to the cloud host (public URL + ELEVENLABS_WEBHOOK_SECRET); the desktop receives neither',
  '/voice/twilio/status/:projectId':
    'local by design: inbound Twilio status callback, verified with TWILIO_AUTH_TOKEN the desktop does not have',
}

/** Read from `ai-proxy.ts` so the guard and the forwarder cannot disagree. */
function cloudForwardedAiPrefixes(text: string): string[] {
  const block = text.match(/export const CLOUD_FORWARDED_AI_PREFIXES = \[([\s\S]*?)\]/)
  if (!block) throw new Error('CLOUD_FORWARDED_AI_PREFIXES is missing from routes/ai-proxy.ts')
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
}

let aiProxySource = ''

const ROUTERS: RouterSpec[] = [
  {
    name: 'ai-proxy',
    file: '../ai-proxy.ts',
    forwardedPrefixes: () => cloudForwardedAiPrefixes(aiProxySource),
    localOnly: {
      '/ai/v1/models': 'local model registry plus this workspace\'s visibility rows; the cloud has its own list',
      '/ai/proxy/tokens': 'mints an rt_v1 token for the local runtime — nothing to forward',
      '/ai/v1/access': 'reads the local workspace\'s advanced-model entitlement',
      '/ai/v1/subscription': 'inspection of the local subscription/wallet view',
      '/ai/proxy/health': {
        reason: 'local health probe: reports whether cloud forwarding is on and probes provider keys; it serves no provider request',
        readsCloudState: true,
      },
      '/ai/upstream-health': 'local upstream provider probe',
      '/ai/anthropic/v1/models': `${PRE_EXISTING}still resolves a local ANTHROPIC_API_KEY (follow-up to SHO-74)`,
    },
  },
  {
    // Composio / Serper / OpenAI passthroughs forward through `forwardRequest`,
    // social media through its own gate. No allowlist entries today.
    name: 'tools-proxy',
    file: '../tools-proxy.ts',
    localOnly: {},
  },
  {
    // All five routes forward through `forwardIntegrationsToCloud`.
    name: 'integrations',
    file: '../integrations.ts',
    localOnly: {},
  },
  {
    name: 'voice',
    file: '../voice.ts',
    localOnly: VOICE_LOCAL_ONLY,
  },
  {
    // Hosted TTS, music and every registry op: all three registrations delegate
    // to `executeVoiceOp`, which forwards to cloud under the gate (SHO-74 §2,
    // SHO-112).
    name: 'voice-media',
    file: '../voice-media.ts',
    delegatesTo: 'executeVoiceOp',
    localOnly: {},
  },
]

interface RegisteredRoute {
  method: string
  path: string
  /** Source text from this route's registration to the next one. */
  body: string
}

function parseRoutes(text: string): RegisteredRoute[] {
  const matches = [...text.matchAll(ROUTE_RE)]
  return matches.map((match, index) => {
    const start = match.index ?? 0
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length
    return { method: match[1], path: match[2], body: text.slice(start, end) }
  })
}

function forwardsToCloud(route: Pick<RegisteredRoute, 'path' | 'body'>, spec: RouterSpec): boolean {
  const prefixes = spec.forwardedPrefixes?.() ?? []
  if (prefixes.some((prefix) => route.path.startsWith(prefix))) return true
  return CLOUD_FORWARD_CALLS.some((call) => route.body.includes(call))
}

/**
 * The body of `function <name>(…) { … }`, brace-matched. Used to check the one
 * shared forwarder a set of thin registrations delegates to.
 */
function functionBody(text: string, name: string): string | null {
  const start = text.indexOf(`function ${name}(`)
  if (start < 0) return null
  // Skip the parameter list first: default values like `deps: Deps = {}` would
  // otherwise look like the body's opening brace.
  const parenOpen = text.indexOf('(', start)
  let parenDepth = 0
  let afterParams = -1
  for (let i = parenOpen; i < text.length; i++) {
    if (text[i] === '(') parenDepth++
    else if (text[i] === ')' && --parenDepth === 0) {
      afterParams = i + 1
      break
    }
  }
  if (afterParams < 0) return null
  const open = text.indexOf('{', afterParams)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/** Problems with one router, as human-readable lines (empty = parity holds). */
function parityProblems(spec: RouterSpec, text: string): string[] {
  const routes = parseRoutes(text)
  const problems: string[] = []

  for (const route of routes) {
    const label = `${route.method.toUpperCase()} ${route.path}`
    const allowlisted = spec.localOnly[route.path]
    const readsCloudState = typeof allowlisted === 'object' && allowlisted.readsCloudState
    if (forwardsToCloud(route, spec)) {
      if (allowlisted && !readsCloudState) {
        problems.push(`${label} is allowlisted as local but now forwards — remove it from ${spec.name} localOnly`)
      }
      continue
    }
    if (!allowlisted) {
      problems.push(
        `${label} neither forwards to cloud nor is allowlisted — forward it, or add it to the ${spec.name} allowlist with the reason`,
      )
    }
  }

  if (spec.delegatesTo) {
    const body = functionBody(text, spec.delegatesTo)
    if (!body) problems.push(`${spec.name} routes delegate to ${spec.delegatesTo}() but it is gone from the file`)
    else if (!CLOUD_FORWARD_CALLS.some((call) => body.includes(call))) {
      problems.push(`${spec.name} routes delegate to ${spec.delegatesTo}(), which never forwards to cloud`)
    }
  }

  const registered = new Set(routes.map((route) => route.path))
  for (const path of Object.keys(spec.localOnly)) {
    if (!registered.has(path)) {
      problems.push(`${path} is on the ${spec.name} allowlist but no such route is registered — drop the stale entry`)
    }
  }

  for (const [path, entry] of Object.entries(spec.localOnly)) {
    const reason = typeof entry === 'string' ? entry : entry.reason
    if (!reason.trim()) problems.push(`${path} is allowlisted with no reason`)
  }

  return problems
}

async function readRouter(file: string): Promise<string> {
  return Bun.file(new URL(file, import.meta.url)).text()
}

describe('proxy route parity', () => {
  test('the routers still register the routes this guard was written against', async () => {
    aiProxySource = await readRouter('../ai-proxy.ts')
    const aiRoutes = parseRoutes(aiProxySource)
    expect(aiRoutes.length).toBeGreaterThan(20)
    expect(aiRoutes.map((route) => route.path)).toContain('/ai/v1/3d/generations')

    const voiceRoutes = parseRoutes(await readRouter('../voice.ts'))
    // Includes the two registrations whose path sits on the next line.
    expect(voiceRoutes.length).toBeGreaterThan(15)
    expect(voiceRoutes.map((route) => route.path)).toContain('/voice/twilio/available-numbers/:projectId')

    expect(parseRoutes(await readRouter('../tools-proxy.ts')).map((route) => route.path)).toContain('/tools/social/:platform/:op')
  })

  for (const spec of ROUTERS) {
    test(`every route in ${spec.name} forwards to cloud, or is local with a reason`, async () => {
      const text = await readRouter(spec.file)
      if (spec.name === 'ai-proxy') aiProxySource = text
      expect(parityProblems(spec, text)).toEqual([])
    })
  }

  test('the ai-proxy forwarded prefixes still cover the media, 3D, music and audio families', async () => {
    expect(cloudForwardedAiPrefixes(await readRouter('../ai-proxy.ts'))).toEqual([
      '/ai/v1/images/',
      '/ai/v1/media/',
      '/ai/v1/videos/',
      '/ai/v1/music/',
      '/ai/v1/3d/',
      '/ai/v1/audio/',
    ])
  })

  test('the chat-family forwarders still check the cloud gate', async () => {
    // These rewrite bodies / headers, so they forward inline rather than going
    // through the shared helpers. The guard must not accept the call alone: a
    // handler that forwards without the gate would send BYOK traffic to cloud.
    const routes = parseRoutes(await readRouter('../ai-proxy.ts'))
    const dedicated = [
      '/ai/v1/chat/completions',
      '/ai/v1/responses',
      '/ai/anthropic/v1/messages',
      '/ai/anthropic/v1/messages/count_tokens',
    ]
    const ungated = dedicated
      .map((path) => {
        const route = routes.find((candidate) => candidate.path === path)
        if (!route) return `${path} is no longer registered — update this guard`
        if (!route.body.includes('isShogoCloudForwarding()')) {
          return `${path} forwards without checking isShogoCloudForwarding(), so it only ever runs locally`
        }
        return null
      })
      .filter((entry): entry is string => entry !== null)

    expect(ungated).toEqual([])
  })

  test('hosted voice media checks the cloud gate before the local key', async () => {
    // The router checks above only prove the registrations delegate. Pin the
    // shared executor: the cloud branch has to run before the local
    // ELEVENLABS_API_KEY lookup, or a cloud-authed desktop keeps answering 503
    // for every op, not just the two the aliases cover.
    const text = await readRouter('../voice-media.ts')
    const body = functionBody(text, 'executeVoiceOp')
    expect(body).not.toBeNull()
    const gate = body!.indexOf('isShogoCloudForwarding()')
    const localKey = body!.indexOf('resolveShogoElevenLabsClient(')
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(localKey).toBeGreaterThan(gate)
  })

  test('the voice-media aliases delegate instead of re-implementing', async () => {
    // SHO-112: `/voice/tts` and `/voice/music` are thin aliases over the
    // registry executor. A second copy of auth/limits/credential handling is
    // exactly what this guard exists to prevent.
    const text = await readRouter('../voice-media.ts')
    for (const name of ['handleVoiceTts', 'handleVoiceMusic', 'handleVoiceOp']) {
      const body = functionBody(text, name)
      expect(body, `${name} is gone from voice-media.ts`).not.toBeNull()
      expect(body!, name).toContain('executeVoiceOp(')
      expect(body!, `${name} must not resolve the key itself`).not.toContain(
        'resolveShogoElevenLabsClient(',
      )
    }
  })

  test('no router keeps a private copy of the cloud gate', async () => {
    // Russell, 2026-10-19: tools always use the relay while we are cloud
    // authed, so the condition lives once. Both `tools-proxy` and
    // `integrations` had grown their own `!!SHOGO_API_KEY` predicate, which also
    // fired on the cloud itself and disagreed with the AI proxy about BYOK.
    const problems: string[] = []
    for (const spec of ROUTERS) {
      const text = await readRouter(spec.file)
      const own = text.match(/(?:export )?function (isShogoCloud[A-Za-z]*|shouldForwardToCloud)\s*\(/)
      if (own) {
        problems.push(`${spec.name} defines ${own[1]}() locally — import the gate from lib/cloud-forwarding.ts`)
      }
      const forwards = /\b(forwardToShogoCloud|forwardToCloud|forwardIntegrationsToCloud)\s*\(/.test(text)
      if (forwards && !/from '\.\.\/lib\/cloud-forwarding'/.test(text)) {
        problems.push(`${spec.name} forwards without importing a gate from lib/cloud-forwarding.ts`)
      }
    }
    expect(problems).toEqual([])
  })

  test('a new local-only route is reported by name (the guard is not a no-op)', async () => {
    // A plausible next route on a router whose routes all forward today.
    const tools = ROUTERS.find((spec) => spec.name === 'tools-proxy')!
    const dummy = `export function toolsProxyRoutes() {
  const router = new Hono()
  router.post('/tools/linkedin/publish', async (c) => c.json({ ok: true }))
}`
    expect(parityProblems(tools, dummy)).toEqual([
      'POST /tools/linkedin/publish neither forwards to cloud nor is allowlisted — forward it, or add it to the tools-proxy allowlist with the reason',
    ])

    // A allowlisted route that starts forwarding is reported too.
    const voice = ROUTERS.find((spec) => spec.name === 'voice')!
    const fixed = `export function voiceRoutes() {
  const router = new Hono()
  router.get('/voice/signed-url', async (c) => forwardToShogoCloud(c, { pathname: '/voice/signed-url' }))
}`
    expect(parityProblems(voice, fixed)).toContain(
      'GET /voice/signed-url is allowlisted as local but now forwards — remove it from voice localOnly',
    )
  })
})
