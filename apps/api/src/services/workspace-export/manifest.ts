// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace export inventory: every Prisma model, classified once, with
 * the reason it is in or out and the predicate that scopes its rows to one
 * workspace.
 *
 * This table is the single source of truth for export, import and the guard
 * test in `__tests__/manifest-coverage.test.ts`. That test fails when a model
 * appears in either schema without an entry here, so a new model cannot slip
 * into an archive silently: add it, decide whether it belongs in one, say
 * why, and give it a scope.
 *
 * The order of the `include` entries is the insertion order. Parents are
 * listed before children so import can insert in one pass, and a unit test
 * asserts every non-nullable FK in an included model targets a model earlier
 * in the list.
 */

export type ExportDecision = 'include' | 'exclude'

/**
 * How rows of a model are narrowed to the workspace being exported.
 *
 *  - `workspace-row`  the Workspace row itself (id = workspaceId)
 *  - `workspace`      where { workspaceId }
 *  - `project`        where { projectId: { in: <this workspace project ids> } }
 *  - `parent`         rows whose `field` points at a row collected from `parent`
 */
export type ExportScope =
  | { kind: 'workspace-row' }
  | { kind: 'workspace' }
  | { kind: 'project' }
  | { kind: 'parent'; field: string; parent: string }

export interface ModelManifestEntry {
  decision: ExportDecision
  /** Why this model is in (or out of) a workspace archive. */
  reason: string
  /** Present only for `include` entries. */
  scope?: ExportScope
}

export interface ColumnRedaction {
  /** Credential columns: blanked and reported unless the archive is password-protected. */
  redact?: readonly string[]
  /** JSON columns that may embed credentials (AgentConfig.channels). */
  jsonSecrets?: readonly string[]
}

