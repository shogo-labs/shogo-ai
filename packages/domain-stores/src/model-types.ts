// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Type-only re-exports for all domain models.
 *
 * Import from here when you only need the TypeScript instance type of a model
 * (e.g. for function parameter types, return types, or generic constraints).
 * Using `import type` avoids pulling model values into modules that don't need
 * them and prevents accidental circular value imports.
 *
 * @example
 *   import type { UserModelType, WorkspaceModelType } from './model-types'
 */

export type { IUser as UserModelType } from './user.model'
export type { IProject as ProjectModelType } from './project.model'
export type { IWorkspace as WorkspaceModelType } from './workspace.model'
export type { IMember as MemberModelType } from './member.model'
export type { IBillingAccount as BillingAccountModelType } from './billing-account.model'
export type { IChatMessage as ChatMessageModelType } from './chat-message.model'
export type { IChatSession as ChatSessionModelType } from './chat-session.model'
export type { IUsageWallet as UsageWalletModelType } from './usage-wallet.model'
export type { IFeatureSession as FeatureSessionModelType } from './feature-session.model'
export type { IFolder as FolderModelType } from './folder.model'
export type { IInvitation as InvitationModelType } from './invitation.model'
export type { INotification as NotificationModelType } from './notification.model'
export type { IStarredProject as StarredProjectModelType } from './starred-project.model'
export type { ISubscription as SubscriptionModelType } from './subscription.model'
export type { IToolCallLog as ToolCallLogModelType } from './tool-call-log.model'
export type { IUsageEvent as UsageEventModelType } from './usage-event.model'
