// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { prisma } from '../lib/prisma'
import { createRuntimeManager, setRuntimeManager } from '../lib/runtime'
import { createApp } from './create-app'
import { deriveApiProfile } from './profile'
import { runtimeRoutes } from '../routes/runtime'
import { localAgentProxyRoutes } from '../routes/local-agent-proxy'
import { localTerminalRoutes } from '../routes/local-terminal'
import { localIdeRoutes } from '../routes/local-ide'
import { localPreviewRoutes } from '../routes/local-preview'
import { localWorkspaceRoutes } from '../routes/local-workspaces'
import { localThumbnailRoutes } from '../routes/local-thumbnail'
import { localProjectMetadataRoutes } from '../routes/local-project-metadata'
import { localHeartbeatRoutes } from '../routes/local-heartbeat'
import { localFilesRoutes } from '../routes/local-files'
import { externalPreviewRoutes } from '../routes/external-preview'
import { projectExportImportRoutes } from '../routes/project-export-import'
import { projectChatRoutes } from '../routes/project-chat'
import { workspaceChatRoutes } from '../routes/workspace-chat'
import { workspaceAgentRoutes, sessionAuthorize } from '../routes/workspace-agent'
import { workspaceMeetingRoutes, sharedMeetingRoutes } from '../routes/workspace-meetings'
import { conversationRoutes } from '../routes/conversations'
import { configureConversationAgentDispatcher, settleOrphanedAgentReplies } from '../services/conversation-agent-dispatcher'
import { scriptedAgentInvokeFromEnv } from '../services/conversation-agent-script'
import { createAgentTaskRoutes } from '../routes/agent-tasks'
import { diagnosticsRoutes } from '../../../../packages/shared-runtime/src/diagnostics'
import { testsRoutes } from '../routes/tests'
import { securityRoutes } from '../routes/security'
import { databaseRoutes } from '../routes/database'
import { checkpointRoutes } from '../routes/checkpoints'
import { aiProxyRoutes } from '../routes/ai-proxy'
import { aiLiveRoutes } from '../routes/ai-live'
import { voiceRoutes } from '../routes/voice'
import { rbacRoutes } from '../routes/rbac'
import { attachProjectPermissions } from '../lib/authz/project-permissions'
import { chatRoutes } from '../routes/chat'
import { createChatMessageEditRoutes } from '../routes/chat-message-edits'
import { createChatMessageFeedbackRoutes, createChatSessionFeedbackRoutes } from '../routes/chat-message-feedback'
import { createChatSessionForkRoutes } from '../routes/chat-session-fork'
import { chatQueuedMessageActionsRoutes } from '../routes/chat-queued-message-actions'
import { toolsProxyRoutes } from '../routes/tools-proxy'
import { techStackRoutes } from '../routes/tech-stacks'
import { apiKeyRoutes } from '../routes/api-keys'
import { integrationRoutes } from '../routes/integrations'
import { projectAuthConfigRoutes } from '../routes/project-auth-config'
import { localAuthRoutes } from '../routes/local-auth'
import { localUserRoutes } from '../routes/local-user'
import { localProjectsRoutes } from '../routes/local-projects'
import { localRemoteHostsRoutes } from '../routes/local-remote-hosts'
import { localLogsRoutes } from '../routes/local-logs'
import { meetingRoutes } from '../routes/meetings'
import { historyRoutes } from '../routes/history'
import { localSystemRoutes } from '../routes/local-system'
import { cloudWorkspaceListMiddleware, localCloudWorkspaceRoutes } from '../routes/local-cloud-proxy'
import { localPlatformRoutes } from '../routes/local-platform'
import { localSharedFileRoutes } from '../routes/local-shared-files'
import { marketplaceRoutes } from '../routes/marketplace'
import { appActionsRoutes } from '../routes/app-actions'
import { _resetAgentModelDefaultsCache, _resetUpstreamCredentialCache } from '../lib/federated-upstream'
import { createLocalGeneratedRoutes } from '../generated/local-routes'
import { runtimeInternalRoutes } from '../routes/internal-runtime-routes'
import { authenticateRuntimeToken } from '../routes/internal-runtime-auth'

const VITE_PORT = Number(process.env.VITE_PORT || 8081)

export interface LocalAppBundle {
  app: ReturnType<typeof createApp>
  runtimeManager: ReturnType<typeof createRuntimeManager>
  workspacesDir: string
  resetCaches(): void
}

async function getAuthUserId(c: any): Promise<string | null> {
  const resolved = c.get('auth')
  return resolved?.isAuthenticated && resolved.userId ? resolved.userId : null
}

/**
 * Compose the desktop API without starting a listener or bootstrapping the DB.
 *
 * Keeping composition separate makes route parity testable and lets the
 * Electron entrypoint own process lifecycle and WebSocket upgrades.
 */
