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

/**
 * Build the environment variables needed for assigning a project to a runtime pod or VM.
 * Gathers PROJECT_ID, AI_PROXY_TOKEN, RUNTIME_AUTH_SECRET, WEBHOOK_TOKEN, S3 config, etc.
 */
export async function buildProjectEnv(
  projectId: string,
  opts?: { logPrefix?: string },
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
        workspace: { select: { composioScope: true } },
      } as any,
    }) as (Record<string, any> & {
      workspaceId?: string | null
      name?: string | null
      settings?: unknown
      cloudSyncMode?: string | null
      workspace?: { composioScope?: string | null } | null
    }) | null
    if (project) {
      if (project.workspaceId) env.WORKSPACE_ID = project.workspaceId
      // TEMPLATE_ID intentionally not exported. The marketplace install
      // flow pre-seeds the workspace, so the runtime no longer needs a
      // template id at boot. The `.template` marker file (legacy) is
      // also no longer read — see agent-runtime/src/server.ts.
      if (project.name) env.AGENT_NAME = project.name

      // Per-project cloud sync strategy. Default `s3` is omitted so
      // existing pods boot with identical env to today (no behavioral
      // change unless a project explicitly opts into the new modes).
      // Routed by `agent-runtime/src/server.ts` `resolveCloudSyncMode`.
      if (project.cloudSyncMode && project.cloudSyncMode !== 's3') {
        env.SHOGO_CLOUD_SYNC_MODE = project.cloudSyncMode
      }

      // Tell the runtime which scope to use for Composio user IDs.
      // Falls back to 'workspace' (the new default) when the workspace
      // row is missing the column or the join didn't return a value.
      const scope = project.workspace?.composioScope
      env.COMPOSIO_USER_SCOPE = scope === 'project' || scope === 'workspace' ? scope : 'workspace'

      const settings = project.settings as Record<string, unknown> | null

      // Per-project workspace mount override (default: true = mounted)
      if (settings?.mountWorkspace === false) {
        env.MOUNT_WORKSPACE = 'false'
      }

      // Tech stack is sourced exclusively from project.settings.techStackId
      // now that templateId is gone. Marketplace installs (the only flow
      // that creates new projects) populate this field directly from the
      // listing's source project at install time. Workspaces that pre-date
      // the consolidation already had it copied across by the
      // migrate-templates-to-marketplace script.
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
  // In K8s (SYSTEM_NAMESPACE set): use the Knative service DNS on port 80.
  // Desktop VMs: API_HOST is auto-set to the host bridge IP.
  // Local dev: falls back to localhost:API_PORT.
  const ns = process.env.SYSTEM_NAMESPACE
  let apiBase: string
  if (ns) {
    apiBase = `http://api.${ns}.svc.cluster.local`
  } else {
    const apiPort = process.env.API_PORT || '8002'
    const apiHost = process.env.API_HOST || 'localhost'
    apiBase = `http://${apiHost}:${apiPort}`
  }
  env.AI_PROXY_URL = `${apiBase}/api/ai/v1`
  env.ANTHROPIC_PROXY_URL = `${apiBase}/api/ai/anthropic`
  env.OPENAI_PROXY_URL = `${apiBase}/api/ai/v1`

  // Inject admin-configured agent model overrides so the gateway resolves correctly
  const modelOverrides = getAgentModeOverrides()
  if (modelOverrides.basic) env.AGENT_BASIC_MODEL = modelOverrides.basic
  if (modelOverrides.advanced) env.AGENT_ADVANCED_MODEL = modelOverrides.advanced

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
