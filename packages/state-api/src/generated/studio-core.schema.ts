/**
 * StudioCore Domain
 *
 * Auto-generated from Prisma schema by @shogo/state-api
 * Regenerate with: bun run generate:domain
 */

import { scope } from "arktype"

// Enum: ProjectTier
export type ProjectTier = 'starter' | 'pro' | 'enterprise' | 'internal'

// Enum: ProjectStatus
export type ProjectStatus = 'draft' | 'active' | 'archived'

// Enum: AccessLevel
export type AccessLevel = 'anyone' | 'authenticated' | 'private'

// Enum: MemberRole
export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

// Enum: InvitationStatus
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled'

// Enum: EmailStatus
export type EmailStatus = 'not_sent' | 'sent' | 'failed'

// Enum: NotificationType
export type NotificationType = 'invitation_pending' | 'invitation_accepted' | 'member_joined' | 'member_left' | 'workspace_updated'

export const StudioCoreScope = scope({
  Workspace: {
    id: "string.uuid",
    name: "string",
    slug: "string",
    "description?": "string",
    "ssoSettings?": "unknown",
    "createdAt?": "number",
    "updatedAt?": "number",
  },

  Project: {
    id: "string.uuid",
    name: "string",
    "description?": "string",
    "tier?": "'starter' | 'pro' | 'enterprise' | 'internal'",
    "status?": "'draft' | 'active' | 'archived'",
    "schemas?": "string[]",
    "createdBy?": "string",
    "createdAt?": "number",
    "updatedAt?": "number",
    "publishedSubdomain?": "string",
    "publishedAt?": "number",
    "accessLevel?": "'anyone' | 'authenticated' | 'private'",
    "siteTitle?": "string",
    "siteDescription?": "string",
    workspace: "Workspace",
    "folder?": "Folder",
  },

  StarredProject: {
    id: "string.uuid",
    userId: "string",
    projectId: "string",
    workspaceId: "string",
    "createdAt?": "number",
  },

  Member: {
    id: "string.uuid",
    userId: "string",
    "role?": "'owner' | 'admin' | 'member' | 'viewer'",
    "isBillingAdmin?": "boolean",
    "createdAt?": "number",
    "updatedAt?": "number",
    "workspace?": "Workspace",
    "project?": "Project",
  },

  BillingAccount: {
    id: "string.uuid",
    "stripeCustomerId?": "string",
    "taxId?": "string",
    "creditsBalance?": "number",
    "createdAt?": "number",
    "updatedAt?": "number",
    workspace: "Workspace",
  },

  Invitation: {
    id: "string.uuid",
    email: "string",
    "role?": "'owner' | 'admin' | 'member' | 'viewer'",
    "projectId?": "string",
    "status?": "'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled'",
    "emailStatus?": "'not_sent' | 'sent' | 'failed'",
    "emailSentAt?": "number",
    "emailError?": "string",
    "invitedBy?": "string",
    expiresAt: "number",
    "createdAt?": "number",
    "updatedAt?": "number",
    "workspace?": "Workspace",
  },

  Folder: {
    id: "string.uuid",
    name: "string",
    "createdBy?": "string",
    "createdAt?": "number",
    "updatedAt?": "number",
    workspace: "Workspace",
    "parent?": "Folder",
  },

  Notification: {
    id: "string.uuid",
    userId: "string",
    type: "'invitation_pending' | 'invitation_accepted' | 'member_joined' | 'member_left' | 'workspace_updated'",
    title: "string",
    message: "string",
    "metadata?": "unknown",
    "actionUrl?": "string",
    "readAt?": "number",
    "createdAt?": "number",
  },

})
