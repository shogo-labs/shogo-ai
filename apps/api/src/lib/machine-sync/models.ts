// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which models leave the machine, and which never do.
 *
 * The desktop is the single writer of its own database; the cloud keeps a copy
 * of the rows a Studio panel can read (SHO-185). That copy is only acceptable
 * because of this file: every model is classified here, `mirror` or `never`,
 * and `machine-sync.test.ts` fails when the schema grows a model nobody
 * classified. A new model therefore cannot silently leak to the cloud, and
 * cannot silently go missing from a panel either.
 *
 * Three more rules the same test enforces:
 *   • every foreign key out of a `mirror` model points at a `mirror` model, or
 *     is nullable (the copy writes `null`);
 *   • every single-field unique on a `mirror` model is either an id-like value
 *     the desktop already keeps globally unique, or has a rewrite below;
 *   • the two schemas (`schema.prisma`, `schema.local.prisma`) agree on the
 *     model list, so the desktop and the cloud cannot drift apart in secret.
 */

/** Models copied from the desktop to the cloud, and read by the cloud. */
export const MIRROR_MODELS: readonly string[] = [
  // ── Identity and tenancy ──
  // The desktop's local `User` is copied so messages have an author; its email
  // is rewritten (`REWRITES`) so it can never sign in.
  'User',
  'Workspace',
  'Member',
  'StarredProject',
  'Folder',

  // ── Projects and their agent configuration ──
  'Project',
  'ProjectFolder',
  'ProjectAttachment',
  'ProjectCheckpoint',
  'AgentConfig',
  'ProjectAgent',
  'WorkspaceAgentProfile',

  // ── Chat ──
  'ChatSession',
  'ChatSessionProject',
  'ChatMessage',
  'ChatQueuedMessage',
  'MessageFeedback',
  'ToolCallLog',
  'BackgroundTask',
  'AgentTask',
  'Plan',

  // ── Goals and schedules (the desktop runs them; the cloud only shows them) ──
  'Goal',
  'GoalEvent',
  'AgentSchedule',

  // ── Team chat ──
  'Conversation',
  'Huddle',
  'HuddleParticipant',
  'ConversationMember',
  'ConversationMessage',
  'ConversationMention',
  'ConversationReaction',
  'ConversationVote',
  'ConversationAttachment',
  'ChatUserSettings',
  'ConversationPin',
  'ConversationDoc',
  'ConversationDocRevision',
  'ConversationDocArchive',
  'SavedMessage',
  'ConversationDraft',
  'ScheduledMessage',
  'ChatReminder',
  'ChatInboxItem',
  'CustomEmoji',
  'UserGroup',
  'UserGroupMember',

  // ── Boards ──
  'Board',
  'BoardColumn',
  'WorkItem',
  'WorkItemEvent',
  'WorkItemLink',
  'WorkItemSubscription',
  'ProblemOccurrence',

  // ── Meetings, voice project config ──
  'Meeting',
  'MeetingTemplate',
  'VoiceProjectConfig',

  // ── Feature sessions (the spec/plan documents a project agent works from) ──
  'FeatureSession',
  'Requirement',
  'DesignDecision',
  'ClassificationDecision',
  'AnalysisFinding',
  'IntegrationPoint',
  'TestCase',
  'ImplementationTask',
  'TaskDependency',
  'TestSpecification',
  'ImplementationRun',
  'TaskExecution',
] as const

/**
 * Models that never leave the machine, grouped by the reason they don't.
 *
 * Keep a model out of here only if a Studio panel reads it while that machine is
 * selected; otherwise it belongs in one of these lists with its reason.
 */
