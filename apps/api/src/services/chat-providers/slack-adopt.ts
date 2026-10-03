// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Carry the Slack agent integration's routing into team chat when a workspace
 * switches its team chat to Slack:
 *   channel default project  -> that agent answers @mentions in the channel
 *   keyword routing rules    -> install-level rules used when the app is @mentioned
 *   workspace default project -> install default (answers when nothing else matches)
 * Safe to run repeatedly.
 */

import { prisma } from '../../lib/prisma'
import { ensureShadowConversation, type KeywordRule } from './inbound'
import { installationForWorkspace, mergeInstallationConfig } from './installations'
import { getChatProvider } from './registry'

const db = prisma as any

export async function adoptSlackRouting(workspaceId: string): Promise<{ channels: number; rules: number }> {
  const installation = await installationForWorkspace(workspaceId, 'slack')
  if (!installation) return { channels: 0, rules: 0 }
  const teamId = installation.externalTenantId
  const [legacy, settings, rules, projects] = await Promise.all([
    db.slackWorkspaceInstallation.findUnique({ where: { slackTeamId: teamId }, select: { defaultProjectId: true } }),
    db.slackChannelSettings.findMany({ where: { slackTeamId: teamId, defaultProjectId: { not: null } } }),
    db.slackProjectRoutingRule.findMany({ where: { slackTeamId: teamId }, select: { keyword: true, projectId: true } }),
    db.project.findMany({ where: { workspaceId }, select: { id: true } }),
  ])
  const inWorkspace = new Set(projects.map((p: any) => p.id))

  const keywordRules: KeywordRule[] = rules
    .filter((r: any) => r.keyword && inWorkspace.has(r.projectId))
    .map((r: any) => ({ keyword: r.keyword, projectId: r.projectId }))
  const patch: Record<string, unknown> = { keywordRules }
  if (legacy?.defaultProjectId && inWorkspace.has(legacy.defaultProjectId) && !installation.config.defaultProjectId) {
    patch.defaultProjectId = legacy.defaultProjectId
  }
  await mergeInstallationConfig(installation.id, patch)

  const provider = getChatProvider('slack')
  let channels = 0
  for (const setting of settings) {
    if (!inWorkspace.has(setting.defaultProjectId)) continue
    const conversation = await ensureShadowConversation(installation, provider, {
      channelId: setting.slackChannelId,
      channelName: null,
      channelKind: null,
    })
    if (!conversation || conversation.kind === 'dm') continue
    const existing = await db.conversationMember.findFirst({
      where: { conversationId: conversation.id, memberType: 'agent', projectId: setting.defaultProjectId },
      select: { id: true },
    })
    if (!existing) {
      await db.conversationMember.create({
        data: { conversationId: conversation.id, memberType: 'agent', projectId: setting.defaultProjectId, agentTrigger: 'mention' },
      })
    }
    channels++
  }
  return { channels, rules: keywordRules.length }
}
