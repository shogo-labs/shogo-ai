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
import { getAgentTemplateById } from '@shogo/agent-runtime/src/agent-templates'

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
      select: { workspaceId: true, templateId: true, name: true, settings: true },
    })
    if (project) {
      if (project.templateId) env.TEMPLATE_ID = project.templateId
      if (project.name) env.AGENT_NAME = project.name

      const settings = project.settings as Record<string, unknown> | null
      const techStackFromSettings = settings?.techStackId as string | undefined
      if (techStackFromSettings) {
        env.TECH_STACK_ID = techStackFromSettings
      } else if (project.templateId) {
        const template = getAgentTemplateById(project.templateId)
        if (template?.techStack) env.TECH_STACK_ID = template.techStack
      }

      const { getProjectOwnerUserId } = await import('../project-user-context')
      const ownerUserId = await getProjectOwnerUserId(projectId)
      env.AI_PROXY_TOKEN = await generateProxyToken(
        projectId,
        project.workspaceId,
        ownerUserId,
        7 * 24 * 60 * 60 * 1000,
      )
    }
  } catch (err: any) {
    console.error(`[${prefix}] Failed to generate proxy token for ${projectId}:`, err.message)
  }
  console.log(`[${prefix}] proxy token took ${Date.now() - tokenStart}ms`)

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

  console.log(`[${prefix}] total ${Date.now() - startTime}ms for ${projectId}`)
  return env
}