export const WORKSPACE_EXPORT_MANIFEST: Record<string, ModelManifestEntry> = {
  Workspace: { decision: 'include', reason: 'The workspace row itself: id, name, kind, settings, agent defaults.', scope: { kind: 'workspace-row' } },
  Folder: { decision: 'include', reason: 'Workspace project folders and their nesting.', scope: { kind: 'workspace' } },
  Project: { decision: 'include', reason: 'Projects and their settings/publish metadata. Code files travel in projects/<id>/files, not as rows.', scope: { kind: 'workspace' } },
  ProjectAgent: { decision: 'include', reason: 'Per-project agent identities (name, avatar, model), not container state.', scope: { kind: 'workspace' } },
  AgentConfig: { decision: 'include', reason: 'Heartbeat/model config. `channels[]` secrets are redacted unless the archive is password-protected.', scope: { kind: 'project' } },
  ProjectFolder: { decision: 'include', reason: 'Folder-linked project checkouts (path + branch).', scope: { kind: 'project' } },
  ProjectAttachment: { decision: 'include', reason: 'Files shared with a project, and the link between two attached projects.', scope: { kind: 'project' } },
  WorkspaceAgentProfile: { decision: 'include', reason: 'The workspace agent identity shown in team chat.', scope: { kind: 'workspace' } },
  SubagentModelOverride: { decision: 'include', reason: 'Per-workspace/per-project subagent model overrides.', scope: { kind: 'workspace' } },
  WorkspaceModelVisibility: { decision: 'include', reason: 'Which models this workspace allows.', scope: { kind: 'workspace' } },
  StarredProject: { decision: 'include', reason: 'A member starred project.', scope: { kind: 'workspace' } },
  CustomEmoji: { decision: 'include', reason: 'Custom emoji a member uploaded.', scope: { kind: 'workspace' } },
  ChatSession: { decision: 'include', reason: 'Every agent chat session in the workspace (project- and workspace-scoped).', scope: { kind: 'workspace' } },
  ChatMessage: { decision: 'include', reason: 'The full agent transcripts. Attachment bytes live in attachments/, not inline.', scope: { kind: 'parent', field: 'sessionId', parent: 'ChatSession' } },
  ChatSessionProject: { decision: 'include', reason: 'Which projects a chat session is attached to.', scope: { kind: 'project' } },
  MessageFeedback: { decision: 'include', reason: 'Thumbs up/down and notes on messages.', scope: { kind: 'parent', field: 'messageId', parent: 'ChatMessage' } },
  ChatReminder: { decision: 'include', reason: 'Reminders a member set from chat.', scope: { kind: 'workspace' } },
  Conversation: { decision: 'include', reason: 'Channels and DMs. dm/group_dm rows are filtered by the DM policy unless an owner opts in.', scope: { kind: 'workspace' } },
  ConversationMember: { decision: 'include', reason: 'Who is in each conversation.', scope: { kind: 'parent', field: 'conversationId', parent: 'Conversation' } },
  ConversationMessage: { decision: 'include', reason: 'Channel/DM messages, including agent replies.', scope: { kind: 'parent', field: 'conversationId', parent: 'Conversation' } },
  ConversationAttachment: { decision: 'include', reason: 'Channel attachments (bytes under attachments/).', scope: { kind: 'parent', field: 'conversationId', parent: 'Conversation' } },
  ConversationAttachmentChunk: { decision: 'include', reason: 'Extracted text chunks used for channel search.', scope: { kind: 'parent', field: 'attachmentId', parent: 'ConversationAttachment' } },
  ConversationDoc: { decision: 'include', reason: 'The shared doc of each channel.', scope: { kind: 'parent', field: 'conversationId', parent: 'Conversation' } },
  ConversationDocRevision: { decision: 'include', reason: 'Doc revision history.', scope: { kind: 'parent', field: 'docId', parent: 'ConversationDoc' } },
  ConversationDocArchive: { decision: 'include', reason: 'Sections archived out of a channel doc, restorable from the doc pane.', scope: { kind: 'parent', field: 'conversationId', parent: 'Conversation' } },
  ConversationMention: { decision: 'include', reason: 'Who was mentioned in which message.', scope: { kind: 'parent', field: 'messageId', parent: 'ConversationMessage' } },
  ConversationPin: { decision: 'include', reason: 'Pinned messages.', scope: { kind: 'parent', field: 'conversationId', parent: 'Conversation' } },
  ConversationReaction: { decision: 'include', reason: 'Emoji reactions.', scope: { kind: 'parent', field: 'messageId', parent: 'ConversationMessage' } },
  ConversationVote: { decision: 'include', reason: 'Poll and Q&A votes in a channel or huddle thread.', scope: { kind: 'parent', field: 'messageId', parent: 'ConversationMessage' } },
  ScheduledMessage: { decision: 'include', reason: 'Messages queued for later delivery.', scope: { kind: 'parent', field: 'conversationId', parent: 'Conversation' } },
  SavedMessage: { decision: 'include', reason: 'Messages a member saved.', scope: { kind: 'parent', field: 'messageId', parent: 'ConversationMessage' } },
  Huddle: { decision: 'include', reason: 'Huddles started in a conversation.', scope: { kind: 'parent', field: 'conversationId', parent: 'Conversation' } },
  HuddleParticipant: { decision: 'include', reason: 'Who joined each huddle.', scope: { kind: 'parent', field: 'huddleId', parent: 'Huddle' } },
  HuddleInvite: { decision: 'include', reason: 'Who was rung into each huddle, and whether they came.', scope: { kind: 'parent', field: 'huddleId', parent: 'Huddle' } },
  HuddleJoinRequest: { decision: 'include', reason: 'People who knocked to join a huddle, and how it was answered.', scope: { kind: 'parent', field: 'huddleId', parent: 'Huddle' } },
  HuddleWake: { decision: 'include', reason: 'Spoken "hey Shogo" wakes: who said it, and the agent turn it started.', scope: { kind: 'parent', field: 'huddleId', parent: 'Huddle' } },
  Meeting: { decision: 'include', reason: 'Meetings with their transcript/recording references.', scope: { kind: 'workspace' } },
  MeetingTemplate: { decision: 'include', reason: 'Meeting templates.', scope: { kind: 'workspace' } },
  Board: { decision: 'include', reason: 'Work boards.', scope: { kind: 'workspace' } },
  BoardColumn: { decision: 'include', reason: 'Board columns (and their automation settings).', scope: { kind: 'parent', field: 'boardId', parent: 'Board' } },
  WorkItem: { decision: 'include', reason: 'Cards: key, column, fields, history summary.', scope: { kind: 'workspace' } },
  WorkItemEvent: { decision: 'include', reason: 'Card event history.', scope: { kind: 'workspace' } },
  WorkItemLink: { decision: 'include', reason: 'Links from a card to messages/PRs/docs.', scope: { kind: 'workspace' } },
  ProblemOccurrence: { decision: 'include', reason: 'Problem occurrences attached to a card.', scope: { kind: 'workspace' } },
  AgentSchedule: { decision: 'include', reason: 'Recurring schedules the agent runs.', scope: { kind: 'workspace' } },
  Goal: { decision: 'include', reason: 'Long-running goals.', scope: { kind: 'workspace' } },
  GoalEvent: { decision: 'include', reason: 'Goal progress log.', scope: { kind: 'parent', field: 'goalId', parent: 'Goal' } },
  EventSubscription: { decision: 'include', reason: 'Trigger definitions (webhook URL and secret redacted).', scope: { kind: 'workspace' } },
  AgentTask: { decision: 'include', reason: 'Dispatched agent tasks and their outcomes.', scope: { kind: 'workspace' } },
  FeatureSession: { decision: 'include', reason: 'Feature-pipeline sessions a person ran.', scope: { kind: 'project' } },
  Requirement: { decision: 'include', reason: 'Requirements authored in a feature session.', scope: { kind: 'parent', field: 'sessionId', parent: 'FeatureSession' } },
  DesignDecision: { decision: 'include', reason: 'Design decisions authored in a feature session.', scope: { kind: 'parent', field: 'sessionId', parent: 'FeatureSession' } },
  ClassificationDecision: { decision: 'include', reason: 'Classification decisions authored in a feature session.', scope: { kind: 'parent', field: 'sessionId', parent: 'FeatureSession' } },
  Member: { decision: 'include', reason: 'Roles and per-member flags. `User` rows themselves are not workspace content.', scope: { kind: 'workspace' } },
  Invitation: { decision: 'include', reason: 'Pending invitations (email and role).', scope: { kind: 'workspace' } },
  InviteLink: { decision: 'include', reason: 'Invite links; `token` is a credential and is redacted.', scope: { kind: 'workspace' } },
  UserGroup: { decision: 'include', reason: 'Groups used for channel/board membership.', scope: { kind: 'workspace' } },
  UserGroupMember: { decision: 'include', reason: 'Group membership.', scope: { kind: 'parent', field: 'groupId', parent: 'UserGroup' } },
  GitHubConnection: { decision: 'include', reason: 'Which repo a project is connected to. `encryptedToken` is a credential and is redacted.', scope: { kind: 'project' } },
  IntegrationCredentialPolicy: { decision: 'include', reason: 'Who the agent acts as when using an integration.', scope: { kind: 'project' } },
  IntegrationCredentialApproval: { decision: 'include', reason: 'Approval requests and decisions (no credentials).', scope: { kind: 'project' } },
  UserIntegrationGrant: { decision: 'include', reason: 'Per-project integration grants.', scope: { kind: 'project' } },
  UserIntegrationWorkspaceGrant: { decision: 'include', reason: 'Per-workspace integration grants.', scope: { kind: 'workspace' } },
  CustomDomain: { decision: 'include', reason: 'Custom publish domains and their verification state.', scope: { kind: 'project' } },
  ProjectAuthConfig: { decision: 'include', reason: 'Published-site auth mode and allowlists.', scope: { kind: 'project' } },
  VoiceProjectConfig: { decision: 'include', reason: 'Voice config (agent/phone ids; provider keys are not stored here).', scope: { kind: 'workspace' } },
  Account: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  Affiliate: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  AffiliateAttribution: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  AffiliateClick: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  AffiliateCommission: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  AffiliateCommissionTier: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  AffiliatePayout: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  AffiliatePost: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  AffiliatePostSnapshot: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  AffiliateSocialAccount: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  AgentCall: { decision: 'exclude', reason: 'In-flight runtime state: a project_call record is a 7-day lease on a live call. The answer that matters is written into its ChatMessage, which is exported.' },
  AgentWake: { decision: 'exclude', reason: 'In-flight runtime state: a row is a pointer at a message no one has replied to yet (queued or waiting out its debounce). The reply it produces is exported as the ChatMessage.' },
  AgentCallSessionLink: { decision: 'exclude', reason: 'In-flight runtime state: maps a call to its callee chat for reconciliation on read, and expires with the AgentCall. Rebuilt on demand, never restored.' },
  AgentCostMetric: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  AgentEvalResult: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  AgentEvalSet: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  AnalysisFinding: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  AnalyticsDigest: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  ApiKey: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  AppInstall: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  AppInstallGrant: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  BackgroundTask: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  BillingAccount: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  BudgetAlert: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  ChatIdentityLink: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  ChatInboxItem: { decision: 'exclude', reason: 'One device or one person\'s ephemeral state, meaningless on restore.' },
  ChatInstallation: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  ChatQueuedMessage: { decision: 'exclude', reason: 'One device or one person\'s ephemeral state, meaningless on restore.' },
  ChatUserSettings: { decision: 'exclude', reason: 'One device or one person\'s ephemeral state, meaningless on restore.' },
  ComponentDefinition: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  ComponentSpec: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  Composition: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  ConversationDraft: { decision: 'exclude', reason: 'One device or one person\'s ephemeral state, meaningless on restore.' },
  ConversationMessageEmbedding: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  CreatorBadge: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  CreatorFollow: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  CreatorProfile: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  DeviceVersionEvent: { decision: 'exclude', reason: 'Per-device install telemetry (device id, OS, arch, version, channel) behind admin version adoption. Keyed by the machine, not the workspace, so it belongs to the instance: a restore must not fabricate adoption history it never observed.' },
  EvalRun: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  EvalRunResult: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  EventDelivery: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  ImplementationRun: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  ImplementationTask: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  InfraSnapshot: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  Instance: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  InstanceSubscription: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  IntegrationCredentialAudit: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  IntegrationPoint: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  LayoutTemplate: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  LicenseKey: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  LiveSessionMeter: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  LocalConfig: { decision: 'exclude', reason: 'Desktop-only machine-local configuration (paths, ports); never leaves the machine.' },
  MachineMirrorRow: { decision: 'exclude', reason: 'Machine sync bookkeeping: which paired desktop owns each copied row. Derived from ingest, so a restore rebuilds it by re-syncing.' },
  MachineSyncChange: { decision: 'exclude', reason: 'Machine sync bookkeeping: the desktop-side trigger-written change log, read and pruned by the pusher on the machine that wrote it. It never leaves that machine.' },
  MachineSyncState: { decision: 'exclude', reason: 'Machine sync bookkeeping: epoch and acked cursor of one machine copy. Derived from the desktop change log, so a restore rebuilds it.' },
  MarketplaceInstall: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  MarketplaceListing: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  MarketplaceListingVersion: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  MarketplaceReview: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  MarketplaceTransaction: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  MobilePushSubscription: { decision: 'exclude', reason: 'One device or one person\'s ephemeral state, meaningless on restore.' },
  ModelDefinition: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  ModelExperiment: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  ModelProvider: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  Notification: { decision: 'exclude', reason: 'One device or one person\'s ephemeral state, meaningless on restore.' },
  Plan: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  PlatformSetting: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  ProjectAuthSignIn: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  ProjectCheckpoint: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  ProxyTurn: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  PushSubscription: { decision: 'exclude', reason: 'One device or one person\'s ephemeral state, meaningless on restore.' },
  Registry: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  RemoteAction: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  RemoteHost: { decision: 'exclude', reason: 'Desktop-only SSH host credentials.' },
  RendererBinding: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  Session: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  SignupAttribution: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  SignupRiskAssessment: { decision: 'exclude', reason: 'Global anti-abuse state keyed by user: signals, score, band and the review decision. It is the platform\'s fraud record of a person, not workspace content.' },
  SlackChannelSettings: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  SlackProjectRoutingRule: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  SlackUserLink: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  SlackWorkspaceInstallation: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  SocialAccount: { decision: 'exclude', reason: 'Provider mirror: the connected platform account (Zernio ids, handle, health timestamps). Unique on the provider id, so a restore would collide with the live account; re-syncs from Zernio on reconnect.' },
  SocialAutomation: { decision: 'include', reason: 'Comment-to-DM automations authored in Studio: name, mode, keywords and config. Provider execution ids and counters are not carried.', scope: { kind: 'workspace' } },
  SocialAutomationRun: { decision: 'exclude', reason: 'Provider mirror: one execution of an automation (Zernio execution id, status, error). Re-syncs from Zernio; the definition travels on SocialAutomation.' },
  SocialComment: { decision: 'exclude', reason: 'Provider mirror: comments on published posts, keyed by the platform comment id. They stay on the platform and re-sync from Zernio.' },
  SocialConversation: { decision: 'exclude', reason: 'Provider mirror: a platform DM thread, keyed by the Zernio conversation id. Re-syncs from Zernio; conversations Studio owns travel as Conversation.' },
  SocialMessage: { decision: 'exclude', reason: 'Provider mirror: messages inside a platform DM thread, keyed by the Zernio message id. Re-syncs from Zernio; Studio-owned messages travel as ConversationMessage.' },
  SocialPost: { decision: 'include', reason: 'Posts authored in Studio: status, content, media, tags and schedule. Publishing state is provider-side and is not carried.', scope: { kind: 'workspace' } },
  SocialPostTarget: { decision: 'exclude', reason: 'Provider mirror: the per-platform copy of a post (platform post id and url, metering). Needs its SocialAccount, which is not carried; rebuilt when the post is published.' },
  SocialProfile: { decision: 'exclude', reason: 'Provider mirror: the Zernio profile that owns the connected accounts. Unique on the provider id and recreated on connect, so it must not travel in an archive.' },
  SocialRelayedEvent: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  StorageUsage: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  Subscription: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  TaskDependency: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  TaskExecution: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  TestCase: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  TestSpecification: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  ToolCallLog: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  TrialRedemption: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  UsageEvent: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  UsageWallet: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  User: { decision: 'exclude', reason: 'Global rows (auth, marketplace catalog, affiliate programme) that belong to the instance or the person, not this workspace. Member carries the names and emails the export needs.' },
  UserIdentityLink: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  UserIntegrationConnection: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  Verification: { decision: 'exclude', reason: 'Instance catalog or global configuration, identical on every restore.' },
  VoiceCallMeter: { decision: 'exclude', reason: 'Money and metering, not content. Also carries payment-processor ids; StorageUsage is recomputable.' },
  WorkItemSubscription: { decision: 'exclude', reason: 'One device or one person\'s ephemeral state, meaningless on restore.' },
  WorkspaceEvent: { decision: 'exclude', reason: 'In-flight runtime state, append-only telemetry or embeddings. Task outputs still travel as files under .shogo/tasks/.' },
  WorkspaceGrant: { decision: 'exclude', reason: 'Reusable credentials, OAuth tokens, device keys or end-user sign-in PII of a published app. None can be re-issued by us, so a downloaded file must not carry them.' },
  WorkspaceMove: { decision: 'exclude', reason: 'The log of how this copy got here (phase cursors, id map, handover). The target records its own; carrying it across would describe a move that never happened.' },
}