const NEVER_CREDENTIALS = [
  'Session', // sign-in session
  'Account', // OAuth provider link
  'Verification', // one-time codes
  'ApiKey', // could sign in as the workspace
  'UserIdentityLink', // maps a cloud identity to a local one
  'UserIntegrationConnection', // OAuth tokens
  'UserIntegrationGrant',
  'UserIntegrationWorkspaceGrant',
  'IntegrationCredentialPolicy',
  'IntegrationCredentialApproval',
  'IntegrationCredentialAudit',
  'GitHubConnection', // installation token
  'SlackWorkspaceInstallation',
  'SlackUserLink',
  'SlackChannelSettings',
  'SlackProjectRoutingRule',
  'ChatInstallation',
  'ChatIdentityLink',
  'Invitation',
  'InviteLink',
  'WorkspaceGrant',
  'LicenseKey',
  'AppInstall',
  'AppInstallGrant',
  'PushSubscription',
  'MobilePushSubscription',
  'Notification', // the desktop's own inbox
  'DeviceVersionEvent',
  'SignupAttribution',
] as const

const NEVER_BILLING = [
  'BillingAccount',
  'Subscription',
  'UsageWallet',
  'UsageEvent',
  'InstanceSubscription',
  'StorageUsage',
  'VoiceCallMeter',
  'LiveSessionMeter',
  'AgentCostMetric',
  'BudgetAlert',
  'ProxyTurn', // token accounting for billing
  'Affiliate',
  'AffiliateClick',
  'AffiliateAttribution',
  'AffiliateCommission',
  'AffiliatePayout',
  'AffiliateCommissionTier',
  'AffiliateSocialAccount',
  'AffiliatePost',
  'AffiliatePostSnapshot',
  'MarketplaceListing',
  'MarketplaceListingVersion',
  'MarketplaceInstall',
  'MarketplaceReview',
  'MarketplaceTransaction',
  'TrialRedemption', // card-backed trial, keyed by Stripe ids
] as const

const NEVER_CLOUD_PLATFORM = [
  'Instance', // the cloud's machine registry
  'SignupRiskAssessment', // the cloud's signup anti-abuse record
  'RemoteAction', // the cloud's audit trail
  'EventSubscription', // cloud event bus
  'EventDelivery',
  'WorkspaceEvent',
  'CustomDomain', // DNS is issued by the cloud
  'ProjectAuthConfig', // published-site auth, cloud-served
  'ProjectAuthSignIn',
  'PlatformSetting',
  'ModelProvider',
  'ModelDefinition',
  'WorkspaceModelVisibility',
  'SubagentModelOverride',
  'InfraSnapshot',
  'AnalyticsDigest',
  'EvalRun',
  'EvalRunResult',
  'EvalRun',
  'AgentEvalSet',
  'AgentEvalResult',
  'ModelExperiment',
  'CreatorProfile',
  'CreatorBadge',
  'CreatorFollow',
  'SocialProfile', // provider tokens
  'SocialAccount',
  'SocialPost',
  'SocialPostTarget',
  'SocialRelayedEvent',
  'SocialConversation',
  'SocialMessage',
  'SocialComment',
  'SocialAutomation',
  'SocialAutomationRun',
  'Registry', // component registry — cloud platform data
  'ComponentDefinition',
  'RendererBinding',
  'LayoutTemplate',
  'Composition',
  'ComponentSpec',
  'AgentCall',
  'AgentCallSessionLink',
] as const

const NEVER_MACHINE_LOCAL = [
  'AgentWake', // a queued run on this machine
  'ConversationMessageEmbedding', // a local vector index, rebuilt on demand
  'ConversationAttachmentChunk', // file text for retrieval, local only
  'MachineSyncState',
  'MachineMirrorRow',
  'MachineSyncChange',
  // A move is a job on the machine that started it: its cursors and id map
  // describe bytes in flight between two instances, and mean nothing elsewhere.
  'WorkspaceMove',
] as const

const NEVER_LIVE_CALL = [
  'HuddleInvite', // ringing state for the call in progress
  'HuddleJoinRequest', // the waiting room in front of a call in progress
  'HuddleWake', // which transcript line already woke the agent, for the call in progress
] as const

