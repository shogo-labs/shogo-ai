// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Workspace-level Slack Agent integration.
 *
 * Slack owns one app installation per workspace. This route is the base-agent
 * ingress: it authenticates Slack, maps a Slack user to a Shogo user, and
 * forwards the turn through the workspace-chat proxy. The runtime starts with
 * no project mounted; the meta-agent mounts only the projects it needs.
 */

import { createHash, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { encryptSecret, decryptSecret, isSecretCryptoConfigured } from '../lib/secret-crypto'
import { getFrontendUrl } from '../lib/cloud-urls'
import { resolveWorkspaceRuntimeUrl } from '../lib/resolve-workspace-runtime-url'
import { deriveWorkspaceRuntimeToken } from '../lib/workspace-runtime-token'
import type { IRuntimeManager } from '../lib/runtime'
import { workspaceChatRoutes } from './workspace-chat'
import {
  parseSlackMessage,
  normalizeSlackMessageEvent,
  resolveSlackThreadTs,
  isSlackDirectMessageChannel,
  type SlackRoutableProject,
} from '../lib/slack-agent/router'
import {
  createSlackOAuthState,
  verifySlackOAuthState,
  verifySlackSignature,
} from '../lib/slack-agent/security'
import { SlackUiWriter, type SlackApiClient } from '../lib/slack-agent/stream'

const SLACK_API = 'https://slack.com/api'
const EVENT_TTL_MS = 10 * 60 * 1000
const seenEvents = new Map<string, number>()

interface SlackAgentRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
  runtimeManager?: IRuntimeManager
  publicApiUrl?: string
}

interface SlackEventPayload {
  type?: string
  token?: string
  challenge?: string
  team_id?: string
  event_id?: string
  event?: Record<string, any>
}

interface SlackMessageEvent {
  type: 'message' | 'app_mention'
  text?: string
  user?: string
  channel?: string
  ts?: string
  thread_ts?: string
  subtype?: string
  bot_id?: string
}

interface SlackInstallationRecord {
  id: string
  workspaceId: string
  slackTeamId: string
  slackTeamName: string | null
  botAccessTokenEncrypted: string
  botUserId: string | null
  defaultProjectId: string | null
}