/**
 * Columns that never travel in a plain (redacted) archive. A password-protected
 * archive carries them in place instead — that is what the opt-in password is
 * for, and manifest.options.redacted records which mode ran.
 *
 * Keep this list narrow: a column belongs here only when its value *is* a
 * credential. Ids, slugs and login names are content.
 */
export const MODEL_COLUMN_REDACTIONS: Record<string, ColumnRedaction> = {
  Project: { redact: ['sitePasswordHash'] },
  InviteLink: { redact: ['token'] },
  GitHubConnection: { redact: ['encryptedToken'] },
  Meeting: { redact: ['shareToken'] },
  EventSubscription: { redact: ['webhookUrl', 'webhookSecret'] },
  AgentConfig: { jsonSecrets: ['channels'] },
}

export const INCLUDED_MODELS: readonly string[] = Object.freeze(
  Object.entries(WORKSPACE_EXPORT_MANIFEST)
    .filter(([, entry]) => entry.decision === 'include')
    .map(([model]) => model),
)

const INCLUDED = new Set(INCLUDED_MODELS)

export function isIncludedModel(model: string): boolean {
  return INCLUDED.has(model)
}

/** Included models in FK-safe insertion order (parents first). */
export function insertOrder(): readonly string[] {
  return INCLUDED_MODELS
}

export function scopeFor(model: string): ExportScope | null {
  return WORKSPACE_EXPORT_MANIFEST[model]?.scope ?? null
}

/** The included model a parent-scoped model hangs off, or null. */
export function parentOf(model: string): { field: string; parent: string } | null {
  const scope = scopeFor(model)
  return scope && scope.kind === 'parent' ? { field: scope.field, parent: scope.parent } : null
}

/** Column redactions for a model, if it has any. */
export function redactionsFor(model: string): ColumnRedaction | undefined {
  return MODEL_COLUMN_REDACTIONS[model]
}