export function createLocalApp(): LocalAppBundle {
  const workspacesDir = process.env.WORKSPACES_DIR || `${process.cwd()}/workspaces`
  const runtimeManager = createRuntimeManager()
  setRuntimeManager(runtimeManager)

  const app = createApp({
    profile: deriveApiProfile(),
    vitePort: VITE_PORT,
    health: (c) => c.json({ ok: true, redis: { healthy: true, latencyMs: 0, degraded: false } }),
  })

  app.route('/api', localPlatformRoutes())
  app.route('/api', localSystemRoutes())
  app.use('/api/workspaces', cloudWorkspaceListMiddleware)
  app.route(
    '/api',
    localCloudWorkspaceRoutes({
      resolveUserId: getAuthUserId,
      resolveUserEmail: async (id) =>
        (await prisma.user.findUnique({ where: { id }, select: { email: true } }))?.email ?? null,
    }),
  )
  app.route('/', localSharedFileRoutes({ workspacesDir }))
  app.route('/api/local/projects', localProjectsRoutes())
  // Runtime → API callbacks (trust, checkpoints, plans, workspace agent and
  // members, ...). Without them "Trust folder" never reaches the agent and
  // folder-linked repos stay read-only.
  app.route(
    '/api/internal',
    runtimeInternalRoutes({
      authenticate: authenticateRuntimeToken,
      loadProjectLifecycle: () => import('../services/project-lifecycle.service'),
      loadAgentCall: () => import('../services/agent-call.service'),
    }),
  )
  app.route('/api/local', localLogsRoutes())
  app.route('/api/local', localRemoteHostsRoutes({ runtimeManager }))
  app.route('/api', localAuthRoutes())
  app.route('/api', localUserRoutes())
  app.route('/', meetingRoutes)

  app.route('/api', runtimeRoutes({ runtimeManager, workspacesDir }))
  app.route('/api', localAgentProxyRoutes({ runtimeManager }))
  app.route('/api', localTerminalRoutes({ runtimeManager, workspacesDir }))
  app.route('/api', localIdeRoutes())
  app.route('/api', localPreviewRoutes({ runtimeManager }))
  app.route('/api', localWorkspaceRoutes())
  app.route('/api', localThumbnailRoutes())
  app.route('/api', localProjectMetadataRoutes())
  app.route('/api', localHeartbeatRoutes())
  app.route('/api', localFilesRoutes({ workspacesDir }))
  app.route('/api/projects', externalPreviewRoutes())
  // Project export (.shogo / source .zip) and import. The slim-local refactor
  // moved this behind the cloud-only lazy island in server.ts, so desktop
  // answered 404 until it was mounted here. It reads workspace files straight
  // from disk when not running in Kubernetes.
  app.route('/api/projects', projectExportImportRoutes())
  app.route('/api', projectChatRoutes({ runtimeManager }))
  app.route('/api', workspaceChatRoutes({ resolveUserId: getAuthUserId, runtimeManager }))
  app.route('/api', workspaceAgentRoutes({ authorize: sessionAuthorize(getAuthUserId) }))
  app.route('/api', workspaceMeetingRoutes({ authorize: sessionAuthorize(getAuthUserId) }))
  app.route('/api', sharedMeetingRoutes())
  const scriptedChannelAgents = scriptedAgentInvokeFromEnv()
  configureConversationAgentDispatcher({ runtimeManager, ...(scriptedChannelAgents ? { invoke: scriptedChannelAgents } : {}) })
  // One process writes every reply here, so any placeholder still marked running was cut off by a restart.
  void settleOrphanedAgentReplies().catch((err) => console.warn('[Channels] could not settle interrupted replies:', err?.message ?? err))
  app.route('/api', conversationRoutes({ resolveUserId: getAuthUserId }))
  app.post('/api/webhooks/livekit', async (c) => {
    const { handleLiveKitWebhook } = await import('../services/huddle.service')
    const result = await handleLiveKitWebhook({ rawBody: await c.req.text(), authorization: c.req.header('authorization') })
    return c.json(result.body, result.status)
  })
  app.route('/api', createAgentTaskRoutes({ runtimeManager }))
  app.route('/api', historyRoutes({ resolveUserId: getAuthUserId }))
  app.route('/api', diagnosticsRoutes({ workspacesDir }))
  app.route('/api', testsRoutes({ workspacesDir }))
  app.route('/api', securityRoutes({ workspacesDir }))
  app.route('/api', databaseRoutes({ workspacesDir }))
  app.route('/api', checkpointRoutes({ workspacesDir }))
  app.route('/api', projectAuthConfigRoutes())
  app.route('/api', aiProxyRoutes())
  app.route('/api', aiLiveRoutes())
  app.route('/api', voiceRoutes())
  app.route('/api', rbacRoutes())
  app.route('/api', chatRoutes())
  app.route('/api', toolsProxyRoutes())
  app.route('/api', techStackRoutes())
  app.route('/api', apiKeyRoutes())
  // Settings > Integrations is shown on desktop; the routes forward to cloud
  // when SHOGO_API_KEY is set.
  app.route('/api', integrationRoutes())
  // `marketplaceRoutes()` already branches on `SHOGO_LOCAL_MODE` internally
  // (reads served from the local DB, writes proxied to Shogo Cloud when a
  // key is connected) — it just wasn't mounted here, so every
  // `/api/marketplace/*` call 404'd in local/desktop mode even though the
  // sidebar always shows the Marketplace nav item.
  app.route('/api/marketplace', marketplaceRoutes())
  app.route('/api/v1', appActionsRoutes())
  app.route('/api/chat-messages', createChatMessageEditRoutes())
  app.route('/api/chat-queued-messages', chatQueuedMessageActionsRoutes())
  app.route('/api/chat-messages', createChatMessageFeedbackRoutes())
  app.route('/api/chat-sessions', createChatSessionFeedbackRoutes())
  app.route('/api/chat-sessions', createChatSessionForkRoutes())
  app.use('/api/projects', attachProjectPermissions)
  app.use('/api/projects/:id', attachProjectPermissions)
  app.route('/api', createLocalGeneratedRoutes(prisma as any))

  return {
    app,
    runtimeManager,
    workspacesDir,
    resetCaches() {
      _resetAgentModelDefaultsCache()
      _resetUpstreamCredentialCache()
    },
  }
}