export function slackAgentRoutes(config: SlackAgentRoutesConfig): Hono {
  const router = new Hono()
  const workspaceChatRouter = workspaceChatRoutes({
    runtimeManager: config.runtimeManager,
    alwaysEnabled: true,
    resolveUserId: async (c) => c.req.header('X-Shogo-Slack-User-Id') || null,
  })
  const signingSecret = () => process.env.SLACK_SIGNING_SECRET
  const stateSecret = () => process.env.BETTER_AUTH_SECRET || process.env.SLACK_SIGNING_SECRET || ''
  const publicApiUrl = () =>
    (config.publicApiUrl || process.env.SHOGO_PUBLIC_API_URL || process.env.BETTER_AUTH_URL || 'http://localhost:8002')
      .replace(/\/+$/, '')
  const redirectUri = () =>
    process.env.SLACK_REDIRECT_URI || `${publicApiUrl()}/api/integrations/slack/callback`

  // -------------------------------------------------------------------------
  // Workspace OAuth installation and per-user account linking
  // -------------------------------------------------------------------------

  router.get('/integrations/slack/install', async (c) => {
    if (!process.env.SLACK_CLIENT_ID || !stateSecret()) {
      return c.json({ error: 'Slack OAuth is not configured' }, 503)
    }
    const userId = await config.resolveUserId(c)
    const workspaceId = c.req.query('workspaceId')
    if (!userId || !workspaceId) return c.json({ error: 'workspaceId and authentication are required' }, 401)

    const membership = await prisma.member.findFirst({
      where: { userId, workspaceId, role: { in: ['owner', 'admin'] } },
      select: { id: true },
    })
    if (!membership) return c.json({ error: 'Workspace owner or admin access is required' }, 403)

    const state = createSlackOAuthState({ mode: 'install', workspaceId, userId }, stateSecret())
    const params = new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      scope: slackBotScopes().join(','),
      redirect_uri: redirectUri(),
      state,
    })
    return c.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`)
  })

  router.get('/integrations/slack/callback', async (c) => {
    const state = c.req.query('state') || ''
    const parsedState = verifySlackOAuthState(state, stateSecret())
    if (!parsedState || parsedState.mode !== 'install' || !parsedState.workspaceId || !parsedState.userId) {
      return c.json({ error: 'Invalid or expired Slack OAuth state' }, 400)
    }
    if (c.req.query('error')) {
      return c.json({ error: c.req.query('error_description') || c.req.query('error') }, 400)
    }
    const code = c.req.query('code')
    if (!code || !process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
      return c.json({ error: 'Slack OAuth code or configuration is missing' }, 400)
    }
    if (!isSecretCryptoConfigured()) {
      return c.json({ error: 'SECRETS_ENCRYPTION_KEY is required before installing Slack' }, 503)
    }

    const membership = await prisma.member.findFirst({
      where: { userId: parsedState.userId, workspaceId: parsedState.workspaceId, role: { in: ['owner', 'admin'] } },
      select: { id: true },
    })
    if (!membership) return c.json({ error: 'Workspace access changed during OAuth' }, 403)

    const response = await fetch(`${SLACK_API}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri(),
      }),
    })
    const oauth = await response.json() as any
    if (!response.ok || !oauth.ok || !oauth.access_token || !oauth.team?.id) {
      return c.json({ error: oauth.error || 'Slack OAuth exchange failed' }, 502)
    }

    const existing = await prisma.slackWorkspaceInstallation.findUnique({
      where: { slackTeamId: oauth.team.id },
      select: { workspaceId: true },
    })
    if (existing && existing.workspaceId !== parsedState.workspaceId) {
      return c.json({ error: 'This Slack workspace is already linked to another Shogo workspace' }, 409)
    }

    await prisma.slackWorkspaceInstallation.upsert({
      where: { slackTeamId: oauth.team.id },
      create: {
        workspaceId: parsedState.workspaceId,
        slackTeamId: oauth.team.id,
        slackTeamName: oauth.team.name || null,
        botAccessTokenEncrypted: encryptSecret(oauth.access_token),
        botUserId: oauth.bot_user_id || null,
        installerUserId: oauth.authed_user?.id || parsedState.userId,
      },
      update: {
        slackTeamName: oauth.team.name || null,
        botAccessTokenEncrypted: encryptSecret(oauth.access_token),
        botUserId: oauth.bot_user_id || null,
        installerUserId: oauth.authed_user?.id || parsedState.userId,
      },
    })

    return c.html(`
      <!doctype html><html><head><title>Shogo connected</title></head>
      <body><h1>Shogo is connected to Slack</h1>
      <p>You can close this window and return to Shogo.</p></body></html>
    `)
  })

  router.get('/integrations/slack/link', async (c) => {
    const state = c.req.query('state') || ''
    const parsedState = verifySlackOAuthState(state, stateSecret())
    if (!parsedState || parsedState.mode !== 'link' || !parsedState.slackTeamId || !parsedState.slackUserId) {
      return c.json({ error: 'Invalid or expired Slack link state' }, 400)
    }

    // NOTE: this endpoint is called from the `/auth/slack-link` frontend
    // bridge page (apps/mobile/app/auth/slack-link.tsx) via an authenticated
    // fetch — NOT by the browser navigating here directly. It used to be a
    // direct-navigation target with a `redirect(getFrontendUrl()/sign-in)`
    // fallback, but the Slack button URL is necessarily on the API's public
    // host (so Slack can open it from any device), which is a *different
    // browser cookie domain* than wherever the user is actually signed in
    // locally (e.g. `localhost` vs an ngrok tunnel host) — so that redirect
    // could never actually carry a session back here. The bridge page
    // sidesteps this entirely by doing the authenticated call from the
    // frontend's own origin instead of the browser navigating to this host.
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)
    const installation = await prisma.slackWorkspaceInstallation.findUnique({
      where: { slackTeamId: parsedState.slackTeamId },
    })
    if (!installation) return c.json({ error: 'Slack workspace is not installed in Shogo' }, 404)

    const member = await prisma.member.findFirst({
      where: { userId, workspaceId: installation.workspaceId },
      select: { id: true },
    })
    if (!member) return c.json({ error: 'You are not a member of this Shogo workspace' }, 403)

    await prisma.slackUserLink.upsert({
      where: {
        slackTeamId_slackUserId: {
          slackTeamId: parsedState.slackTeamId,
          slackUserId: parsedState.slackUserId,
        },
      },
      create: {
        slackTeamId: parsedState.slackTeamId,
        slackUserId: parsedState.slackUserId,
        shogoUserId: userId,
      },
      update: { shogoUserId: userId },
    })

    // Confirm the link in Slack and resume whatever request triggered it,
    // instead of making the user notice the DM and repeat themselves. Both
    // happen after the HTTP response below is prepared, but we kick them off
    // (not `await`) so the browser tab closes/redirects promptly rather than
    // waiting on a full agent turn.
    if (parsedState.pendingChannel) {
      const client = slackClient(installation)
      const threadOpts = parsedState.pendingThreadTs ? { thread_ts: parsedState.pendingThreadTs } : {}
      void client.call('chat.postMessage', {
        channel: parsedState.pendingChannel,
        ...threadOpts,
        text: parsedState.pendingText
          ? '✅ Your Shogo account is linked. Resuming your request…'
          : '✅ Your Shogo account is linked. Send your request again.',
      }).catch((error) => {
        console.error('[SlackAgent] Failed to post link confirmation:', error)
      })

      if (parsedState.pendingText) {
        const resumedMessage: SlackMessageEvent = {
          type: 'message',
          text: parsedState.pendingText,
          user: parsedState.slackUserId,
          channel: parsedState.pendingChannel,
          ts: parsedState.pendingTs || randomUUID(),
          thread_ts: parsedState.pendingThreadTs,
        }
        void dispatchSlackMessage(c, installation, resumedMessage, userId, client).catch((error) => {
          console.error('[SlackAgent] Failed to resume request after account link:', error)
        })
      }
    }

    return c.json({ ok: true, resumed: !!parsedState.pendingText })
  })

  // -------------------------------------------------------------------------
  // Slack Events API and interactivity
  // -------------------------------------------------------------------------

  router.post('/integrations/slack/events', async (c) => {
    const rawBody = await c.req.text()
    if (!verifyInboundRequest(c, rawBody, signingSecret())) {
      return c.json({ error: 'Invalid Slack signature' }, 401)
    }

    let payload: SlackEventPayload
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }
    if (payload.type === 'url_verification' && payload.challenge) {
      return c.json({ challenge: payload.challenge })
    }

    if (payload.event_id && isDuplicate(payload.event_id)) {
      return c.json({ ok: true, duplicate: true })
    }
    if (!payload.team_id || !payload.event) return c.json({ ok: true })

    const installation = await prisma.slackWorkspaceInstallation.findUnique({
      where: { slackTeamId: payload.team_id },
    })
    if (!installation) return c.json({ error: 'Slack workspace is not installed in Shogo' }, 404)

    // Slack requires a quick acknowledgement. The project runtime can cold
    // start and an agent turn can run for hours, so all work happens after the
    // acknowledgement.
    void processEvent(c, installation, payload.event).catch((error) => {
      console.error('[SlackAgent] Event processing failed:', error)
    })
    return c.json({ ok: true })
  })

  router.post('/integrations/slack/interactions', async (c) => {
    const rawBody = await c.req.text()
    if (!verifyInboundRequest(c, rawBody, signingSecret())) {
      return c.json({ error: 'Invalid Slack signature' }, 401)
    }
    const form = new URLSearchParams(rawBody)
    const payloadText = form.get('payload')
    if (!payloadText) return c.json({ error: 'payload is required' }, 400)

    let payload: any
    try {
      payload = JSON.parse(payloadText)
    } catch {
      return c.json({ error: 'Invalid interaction payload' }, 400)
    }
    const teamId = payload.team?.id
    const installation = teamId
      ? await prisma.slackWorkspaceInstallation.findUnique({ where: { slackTeamId: teamId } })
      : null
    if (!installation) return c.json({ error: 'Slack workspace is not installed in Shogo' }, 404)

    void processInteraction(c, installation, payload).catch((error) => {
      console.error('[SlackAgent] Interaction processing failed:', error)
    })
    return c.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Dashboard settings API
  // -------------------------------------------------------------------------

  router.get('/integrations/slack/workspaces/:workspaceId', async (c) => {
    const userId = await config.resolveUserId(c)
    const workspaceId = c.req.param('workspaceId')
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)
    if (!(await hasWorkspaceMembership(userId, workspaceId))) return c.json({ error: 'Forbidden' }, 403)

    const installation = await prisma.slackWorkspaceInstallation.findUnique({
      where: { workspaceId },
      select: {
        slackTeamId: true,
        slackTeamName: true,
        botUserId: true,
        defaultProjectId: true,
        createdAt: true,
      },
    })
    const projects = await getAccessibleProjects(workspaceId, userId, false)
    return c.json({
      installed: !!installation,
      installation,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        slackEnabled: project.slackEnabled,
        createdBy: project.createdBy,
      })),
    })
  })

  router.patch('/integrations/slack/workspaces/:workspaceId', async (c) => {
    const userId = await config.resolveUserId(c)
    const workspaceId = c.req.param('workspaceId')
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)
    if (!(await isWorkspaceAdmin(userId, workspaceId))) return c.json({ error: 'Workspace admin access is required' }, 403)
    const installation = await prisma.slackWorkspaceInstallation.findUnique({ where: { workspaceId } })
    if (!installation) return c.json({ error: 'Slack is not installed for this workspace' }, 404)
    const body = await c.req.json().catch(() => ({} as any))
    if (body.defaultProjectId !== undefined) {
      if (body.defaultProjectId !== null) {
        const project = await prisma.project.findFirst({
          where: { id: body.defaultProjectId, workspaceId, slackEnabled: true },
          select: { id: true },
        })
        if (!project) return c.json({ error: 'defaultProjectId must be an enabled project in this workspace' }, 400)
      }
      await prisma.slackWorkspaceInstallation.update({
        where: { workspaceId },
        data: { defaultProjectId: body.defaultProjectId },
      })
    }
    return c.json({ ok: true })
  })

  router.patch('/integrations/slack/workspaces/:workspaceId/projects/:projectId', async (c) => {
    const userId = await config.resolveUserId(c)
    const workspaceId = c.req.param('workspaceId')
    const projectId = c.req.param('projectId')
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)
    if (!(await isWorkspaceAdmin(userId, workspaceId))) return c.json({ error: 'Workspace admin access is required' }, 403)
    const body = await c.req.json().catch(() => ({} as any))
    if (typeof body.slackEnabled !== 'boolean') return c.json({ error: 'slackEnabled must be a boolean' }, 400)
    const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } })
    if (!project) return c.json({ error: 'Project not found' }, 404)
    await prisma.project.update({ where: { id: projectId }, data: { slackEnabled: body.slackEnabled } })
    return c.json({ ok: true, projectId, slackEnabled: body.slackEnabled })
  })

  // Bulk variant of the endpoint above — lets the "Manage projects" UI apply
  // "Enable all" / "Disable all" over a (possibly search-filtered) set of
  // project ids in one round trip instead of one request per project.
  router.patch('/integrations/slack/workspaces/:workspaceId/projects', async (c) => {
    const userId = await config.resolveUserId(c)
    const workspaceId = c.req.param('workspaceId')
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)
    if (!(await isWorkspaceAdmin(userId, workspaceId))) return c.json({ error: 'Workspace admin access is required' }, 403)
    const body = await c.req.json().catch(() => ({} as any))
    if (typeof body.slackEnabled !== 'boolean') return c.json({ error: 'slackEnabled must be a boolean' }, 400)
    if (!Array.isArray(body.projectIds) || body.projectIds.some((id: unknown) => typeof id !== 'string')) {
      return c.json({ error: 'projectIds must be an array of strings' }, 400)
    }
    const projectIds: string[] = body.projectIds.slice(0, 5000)
    if (projectIds.length === 0) return c.json({ ok: true, updated: 0 })
    const result = await prisma.project.updateMany({
      where: { id: { in: projectIds }, workspaceId },
      data: { slackEnabled: body.slackEnabled },
    })
    return c.json({ ok: true, updated: result.count, slackEnabled: body.slackEnabled })
  })

  router.get('/integrations/slack/workspaces/:workspaceId/routing-rules', async (c) => {
    const userId = await config.resolveUserId(c)
    const workspaceId = c.req.param('workspaceId')
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)
    if (!(await hasWorkspaceMembership(userId, workspaceId))) return c.json({ error: 'Forbidden' }, 403)
    const installation = await prisma.slackWorkspaceInstallation.findUnique({
      where: { workspaceId },
      select: { slackTeamId: true },
    })
    if (!installation) return c.json({ rules: [] })
    const rules = await prisma.slackProjectRoutingRule.findMany({
      where: { slackTeamId: installation.slackTeamId },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { keyword: 'asc' },
    })
    return c.json({ rules })
  })

  router.post('/integrations/slack/workspaces/:workspaceId/routing-rules', async (c) => {
    const userId = await config.resolveUserId(c)
    const workspaceId = c.req.param('workspaceId')
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)
    if (!(await isWorkspaceAdmin(userId, workspaceId))) return c.json({ error: 'Workspace admin access is required' }, 403)
    const installation = await prisma.slackWorkspaceInstallation.findUnique({ where: { workspaceId } })
    if (!installation) return c.json({ error: 'Slack is not installed for this workspace' }, 404)
    const body = await c.req.json().catch(() => ({} as any))
    const keyword = typeof body.keyword === 'string' ? body.keyword.trim().toLocaleLowerCase() : ''
    if (!keyword || keyword.length > 80 || !/^[\w./-]+$/i.test(keyword)) {
      return c.json({ error: 'keyword must be 1-80 letters, numbers, dots, slashes, or hyphens' }, 400)
    }
    const project = await prisma.project.findFirst({
      where: { id: body.projectId, workspaceId, slackEnabled: true },
      select: { id: true },
    })
    if (!project) return c.json({ error: 'projectId must be an enabled project in this workspace' }, 400)
    const rule = await prisma.slackProjectRoutingRule.upsert({
      where: {
        slackTeamId_keyword: { slackTeamId: installation.slackTeamId, keyword },
      },
      create: { slackTeamId: installation.slackTeamId, keyword, projectId: project.id },
      update: { projectId: project.id },
      include: { project: { select: { id: true, name: true } } },
    })
    return c.json({ rule }, 201)
  })

  router.delete('/integrations/slack/workspaces/:workspaceId/routing-rules/:ruleId', async (c) => {
    const userId = await config.resolveUserId(c)
    const workspaceId = c.req.param('workspaceId')
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)
    if (!(await isWorkspaceAdmin(userId, workspaceId))) return c.json({ error: 'Workspace admin access is required' }, 403)
    const installation = await prisma.slackWorkspaceInstallation.findUnique({ where: { workspaceId }, select: { slackTeamId: true } })
    if (!installation) return c.json({ error: 'Slack is not installed for this workspace' }, 404)
    await prisma.slackProjectRoutingRule.deleteMany({
      where: { id: c.req.param('ruleId'), slackTeamId: installation.slackTeamId },
    })
    return c.json({ ok: true })
  })

  async function processEvent(
    c: any,
    installation: SlackInstallationRecord,
    event: Record<string, any>,
  ): Promise<void> {
    if (event.type === 'app_home_opened') {
      if (event.tab === 'messages' && event.user && event.channel) {
        await sendSuggestedPrompts(installation, event.user, event.channel)
      }
      // Hide the workspace-runtime cold start behind the time the user spends
      // opening Slack and composing their first message. This is intentionally
      // zero-member: project source is mounted only when the meta-agent needs
      // it.
      void resolveWorkspaceRuntimeUrl(installation.workspaceId, {
        attachedProjectIds: [],
        runtimeManager: config.runtimeManager,
        alwaysEnabled: true,
        logTag: 'SlackPrewarm',
      }).catch((error) => {
        console.warn('[SlackAgent] Workspace prewarm failed:', error?.message ?? error)
      })
      return
    }
    if (event.type === 'app_context_changed') return
    if (event.type === 'agent_session_stopped') {
      await stopSlackSession(c, installation, event)
      return
    }

    const normalized = normalizeSlackMessageEvent(event, installation.botUserId)
    if (!normalized) return
    const message = {
      ...(event as SlackMessageEvent),
      text: normalized.text,
      user: normalized.senderId,
      channel: normalized.channelId,
    } as SlackMessageEvent

    const client = slackClient(installation)
    const link = await prisma.slackUserLink.findUnique({
      where: {
        slackTeamId_slackUserId: {
          slackTeamId: installation.slackTeamId,
          slackUserId: normalized.senderId,
        },
      },
    })
    if (!link) {
      await sendAccountLinkPrompt(installation, message)
      return
    }

    await dispatchSlackMessage(c, installation, message, link.shogoUserId, client)
  }

  async function processInteraction(c: any, installation: SlackInstallationRecord, payload: any): Promise<void> {
    const action = payload.actions?.[0]
    const userId = payload.user?.id
    const channelId = payload.channel?.id || payload.container?.channel_id
    if (!action || !userId) return

    if (action.action_id?.startsWith('slack_project_picker')) {
      const link = await prisma.slackUserLink.findUnique({
        where: { slackTeamId_slackUserId: { slackTeamId: installation.slackTeamId, slackUserId: userId } },
      })
      if (!link || !channelId) return
      const original = payload.message || {}
      const message: SlackMessageEvent = {
        type: 'app_mention',
        text: `${original.text || ''} project=${action.value}`,
        user: userId,
        channel: channelId,
        ts: original.ts || randomUUID(),
        thread_ts: original.thread_ts,
      }
      await dispatchSlackMessage(c, installation, message, link.shogoUserId, slackClient(installation))
      return
    }

    if (action.action_id === 'slack_personal_default') {
      const link = await prisma.slackUserLink.findUnique({
        where: { slackTeamId_slackUserId: { slackTeamId: installation.slackTeamId, slackUserId: userId } },
      })
      if (!link) return
      const projects = await getAccessibleProjects(installation.workspaceId, link.shogoUserId, true)
      if (action.value !== 'none' && !projects.some((project) => project.id === action.value)) return
      await prisma.slackUserLink.update({
        where: { id: link.id },
        data: { personalDefaultProjectId: action.value === 'none' ? null : action.value },
      })
      if (channelId) await postMessage(installation, channelId, 'Your personal Shogo project default was updated.')
      return
    }

    if (action.action_id === 'slack_channel_default') {
      const link = await prisma.slackUserLink.findUnique({
        where: { slackTeamId_slackUserId: { slackTeamId: installation.slackTeamId, slackUserId: userId } },
      })
      if (!link || !channelId || !(await isWorkspaceAdmin(link.shogoUserId, installation.workspaceId))) return
      const projects = await getAccessibleProjects(installation.workspaceId, link.shogoUserId, true)
      if (action.value !== 'none' && !projects.some((project) => project.id === action.value)) return
      await prisma.slackChannelSettings.upsert({
        where: { slackTeamId_slackChannelId: { slackTeamId: installation.slackTeamId, slackChannelId: channelId } },
        create: {
          slackTeamId: installation.slackTeamId,
          slackChannelId: channelId,
          defaultProjectId: action.value === 'none' ? null : action.value,
        },
        update: { defaultProjectId: action.value === 'none' ? null : action.value },
      })
      await postMessage(installation, channelId, 'The channel’s Shogo project default was updated.')
      return
    }

    if (action.action_id === 'slack_feedback') {
      console.log('[SlackAgent] Feedback', {
        teamId: installation.slackTeamId,
        userId,
        value: action.value,
        messageTs: payload.message?.ts,
      })
      return
    }

    if (action.action_id === 'slack_stop') {
      await stopSlackSession(c, installation, {
        user: userId,
        channel: channelId,
        thread_ts: payload.message?.thread_ts || payload.container?.thread_ts,
      })
    }
  }

  async function dispatchSlackMessage(
    c: any,
    installation: SlackInstallationRecord,
    message: SlackMessageEvent,
    shogoUserId: string,
    client: SlackApiClient,
  ): Promise<void> {
    const text = cleanSlackText(message.text || '', installation.botUserId)
    const parsed = parseSlackMessage(text)
    const channelId = message.channel!
    const isDm = isSlackDirectMessageChannel(channelId)
    // `parsed.command.type === 'agent' || parsed.command.forceNew` narrows
    // away the `'agent'` variant by the time `.forceNew` is evaluated (it's
    // only known-true there via short-circuiting), so TS can't see
    // `forceNew` on the remaining union — spell out both cases instead.
    const forceNew =
      parsed.command.type === 'agent' ||
      (parsed.command.type === 'prompt' && parsed.command.forceNew)
    // Quick utility replies (settings, project list, nudge for empty text)
    // aren't part of an ongoing agent session, so they don't need DM thread
    // continuity — just anchor to whatever thread triggered them.
    const utilityThreadTs = message.thread_ts || message.ts || randomUUID()

    if (parsed.command.type === 'settings') {
      await sendSettings(installation, message, shogoUserId)
      return
    }
    if (parsed.command.type === 'list_projects') {
      await sendProjectList(installation, channelId, utilityThreadTs, shogoUserId)
      return
    }
    if (parsed.command.type === 'empty') {
      await postMessage(installation, channelId, 'Tell me what you want to do, or use `@Shogo settings` to choose a project.')
      return
    }

    const link = await prisma.slackUserLink.findUnique({
      where: { slackTeamId_slackUserId: { slackTeamId: installation.slackTeamId, slackUserId: message.user! } },
    })

    const threadTs = resolveSlackThreadTs({
      channelId,
      messageThreadTs: message.thread_ts,
      fallbackTs: message.ts || randomUUID(),
      forceNew,
      activeDmChannelId: link?.activeDmChannelId,
      activeDmThreadTs: link?.activeDmThreadTs,
    })

    await client.call('agents.sessions.setStatus', {
      channel_id: channelId,
      thread_ts: threadTs,
      status: 'processing',
    }).catch(() => {})
    // `agents.sessions.setStatus` above drives the modern Agent-view loading
    // UX (stop button, session lifecycle) but Slack's own docs are explicit
    // that it renders fixed, generic copy only — no custom text. The
    // branded "Shogo is thinking..." shimmer with rotating flavor text
    // comes from the legacy `assistant.threads.setStatus` method, which
    // Slack still serves through a compatibility bridge for exactly this.
    // `SlackStreamWriter` takes over updating this once tool calls start
    // streaming in (see `setThreadStatus` in stream.ts) and clears it when
    // the turn finishes. Best-effort — older workspaces/scopes must not
    // block the actual response.
    await client.call('assistant.threads.setStatus', {
      channel_id: channelId,
      thread_ts: threadTs,
      status: 'is thinking...',
      loading_messages: [
        'Reading the codebase…',
        'Loading project context…',
        'Warming up the agent…',
        'Checking recent activity…',
      ],
    }).catch(() => {})

    const sessionId = forceNew
      ? createSlackSessionId(installation.slackTeamId, channelId, `${threadTs}:${message.ts || randomUUID()}`, 'workspace')
      : createSlackSessionId(installation.slackTeamId, channelId, threadTs, 'workspace')
    await ensureSlackWorkspaceChatSession(
      sessionId,
      installation.workspaceId,
      forceNew ? parsed.command.prompt : undefined,
    )
    const accessible = await getAccessibleProjects(installation.workspaceId, shogoUserId, false)
    const explicitProjectSelector = parsed.projectSelector || parsed.options.repo
    const normalizedSelector = explicitProjectSelector?.trim().toLocaleLowerCase()
    let hintedProject = normalizedSelector
      ? accessible.find(
          (project) =>
            project.id.toLocaleLowerCase() === normalizedSelector ||
            project.name.trim().toLocaleLowerCase() === normalizedSelector,
        )
      : undefined

    if (!hintedProject) {
      const [channelSettings, rules] = await Promise.all([
        prisma.slackChannelSettings.findUnique({
          where: {
            slackTeamId_slackChannelId: {
              slackTeamId: installation.slackTeamId,
              slackChannelId: channelId,
            },
          },
        }),
        prisma.slackProjectRoutingRule.findMany({
          where: { slackTeamId: installation.slackTeamId },
          select: { keyword: true, projectId: true },
        }),
      ])
      const matchingRuleProjectIds = [
        ...new Set(
          rules
            .filter((rule) => rule.keyword && text.toLocaleLowerCase().includes(rule.keyword.toLocaleLowerCase()))
            .map((rule) => rule.projectId),
        ),
      ]
      if (matchingRuleProjectIds.length === 1) {
        hintedProject = accessible.find((project) => project.id === matchingRuleProjectIds[0])
      }
      const defaultProjectId =
        channelSettings?.defaultProjectId ||
        link?.personalDefaultProjectId ||
        installation.defaultProjectId
      if (!hintedProject && defaultProjectId) {
        hintedProject = accessible.find((project) => project.id === defaultProjectId)
      }
    }

    if (hintedProject) {
      const attachResponse = await fetch(
        `${publicApiUrl()}/api/internal/workspaces/${encodeURIComponent(installation.workspaceId)}/sessions/${encodeURIComponent(sessionId)}/members`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-runtime-token': deriveWorkspaceRuntimeToken(installation.workspaceId),
          },
          body: JSON.stringify({
            projectId: hintedProject.id,
            attachMode: 'readwrite',
            userId: shogoUserId,
            sessionId,
          }),
        },
      )
      if (!attachResponse.ok) {
        console.warn('[SlackAgent] Project pre-mount failed:', await attachResponse.text().catch(() => ''))
      } else if (link) {
        await prisma.slackUserLink.update({
          where: { id: link.id },
          data: { lastUsedProjectId: hintedProject.id },
        }).catch(() => {})
      }
    }
    await prisma.slackUserLink.update({
      where: { id: link!.id },
      data: {
        // Only update the "default" continuation thread when we're the ones
        // who chose it (a plain top-level DM message) — an explicit
        // Slack reply-in-thread is a deliberate one-off branch and
        // shouldn't hijack where future plain messages land.
        ...(isDm && !message.thread_ts ? { activeDmChannelId: channelId, activeDmThreadTs: threadTs } : {}),
      },
    })

    if (!forceNew && message.thread_ts) {
      // Thread history is read just-in-time and sent to the project agent; it
      // is not retained as a separate Slack integration cache.
      const history = await loadThreadMessages(client, channelId, message.thread_ts, installation.botUserId, message.ts)
      void runWorkspaceTurn({
        installation,
        client,
        workspaceChatRouter,
        sessionId,
        channelId,
        threadTs,
        prompt: parsed.command.type === 'agent' || parsed.command.type === 'prompt'
          ? parsed.command.prompt
          : text,
        history,
        shogoUserId,
          slackUserId: message.user!,
          model: parsed.options.model,
        isFirstTurn: !(await prisma.chatMessage.findFirst({ where: { sessionId }, select: { id: true } })),
      }).catch((error) => {
        console.error('[SlackAgent] Workspace turn failed:', error)
      })
      return
    }

    void runWorkspaceTurn({
      installation,
      client,
      workspaceChatRouter,
      sessionId,
      channelId,
      threadTs,
      prompt: parsed.command.type === 'agent' || parsed.command.type === 'prompt' ? parsed.command.prompt : text,
      history: [],
      shogoUserId,
      slackUserId: message.user!,
      model: parsed.options.model,
      isFirstTurn: !(await prisma.chatMessage.findFirst({ where: { sessionId }, select: { id: true } })),
    }).catch((error) => {
      console.error('[SlackAgent] Workspace turn failed:', error)
    })
  }

  async function runWorkspaceTurn(args: {
    installation: SlackInstallationRecord
    client: SlackApiClient
    workspaceChatRouter: Hono
    sessionId: string
    channelId: string
    threadTs: string
    prompt: string
    history: Array<{ role: 'user' | 'assistant'; text: string }>
    shogoUserId: string
    slackUserId: string
    model?: string
    isFirstTurn: boolean
  }): Promise<void> {
    const { installation, client, workspaceChatRouter, sessionId, channelId, threadTs, prompt, history, shogoUserId, slackUserId, model, isFirstTurn } = args
    const messages = [
      ...history.map((item) => ({
        role: item.role,
        parts: [{ type: 'text', text: item.text }],
      })),
      { role: 'user', parts: [{ type: 'text', text: prompt }] },
    ]
    const headers = new Headers({
      'Content-Type': 'application/json',
      'X-Chat-Session-Id': sessionId,
      'X-Shogo-Slack-User-Id': shogoUserId,
    })
    const response = await workspaceChatRouter.fetch(new Request(
      `http://slack.local/workspaces/${encodeURIComponent(installation.workspaceId)}/chat`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages,
          chatSessionId: sessionId,
          userId: shogoUserId,
          ...(model ? { agentMode: model } : {}),
        }),
      },
    ))

    const writer = new SlackUiWriter({
      client,
      channelId,
      threadTs,
      recipientUserId: slackUserId,
      recipientTeamId: installation.slackTeamId,
    })
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      await writer.fail(`I could not run the Shogo workspace agent: ${detail.slice(0, 300) || `HTTP ${response.status}`}`)
      await client.call('agents.sessions.setStatus', {
        channel_id: channelId,
        thread_ts: threadTs,
        status: 'suspended',
      })
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(line.startsWith('data: ') ? 6 : 5).trim()
          if (!raw || raw === '[DONE]') continue
          try {
            await writer.write(JSON.parse(raw))
          } catch (error) {
            console.warn('[SlackAgent] Could not translate stream chunk:', error)
          }
        }
      }
      if (buffer.startsWith('data:')) {
        const raw = buffer.slice(buffer.startsWith('data: ') ? 6 : 5).trim()
        if (raw && raw !== '[DONE]') await writer.write(JSON.parse(raw))
      }
      await writer.stop()
      await client.call('agents.sessions.setStatus', {
        channel_id: channelId,
        thread_ts: threadTs,
        status: 'active',
      })
      if (isFirstTurn) {
        await client.call('agents.sessions.rename', {
          channel_id: channelId,
          thread_ts: threadTs,
          title: `Shogo: ${prompt.slice(0, 70)}`,
        }).catch(() => {})
      }
    } catch (error: any) {
      await writer.fail(`The Shogo agent stopped unexpectedly: ${error?.message || 'unknown error'}`).catch(() => {})
      await client.call('agents.sessions.setStatus', {
        channel_id: channelId,
        thread_ts: threadTs,
        status: 'suspended',
      }).catch(() => {})
    } finally {
      reader.releaseLock()
    }
  }

  async function stopSlackSession(c: any, installation: SlackInstallationRecord, event: any): Promise<void> {
    const channelId = event.channel || event.channel_id
    const threadTs = event.thread_ts || event.threadTs || event.session?.thread_ts
    const slackUserId = event.user || event.user_id
    if (!channelId || !threadTs) return

    const link = slackUserId
      ? await prisma.slackUserLink.findUnique({
          where: { slackTeamId_slackUserId: { slackTeamId: installation.slackTeamId, slackUserId } },
        })
      : null
    if (!link) return
    const sessionId = createSlackSessionId(installation.slackTeamId, channelId, threadTs, 'workspace')
    const response = await workspaceChatRouter.fetch(new Request(
      `http://slack.local/workspaces/${encodeURIComponent(installation.workspaceId)}/chat/stop`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chat-Session-Id': sessionId,
          'X-Shogo-Slack-User-Id': link.shogoUserId,
        },
        body: JSON.stringify({ chatSessionId: sessionId }),
      },
    ))
    if (response.ok) {
      await slackClient(installation).call('agents.sessions.setStatus', {
        channel_id: channelId,
        thread_ts: threadTs,
        status: 'active',
      }).catch(() => {})
    } else {
      console.warn('[SlackAgent] Workspace stop failed:', response.status, await response.text().catch(() => ''))
    }
  }

  async function sendSuggestedPrompts(installation: SlackInstallationRecord, slackUserId: string, channelId: string): Promise<void> {
    const link = await prisma.slackUserLink.findUnique({
      where: { slackTeamId_slackUserId: { slackTeamId: installation.slackTeamId, slackUserId } },
    })
    if (!link) {
      await sendAccountLinkPrompt(installation, { channel: channelId, user: slackUserId, ts: randomUUID() })
      return
    }
    const projects = await getAccessibleProjects(installation.workspaceId, link.shogoUserId, true)
    const prompts = projects.slice(0, 4).map((project) => ({
      title: `Ask about ${project.name}`,
      message: `@Shogo project="${project.name}" Help me understand the current state of this project.`,
    }))
    await slackClient(installation).call('assistant.threads.setSuggestedPrompts', {
      channel_id: channelId,
      prompts,
    }).catch(() => {})
  }

  async function sendAccountLinkPrompt(installation: SlackInstallationRecord, message: Partial<SlackMessageEvent>): Promise<void> {
    if (!message.channel || !message.user) return
    // Carry the original request through the OAuth round-trip (truncated —
    // Slack rejects button `url` values over ~3000 chars) so the callback
    // can resume it instead of making the user repeat themselves in Slack.
    const pendingText = (message.text || '').slice(0, 1500) || undefined
    const state = createSlackOAuthState({
      mode: 'link',
      slackTeamId: installation.slackTeamId,
      slackUserId: message.user,
      pendingChannel: message.channel,
      pendingThreadTs: message.thread_ts || message.ts,
      pendingTs: message.ts,
      pendingText,
    }, stateSecret())
    const client = slackClient(installation)
    let targetChannel = message.channel
    // Account-link URLs are bearer links. Keep them out of public channels by
    // moving the onboarding prompt to the requester's DM when possible.
    if (!isSlackDirectMessageChannel(targetChannel)) {
      const dm = await client.call('conversations.open', { users: message.user }).catch(() => null)
      if (dm?.ok && dm.channel?.id) targetChannel = dm.channel.id
    }
    await client.call('chat.postMessage', {
      channel: targetChannel,
      ...(targetChannel === message.channel && (message.thread_ts || message.ts)
        ? { thread_ts: message.thread_ts || message.ts }
        : {}),
      text: 'Link your Shogo account before starting an agent.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Link your Shogo account so I can use your project permissions and settings.' },
        },
        {
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: 'Link Shogo account' },
            // Points at the FRONTEND (not `publicApiUrl()`/the API's public
            // host) so the browser lands somewhere it can actually be
            // signed in: the API's public host (an ngrok tunnel in local
            // dev, or api.<domain> in prod) is a different cookie-origin
            // than wherever the user's Shogo session actually lives, so a
            // direct link to the API can never carry a session cookie back.
            // `/auth/slack-link` (apps/mobile/app/auth/slack-link.tsx) signs
            // the user in on the frontend's own origin if needed, then calls
            // the API itself via an authenticated same-origin-cookie fetch.
            url: `${getFrontendUrl()}/auth/slack-link?state=${encodeURIComponent(state)}`,
            action_id: 'slack_link_account',
          }],
        },
      ],
    })
  }

  async function sendProjectList(
    installation: SlackInstallationRecord,
    channelId: string,
    threadTs: string,
    shogoUserId: string,
  ): Promise<void> {
    const projects = await getAccessibleProjects(installation.workspaceId, shogoUserId, true)
    const text = projects.length
      ? `Slack-enabled Shogo projects:\n${projects.map((project) => `• *${project.name}* — \`project=${project.name}\``).join('\n')}`
      : 'You do not have any Slack-enabled Shogo projects in this workspace.'
    await slackClient(installation).call('chat.postMessage', {
      channel: channelId,
      thread_ts: threadTs,
      text,
    })
  }

  async function sendProjectPicker(
    installation: SlackInstallationRecord,
    channelId: string,
    threadTs: string,
    projects: SlackRoutableProject[],
  ): Promise<void> {
    if (projects.length === 0) {
      await postMessage(installation, channelId, 'No Slack-enabled projects are available to you. Ask a workspace admin to enable one in Shogo settings.', threadTs)
      return
    }
    const result = await slackClient(installation).call('chat.postMessage', {
      channel: channelId,
      thread_ts: threadTs,
      text: 'Which Shogo project should handle this request?',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'This request matches more than one enabled project. Choose one:' } },
        {
          type: 'actions',
          // Slack requires every interactive element's `action_id` to be
          // unique *within the whole message* — reusing the same id for
          // every button used to make Slack reject the message outright
          // with `invalid_blocks`. `client.call` only throws on HTTP-level
          // failures (see slackClient() below), not on Slack API-level
          // `ok:false` responses like this one, so the picker silently
          // failed to post with no trace: the "is thinking..." shimmer set
          // earlier would show, then get explicitly cleared by the
          // `assistant.threads.setStatus('')` call right after this
          // function returns, and the user would see nothing else at all.
          // `processInteraction`'s `slack_project_picker` handler already
          // reads the chosen project from `action.value`, not the id, so
          // appending an index here is purely to satisfy uniqueness.
          elements: projects.slice(0, 5).map((project, index) => ({
            type: 'button',
            text: { type: 'plain_text', text: project.name.slice(0, 75) },
            action_id: `slack_project_picker_${index}`,
            value: project.id,
          })),
        },
      ],
    })
    if (!result?.ok) {
      console.error('[SlackAgent] Failed to post project picker:', result?.error, result?.errors)
    }
  }

  async function sendSettings(installation: SlackInstallationRecord, message: SlackMessageEvent, shogoUserId: string): Promise<void> {
    if (!message.channel) return
    const projects = await getAccessibleProjects(installation.workspaceId, shogoUserId, true)
    const link = await prisma.slackUserLink.findUnique({
      where: { slackTeamId_slackUserId: { slackTeamId: installation.slackTeamId, slackUserId: message.user! } },
    })
    const channel = await prisma.slackChannelSettings.findUnique({
      where: { slackTeamId_slackChannelId: { slackTeamId: installation.slackTeamId, slackChannelId: message.channel } },
    })
    const options = projects.slice(0, 100).map((project) => ({
      text: { type: 'plain_text', text: project.name.slice(0, 75) },
      value: project.id,
    }))
    const blocks: any[] = [
      { type: 'header', text: { type: 'plain_text', text: 'Shogo Slack settings' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Choose your personal default project. Use `project=...` in a prompt to override it.' } },
      {
        type: 'actions',
        elements: [{
          type: 'static_select',
          action_id: 'slack_personal_default',
          placeholder: { type: 'plain_text', text: 'Personal default project' },
          initial_option: options.find((option) => option.value === link?.personalDefaultProjectId),
          options: [{ text: { type: 'plain_text', text: 'No default' }, value: 'none' }, ...options],
        }],
      },
    ]
    if (await isWorkspaceAdmin(shogoUserId, installation.workspaceId) && message.channel.startsWith('C')) {
      blocks.push(
        { type: 'section', text: { type: 'mrkdwn', text: 'As a workspace admin, you can also set this channel’s default.' } },
        {
          type: 'actions',
          elements: [{
            type: 'static_select',
            action_id: 'slack_channel_default',
            placeholder: { type: 'plain_text', text: 'Channel default project' },
            initial_option: options.find((option) => option.value === channel?.defaultProjectId),
            options: [{ text: { type: 'plain_text', text: 'No default' }, value: 'none' }, ...options],
          }],
        },
      )
    }
    await slackClient(installation).call('chat.postMessage', {
      channel: message.channel,
      thread_ts: message.thread_ts || message.ts,
      text: 'Configure your Shogo Slack project defaults.',
      blocks,
    })
  }

  async function loadThreadMessages(
    client: SlackApiClient,
    channelId: string,
    threadTs: string,
    botUserId: string | null,
    currentTs?: string,
  ): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    const result = await client.call('conversations.replies', { channel: channelId, ts: threadTs, limit: 100 }).catch(() => null)
    if (!result?.ok || !Array.isArray(result.messages)) return []
    return result.messages
      .filter((item: any) => item.ts !== currentTs && item.text && !item.subtype && (!item.bot_id || item.user === botUserId))
      .map((item: any) => ({
        role: item.user === botUserId ? 'assistant' as const : 'user' as const,
        text: cleanSlackText(item.text, botUserId),
      }))
  }

  async function getAccessibleProjects(
    workspaceId: string,
    userId: string,
    slackOnly: boolean,
  ): Promise<Array<SlackRoutableProject & { slackEnabled: boolean; createdBy: string | null }>> {
    const workspaceMember = await prisma.member.findFirst({
      where: { userId, workspaceId },
      select: { id: true },
    })
    const projects = await prisma.project.findMany({
      where: {
        workspaceId,
        hidden: false,
        ...(slackOnly ? { slackEnabled: true } : {}),
        ...(workspaceMember ? {} : { members: { some: { userId } } }),
      },
      select: { id: true, name: true, description: true, slackEnabled: true, createdBy: true },
      orderBy: { name: 'asc' },
    })
    return projects
  }

  async function ensureSlackChatSession(
    sessionId: string,
    project: SlackRoutableProject,
    workspaceId: string,
    prompt?: string,
  ): Promise<void> {
    await prisma.chatSession.upsert({
      where: { id: sessionId },
      create: {
        id: sessionId,
        inferredName: prompt ? prompt.slice(0, 120) : `Slack: ${project.name}`,
        contextType: 'project',
        contextId: project.id,
      },
      update: {},
    })
    void workspaceId
  }

  async function ensureSlackWorkspaceChatSession(
    sessionId: string,
    workspaceId: string,
    prompt?: string,
  ): Promise<void> {
    await prisma.chatSession.upsert({
      where: { id: sessionId },
      create: {
        id: sessionId,
        inferredName: prompt ? prompt.slice(0, 120) : 'Slack workspace agent',
        contextType: 'workspace',
        workspaceId,
      } as any,
      update: {},
    })
  }

  async function hasWorkspaceMembership(userId: string, workspaceId: string): Promise<boolean> {
    return !!(await prisma.member.findFirst({ where: { userId, workspaceId }, select: { id: true } }))
  }

  async function isWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
    return !!(await prisma.member.findFirst({
      where: { userId, workspaceId, role: { in: ['owner', 'admin'] } },
      select: { id: true },
    }))
  }

  return router
}

function slackClient(installation: SlackInstallationRecord): SlackApiClient {
  const token = decryptSecret(installation.botAccessTokenEncrypted)
  return {
    async call(method, body) {
      const response = await fetch(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(`Slack ${method} failed with HTTP ${response.status}`)
      // Slack's API almost always answers with HTTP 200 even when it
      // rejects the call (`{"ok":false,"error":"..."}`) — e.g. invalid
      // blocks, missing scopes, channel_not_found. Only the HTTP-level
      // check above throws, so callers using `.catch(() => {})` for
      // best-effort calls (most of this file) would otherwise never learn
      // a call silently did nothing. This bit real users: the project
      // picker used a duplicate `action_id` across its buttons, Slack
      // rejected it with `invalid_blocks`, and nothing ever told anyone —
      // the "is thinking..." shimmer just cleared with no reply in sight.
      if (result && result.ok === false) {
        console.error(`[SlackAgent] Slack API ${method} returned ok:false —`, result.error, result.errors || '')
      }
      return result
    },
  }
}

async function postMessage(
  installation: SlackInstallationRecord,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  await slackClient(installation).call('chat.postMessage', {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text,
  })
}

function verifyInboundRequest(c: any, rawBody: string, secret: string | undefined): boolean {
  return verifySlackSignature({
    rawBody,
    timestamp: c.req.header('x-slack-request-timestamp'),
    signature: c.req.header('x-slack-signature'),
    signingSecret: secret,
  })
}

function isDuplicate(eventId: string): boolean {
  const now = Date.now()
  for (const [id, expiresAt] of seenEvents) {
    if (expiresAt <= now) seenEvents.delete(id)
  }
  if (seenEvents.has(eventId)) return true
  seenEvents.set(eventId, now + EVENT_TTL_MS)
  return false
}

function cleanSlackText(text: string, botUserId: string | null): string {
  const mention = botUserId ? new RegExp(`<@${escapeRegExp(botUserId)}>`, 'gi') : /<@[A-Z0-9]+>/gi
  return text.replace(mention, ' ').replace(/\s+/g, ' ').trim()
}

function createSlackSessionId(teamId: string, channelId: string, threadTs: string, projectId: string): string {
  const digest = createHash('sha256')
    .update(`slack:${teamId}:${channelId}:${threadTs}:${projectId}`)
    .digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function slackBotScopes(): string[] {
  return [
    'app_mentions:read',
    'channels:history',
    'channels:read',
    'chat:write',
    'files:read',
    'files:write',
    'groups:history',
    'groups:read',
    'im:history',
    'im:read',
    'im:write',
    'mpim:history',
    'mpim:read',
    'reactions:read',
    'reactions:write',
    'team:read',
    'users:read',
    'assistant:write',
  ]
}
