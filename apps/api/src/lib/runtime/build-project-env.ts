// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared environment builder for project runtime assignment.
 *
 * Used by both WarmPoolController (Kubernetes) and VMWarmPoolController (desktop VM)
 * to assemble the environment variables a runtime pod/VM needs when assigned to a project.
 */

import { generateProxyToken } from '../ai-proxy-token'
import { getAgentModeOverrides } from '@shogo/model-catalog'
import { buildAutoTierMapEnv } from './auto-tier-env'
import { INSTANCE_SIZES } from '../../config/instance-sizes'
import { buildToolsProxyUrl } from '../cloud-urls'

/**
 * Build the environment variables needed for assigning a project to a runtime pod or VM.
 * Gathers PROJECT_ID, AI_PROXY_TOKEN, RUNTIME_AUTH_SECRET, WEBHOOK_TOKEN, S3 config, etc.
 */
export async function buildProjectEnv(
  projectId: string,
  opts?: { logPrefix?: string; forMetal?: boolean },
): Promise<Record<string, string>> {
  const prefix = opts?.logPrefix ?? 'buildProjectEnv'
  const startTime = Date.now()
  const env: Record<string, string> = {
    PROJECT_ID: projectId,
  }

  const tokenStart = Date.now()
  try {
    const { prisma } = await import('../prisma')
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        workspaceId: true,
        name: true,
        settings: true,
        cloudSyncMode: true,
        workspace: { select: { composioScope: true, instanceSize: true } },
      } as any,
    }) as (Record<string, any> & {
      workspaceId?: string | null
      name?: string | null
      settings?: unknown
      cloudSyncMode?: string | null
      workspace?: { composioScope?: string | null; instanceSize?: string | null } | null
    }) | null
    if (project) {
      if (project.workspaceId) env.WORKSPACE_ID = project.workspaceId
      // TEMPLATE_ID intentionally not exported. The marketplace install
      // flow pre-seeds the workspace, so the runtime no longer needs a
      // template id at boot. The `.template` marker file (legacy) is
      // also no longer read — see agent-runtime/src/server.ts.
      if (project.name) env.AGENT_NAME = project.name

      // Per-project cloud sync strategy. The pod-side default is now
      // `git_only` (see shared-runtime `resolveCloudSyncMode`), so we
      // inject the mode for EVERY project — otherwise a project explicitly
      // pinned to `s3` would silently boot in git_only. Routed by
      // `agent-runtime/src/server.ts`.
      if (project.cloudSyncMode) {
        env.SHOGO_CLOUD_SYNC_MODE = project.cloudSyncMode
      }

      // Tell the runtime which scope to use for Composio user IDs.
      // Falls back to 'workspace' (the new default) when the workspace
      // row is missing the column or the join didn't return a value.
      const scope = project.workspace?.composioScope
      env.COMPOSIO_USER_SCOPE = scope === 'project' || scope === 'workspace' ? scope : 'workspace'

      // Always-on: paid instance tiers keep Knative min-scale ≥ 1 (no cold
      // starts). The metal substrate has no per-service min-scale, so we signal
      // the metal-agent's idle-suspend reaper to never suspend this project's
      // microVM. Uses the RAW workspace tier (NOT the mobile tech-stack floor):
      // the floor only lifts resource headroom for free-tier mobile stacks and
      // must not grant them the paid always-on perk. Harmless on Knative (the
      // ksvc min-scale annotation drives warmth there; this env is ignored).
      const instanceSize = project.workspace?.instanceSize || 'micro'
      const sizeSpec = (INSTANCE_SIZES as Record<string, { minScale: number }>)[instanceSize]
      if (sizeSpec && sizeSpec.minScale >= 1) {
        env.SHOGO_ALWAYS_ON = '1'
      }

      const settings = project.settings as Record<string, unknown> | null

      // Per-project workspace mount override (default: true = mounted)
      if (settings?.mountWorkspace === false) {
        env.MOUNT_WORKSPACE = 'false'
      }

      // BETA: per-chat git worktrees (off by default). Injected so the
      // runtime seeds config.json on cold boot; the live toggle path goes
      // through PATCH /agent/config. Read in agent-runtime/src/server.ts.
      if (settings?.gitWorktreesEnabled === true) {
        env.SHOGO_GIT_WORKTREES = '1'
      }

      // Tech stack is sourced exclusively from project.settings.techStackId
      // now that templateId is gone. Marketplace installs (the only flow
      // that creates new projects) populate this field directly from the
      // listing's source project at install time. Pre-existing workspaces
      // already had it copied across by the one-shot templates→marketplace
      // migration that ran before this seed path was removed.
      const techStackFromSettings = settings?.techStackId as string | undefined
      if (techStackFromSettings) {
        env.TECH_STACK_ID = techStackFromSettings
      }

      const { getProjectOwnerUserId } = await import('../project-user-context')
      const ownerUserId = await getProjectOwnerUserId(projectId)
      env.AI_PROXY_TOKEN = await generateProxyToken(
        projectId,
        project.workspaceId ?? 'local-dev',
        ownerUserId,
        7 * 24 * 60 * 60 * 1000,
      )
    }
  } catch (err: any) {
    console.error(`[${prefix}] Failed to generate proxy token for ${projectId}:`, err.message)
  }
  console.log(`[${prefix}] proxy token took ${Date.now() - tokenStart}ms`)

  // RUNTIME_AUTH_SECRET is the pod's project-scoped bearer capability for
  // calling the Shogo API (see `middleware/auth.ts` runtime-token branch).
  // Operator gotchas — secret rotation, synthetic userId, leak blast
  // radius — are documented in apps/api/src/lib/runtime-token.md. Any
  // change to how this env is derived or injected should be reviewed
  // against that doc first.
  const { deriveRuntimeToken, deriveWebhookToken } = await import('../runtime-token')
  env.RUNTIME_AUTH_SECRET = deriveRuntimeToken(projectId)
  env.WEBHOOK_TOKEN = deriveWebhookToken(projectId)

  // AI proxy URLs — the runtime needs to know where the proxy server is.
  // Metal microVMs (Firecracker on bare metal) run OUTSIDE the OKE cluster, so
  //   the in-cluster service DNS (api.<ns>.svc.cluster.local) is UNRESOLVABLE
  //   from the guest — every LLM turn fails with "Provider error: Connection
  //   error." Use the PUBLIC API URL instead (the guest egress-NATs to the
  //   internet). TLS + the project-scoped AI_PROXY_TOKEN keep this safe over the
  //   public path — same model desktop VMs already use.
  // In K8s (SYSTEM_NAMESPACE set): use the Knative service DNS on port 80.
  // Desktop VMs: API_HOST is auto-set to the host bridge IP.
  // Local dev: falls back to localhost:API_PORT.
  const ns = process.env.SYSTEM_NAMESPACE
  const publicApiBase = (process.env.SHOGO_PUBLIC_API_URL || process.env.APP_URL || '').replace(/\/+$/, '')
  let apiBase: string
  if (opts?.forMetal && publicApiBase) {
    apiBase = publicApiBase
  } else if (ns) {
    if (opts?.forMetal) {
      // Metal but no public URL configured → the guest cannot reach the AI proxy.
      // Surface loudly rather than silently baking an unreachable URL.
      console.error(
        `[${prefix}] metal env for ${projectId} but SHOGO_PUBLIC_API_URL/APP_URL unset — ` +
          `AI proxy will be UNREACHABLE from the guest (falling back to in-cluster DNS)`,
      )
    }
    apiBase = `http://api.${ns}.svc.cluster.local`
  } else {
    const apiPort = process.env.API_PORT || '8002'
    const apiHost = process.env.API_HOST || 'localhost'
    apiBase = `http://${apiHost}:${apiPort}`
  }
  env.AI_PROXY_URL = `${apiBase}/api/ai/v1`
  env.ANTHROPIC_PROXY_URL = `${apiBase}/api/ai/anthropic`
  env.OPENAI_PROXY_URL = `${apiBase}/api/ai/v1`

  // TOOLS_PROXY_URL — the runtime appends `/serper/...` (web search),
  // `/composio` and embeddings paths to this, so it MUST end in `/api/tools`
  // (see buildToolsProxyUrl + gateway-tools.ts serperSearch). Knative pods and
  // the k8s warm pool inject this at pod-creation (knative-project-manager.ts /
  // warm-pool-controller.ts), but metal microVMs are assigned purely from this
  // builder's output — without it the guest has AI_PROXY_TOKEN but no proxy URL,
  // so serperSearch builds `undefined/serper/search` and every web SEARCH fails
  // with "fetch() URL is invalid". Derived from the same apiBase as the AI proxy
  // URLs, so it uses the public URL on metal and in-cluster DNS on k8s.
  env.TOOLS_PROXY_URL = buildToolsProxyUrl(apiBase)

  // PUBLIC_PREVIEW_URL — the externally-reachable, deterministic preview URL
  // ({projectId}.preview.{env}.shogo.ai). Pods created directly by the Knative
  // manager get this baked into the Service spec, but pooled/warm pods are
  // assigned via this shared env builder and otherwise never learn their public
  // URL — so the agent falls back to a localhost link the user can't open (and
  // the gateway's localhost→preview rewriter, which keys off this var, stays
  // disabled). Inject it for cloud (k8s) only; desktop VMs intentionally leave
  // it unset because there localhost IS the URL the user opens.
  if (ns) {
    try {
      const { getPreviewUrl } = await import('../knative-project-manager')
      env.PUBLIC_PREVIEW_URL = getPreviewUrl(projectId)
    } catch (err: any) {
      console.error(`[${prefix}] Failed to derive PUBLIC_PREVIEW_URL for ${projectId}:`, err.message)
    }
  }

  // Pin SHOGO_API_URL so the SDK's voice runtime-token proxy mode
  // (packages/sdk/src/voice/server.ts) reaches the in-cluster Shogo API
  // instead of falling back to http://localhost:8002. Same apiBase the
  // AI proxy URLs use — both endpoints live on the API service.
  env.SHOGO_API_URL = apiBase

  // Public-facing URLs the guest needs for browser-reachable contexts. The
  // Knative pod template injects both (knative-project-manager.ts); metal
  // microVMs are assigned solely from this builder, so forward them here too:
  //   - BETTER_AUTH_URL: base for OAuth callback URLs the runtime builds for
  //     Composio `connect` — without it the callback points at a wrong/empty
  //     host and the OAuth round-trip fails.
  //   - SHOGO_PUBLIC_API_URL: user-browser-reachable API origin baked into
  //     webchat widget embed snippets the agent generates.
  // Both are public URLs, reachable from the metal guest's egress NAT.
  if (process.env.BETTER_AUTH_URL) {
    env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL
  }
  if (process.env.SHOGO_PUBLIC_API_URL) {
    env.SHOGO_PUBLIC_API_URL = process.env.SHOGO_PUBLIC_API_URL
  }

  // Inject admin-configured agent model overrides so the gateway resolves correctly
  const modelOverrides = getAgentModeOverrides()
  if (modelOverrides.basic) env.AGENT_BASIC_MODEL = modelOverrides.basic
  if (modelOverrides.advanced) env.AGENT_ADVANCED_MODEL = modelOverrides.advanced

  // Inject admin-configured Auto-mode tier overrides (public aliases resolved
  // to backing model ids) so the spawn router can route Auto to e.g. Hoshi.
  const autoTierMapEnv = buildAutoTierMapEnv()
  if (autoTierMapEnv) env.AGENT_AUTO_TIER_MAP = autoTierMapEnv

  // OTEL telemetry → SigNoz. The k8s warm-pool / Knative pod templates inject
  // this at pod-creation (warm-pool-controller.ts), but metal microVMs are
  // assigned solely from this builder — without it a metal-hosted runtime emits
  // NO traces or logs to SigNoz (which is why metal turns are invisible in
  // observability). The endpoint is SigNoz Cloud (public), reachable from the
  // guest's egress NAT; SIGNOZ_INGESTION_KEY comes from a secretKeyRef on k8s,
  // so here we forward the literal value the API process already holds. A slow
  // or unreachable collector never blocks the guest — the OTEL SDK bounds the
  // export timeout and drops spans (see packages/core/src/instrumentation.ts).
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    env.OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    env.OTEL_SERVICE_NAME = 'shogo-runtime'
    if (process.env.SIGNOZ_INGESTION_KEY) {
      env.SIGNOZ_INGESTION_KEY = process.env.SIGNOZ_INGESTION_KEY
    }
  }

  if (process.env.S3_WORKSPACES_BUCKET) {
    env.S3_WORKSPACES_BUCKET = process.env.S3_WORKSPACES_BUCKET
    env.S3_REGION = process.env.S3_REGION || 'us-east-1'
    env.S3_WATCH_ENABLED = 'true'
    env.S3_SYNC_INTERVAL = '30000'
    if (process.env.S3_ENDPOINT) env.S3_ENDPOINT = process.env.S3_ENDPOINT
    if (process.env.S3_FORCE_PATH_STYLE === 'true') env.S3_FORCE_PATH_STYLE = 'true'
  }

  // Voice mock mode for demo recordings. When the API server has
  // SHOGO_VOICE_MODE=mock (or SHOGO_DEMO_VOICE=mock as a more obvious
  // alias), forward it into the pod env so `createClient().voice.telephony`
  // resolves to MockTelephonyClient inside the runtime. Effect: the agent
  // generates real `shogo.voice.telephony.outboundCall(...)` code, the SDK
  // returns canned data, no real Twilio/EL traffic, no usage-wallet debit.
  // See packages/sdk/src/voice/mock-telephony.ts.
  const voiceMode = process.env.SHOGO_VOICE_MODE || process.env.SHOGO_DEMO_VOICE
  if (voiceMode) {
    env.SHOGO_VOICE_MODE = voiceMode
  }

  // Browser-tool capture mode for demo recordings. When set, every
  // `browser` tool call dumps params + (for screenshots) PNG bytes to
  // this directory inside the pod. The Playwright capture script
  // (demo/playwright/scripts/capture-scene-1.ts) sets it to a path
  // mounted into the pod's workspace so the captured fixtures persist
  // out to the host filesystem. OFF in normal operation. Replay
  // happens in Playwright via loadBrowserFixturesFromDir() — the
  // runtime never reads the captured files itself.
  const captureDir = process.env.SHOGO_MOCK_CAPTURE_DIR
  if (captureDir) {
    env.SHOGO_MOCK_CAPTURE_DIR = captureDir
  }

  console.log(`[${prefix}] total ${Date.now() - startTime}ms for ${projectId}`)
  return env
}

