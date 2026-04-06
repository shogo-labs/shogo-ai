// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared environment builder for project runtime assignment.
 *
 * Used by both WarmPoolController (Kubernetes) and VMWarmPoolController (desktop VM)
 * to assemble the environment variables a runtime pod/VM needs when assigned to a project.
 */

import { generateProxyToken } from '../ai-proxy-token'

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
      select: { workspaceId: true, templateId: true, name: true },
    })
    if (project) {
      if (project.templateId) env.TEMPLATE_ID = project.templateId
      if (project.name) env.AGENT_NAME = project.name
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