const NEVER_REASONS: Array<[readonly string[], string]> = [
  [NEVER_CREDENTIALS, 'credentials, sign-in or identity linkage'],
  [NEVER_BILLING, 'billing, metering or marketplace money'],
  [NEVER_CLOUD_PLATFORM, 'cloud platform data (registry, events, social, evals)'],
  [NEVER_MACHINE_LOCAL, 'machine-local run state or derived index'],
  [NEVER_LIVE_CALL, 'live call signalling state'],
]

/** `Model → why it never leaves the machine`. */
export const NEVER_MODELS: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {}
  for (const [models, reason] of NEVER_REASONS) {
    for (const model of models) map[model] = reason
  }
  return map
})()

const MIRROR_SET: ReadonlySet<string> = new Set(MIRROR_MODELS)

export type ModelClassification =
  | { kind: 'mirror' }
  | { kind: 'never'; reason: string }

export function classifyModel(model: string): ModelClassification | null {
  if (MIRROR_SET.has(model)) return { kind: 'mirror' }
  const reason = NEVER_MODELS[model]
  return reason ? { kind: 'never', reason } : null
}

export function isMirroredModel(model: string): boolean {
  return MIRROR_SET.has(model)
}

/**
 * Single-field uniques on a model the cloud also holds, whose values the desktop
 * already keeps globally unique — a cuid, a uuid, a random share token. Two
 * desktops cannot collide on these, so no rewrite is needed.
 *
 * Listed one by one so a *new* unique field fails the test until somebody says
 * which it is. `Model.field` for a single-field unique, `Model` for the id.
 */
export const UNIQUE_SAFE: ReadonlySet<string> = new Set([
  // ids: cuid()/uuid() generated by the desktop, never user-chosen
  'AgentConfig.projectId',
  'WorkspaceAgentProfile.workspaceId',
  'VoiceProjectConfig.projectId',
  'ConversationPin.messageId',
  'ConversationDoc.conversationId',
  'Meeting.shareToken',
  'Huddle.activeKey',
  'Huddle.roomName',
])

/** Values the cloud must rewrite on the way in, because they are globally unique. */
export interface RewriteContext {
  instanceId: string
  /** `Workspace.homeRegion` for the machine. */
  homeRegion: string
}

/**
 * `Model.field → value`. The two human-chosen globals; everything else a desktop
 * sends is either an id or scoped by one.
 */
export const REWRITES: Readonly<
  Record<string, (row: Record<string, unknown>, ctx: RewriteContext) => unknown>
> = {
  /**
   * Every desktop calls its workspace the same thing (`local@shogo.local`'s
   * personal workspace), so the slug collides. The suffix also makes the copy
   * obvious in a database dump.
   */
  'Workspace.slug': (row, ctx) => {
    const slug = typeof row.slug === 'string' && row.slug ? row.slug : 'workspace'
    return `${slug}-m-${ctx.instanceId.slice(0, 8)}`
  },
  /** The tag itself: what makes every guard on the cloud treat this as a copy. */
  'Workspace.machineInstanceId': (_row, ctx) => ctx.instanceId,
  /** The copy lives in the region that received it, not the desktop's idea of one. */
  'Workspace.homeRegion': (_row, ctx) => ctx.homeRegion,
  /** A local user must never be able to sign in with a cloud session. */
  'User.email': (row) => `${String(row.id)}@machines.shogo.invalid`,
  /** Machine projects are not published by the cloud; keep the unique column empty. */
  'Project.publishedSubdomain': () => null,
  /**
   * The huddle's guest join secret. The call runs on the machine that started
   * it, so a copy on the cloud could only ever admit somebody to a call that is
   * not there — and a join secret is not something the copy should hold. The
   * machine keeps minting the real link.
   */
  'Huddle.linkToken': () => null,
}

/** Apply the rewrites for one model to one row. */
export function applyRewrites(
  model: string,
  row: Record<string, unknown>,
  ctx: RewriteContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const [key, rewrite] of Object.entries(REWRITES)) {
    const [rewriteModel, field] = key.split('.')
    if (rewriteModel !== model) continue
    out[field] = rewrite(out, ctx)
  }
  return out
}

/** Prisma Client property for a model name (`MachineSyncState` → `machineSyncState`). */
export function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}