/**
 * Build the environment for a SERVER-BACKED published microVM on the metal
 * substrate — the metal analog of KnativeProjectManager.createPublishedServerService's
 * env block. Starts from the normal metal project env (proxy tokens, public API
 * URLs, S3 source hydration) and layers the published-mode switches on top:
 *
 *   - SHOGO_PUBLISHED_MODE=true / PUBLISHED_SUBDOMAIN — run server.tsx only, no
 *     agent gateway (see packages/agent-runtime/src/server.ts).
 *   - SHOGO_CLOUD_SYNC_MODE=git_only — source is restored read-only from the
 *     durable git repo pinned to `published/<subdomain>`; no S3 source uploader.
 *   - SHOGO_ALWAYS_ON — pins the microVM against the host idle reaper when the
 *     app is always-on; otherwise it may suspend and wake on visit.
 *
 * Crucially it does NOT inject S3_PUBLISHED_DATA_BUCKET or AWS credentials: on
 * metal the guest holds no S3 creds (same trust model as preview), so writable
 * state durability is done host-side by the metal-agent (published-data-archive),
 * NOT by the guest's PublishedDataSync.
 */
export async function buildPublishedProjectEnv(
  projectId: string,
  subdomain: string,
  opts?: { alwaysOn?: boolean },
): Promise<Record<string, string>> {
  const env = await buildProjectEnv(projectId, { logPrefix: 'buildPublishedProjectEnv', forMetal: true })
  const publishDomain = process.env.PUBLISH_DOMAIN || 'shogo.one'

  env.SHOGO_PUBLISHED_MODE = 'true'
  env.PUBLISHED_SUBDOMAIN = subdomain
  env.PUBLISH_DOMAIN = publishDomain
  env.PUBLIC_PREVIEW_URL = `https://${subdomain}.${publishDomain}`
  // Source is restored read-only from the durable git repo (carries the
  // published tag + the builder's seed DB); pin git_only so no S3 source
  // uploader/watcher runs in published mode.
  env.SHOGO_CLOUD_SYNC_MODE = 'git_only'
  // Writable-state durability is host-side (metal-agent) — the guest must not
  // try to reach the published-data bucket itself (no creds on metal).
  delete env.S3_PUBLISHED_DATA_BUCKET

  if (opts?.alwaysOn) env.SHOGO_ALWAYS_ON = '1'
  else delete env.SHOGO_ALWAYS_ON

  return env
}
