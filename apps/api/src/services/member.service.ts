/**
 * Member Service - Prisma-based member and invitation operations
 * Handles workspace members, invitations, and notifications
 */

import { prisma, type Prisma, MemberRole, InvitationStatus, NotificationType } from '../lib/prisma';

// ============================================================================
// Members
// ============================================================================

/**
 * Get all members in a workspace
 */
export async function getWorkspaceMembers(workspaceId: string) {
  return prisma.member.findMany({
    where: { workspaceId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Get a member by ID
 */
export async function getMember(memberId: string) {
  return prisma.member.findUnique({
    where: { id: memberId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      workspace: true,
      project: true,
    },
  });
}

/**
 * Get a member by user and workspace
 */
export async function getMemberByUserAndWorkspace(
  userId: string,
  workspaceId: string
) {
  return prisma.member.findFirst({
    where: { userId, workspaceId },
  });
}

/**
 * Add a member to a workspace
 */
export async function addMember(data: {
  userId: string;
  workspaceId: string;
  role: MemberRole;
  isBillingAdmin?: boolean;
}) {
  return prisma.member.create({
    data: {
      userId: data.userId,
      workspaceId: data.workspaceId,
      role: data.role,
      isBillingAdmin: data.isBillingAdmin ?? false,
    },
  });
}

/**
 * Update a member's role
 */
export async function updateMemberRole(
  memberId: string,
  role: MemberRole,
  isBillingAdmin?: boolean
) {
  return prisma.member.update({
    where: { id: memberId },
    data: {
      role,
      ...(isBillingAdmin !== undefined ? { isBillingAdmin } : {}),
    },
  });
}

/**
 * Remove a member from a workspace
 */
export async function removeMember(memberId: string) {
  return prisma.member.delete({
    where: { id: memberId },
  });
}

/**
 * Leave a workspace (user removing themselves)
 * Validates that user is not the last owner before removing
 */
export async function leaveWorkspace(memberId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({
      where: { id: memberId },
    });

    if (!member) {
      throw new Error('Member not found');
    }

    if (member.userId !== userId) {
      throw new Error('Cannot leave workspace for another user');
    }

    if (!member.workspaceId) {
      throw new Error('Member is not part of a workspace');
    }

    // Check if user is the last owner
    if (member.role === 'owner') {
      const ownerCount = await tx.member.count({
        where: {
          workspaceId: member.workspaceId,
          role: 'owner',
        },
      });

      if (ownerCount <= 1) {
        throw new Error('Cannot leave: you are the last owner of this workspace');
      }
    }

    // Delete the membership
    await tx.member.delete({
      where: { id: memberId },
    });
  });
}

// ============================================================================
// Invitations
// ============================================================================

/**
 * Get all pending invitations for a workspace
 */
export async function getWorkspaceInvitations(workspaceId: string) {
  return prisma.invitation.findMany({
    where: {
      workspaceId,
      status: 'pending',
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get invitations for an email address
 */
export async function getInvitationsForEmail(email: string) {
  return prisma.invitation.findMany({
    where: {
      email: email.toLowerCase(),
      status: 'pending',
      expiresAt: { gt: new Date() },
    },
    include: {
      workspace: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Create an invitation
 */
export async function createInvitation(data: {
  email: string;
  workspaceId: string;
  role: MemberRole;
  invitedBy: string;
  expiresInDays?: number;
}) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (data.expiresInDays ?? 7));

  return prisma.invitation.create({
    data: {
      email: data.email.toLowerCase(),
      workspaceId: data.workspaceId,
      role: data.role,
      status: 'pending',
      invitedBy: data.invitedBy,
      expiresAt,
    },
  });
}

/**
 * Accept an invitation
 */
export async function acceptInvitation(invitationId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    // Get the invitation
    const invitation = await tx.invitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new Error('Invitation not found');
    }

    if (invitation.status !== 'pending') {
      throw new Error('Invitation is no longer pending');
    }

    if (invitation.expiresAt < new Date()) {
      throw new Error('Invitation has expired');
    }

    // Update invitation status
    await tx.invitation.update({
      where: { id: invitationId },
      data: { status: 'accepted' },
    });

    // Create membership
    const member = await tx.member.create({
      data: {
        userId,
        workspaceId: invitation.workspaceId,
        projectId: invitation.projectId,
        role: invitation.role,
      },
    });

    return { invitation, member };
  });
}

/**
 * Decline an invitation
 */
export async function declineInvitation(invitationId: string) {
  return prisma.invitation.update({
    where: { id: invitationId },
    data: { status: 'declined' },
  });
}

/**
 * Cancel an invitation (by admin)
 */
export async function cancelInvitation(invitationId: string) {
  return prisma.invitation.update({
    where: { id: invitationId },
    data: { status: 'cancelled' },
  });
}

/**
 * Update invitation email status
 */
export async function updateInvitationEmailStatus(
  invitationId: string,
  status: 'sent' | 'failed',
  error?: string
) {
  return prisma.invitation.update({
    where: { id: invitationId },
    data: {
      emailStatus: status,
      emailSentAt: status === 'sent' ? new Date() : undefined,
      emailError: error,
    },
  });
}

// ============================================================================
// Notifications
// ============================================================================

/**
 * Get notifications for a user
 */
export async function getNotifications(
  userId: string,
  options?: {
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
  }
) {
  return prisma.notification.findMany({
    where: {
      userId,
      ...(options?.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 50,
    skip: options?.offset ?? 0,
  });
}

/**
 * Create a notification
 */
export async function createNotification(data: {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  actionUrl?: string;
}) {
  return prisma.notification.create({
    data: {
      userId: data.userId,
      type: data.type,
      title: data.title,
      message: data.message,
      metadata: data.metadata as Prisma.InputJsonValue,
      actionUrl: data.actionUrl,
    },
  });
}

/**
 * Mark notification as read
 */
export async function markNotificationRead(notificationId: string) {
  return prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllNotificationsRead(userId: string) {
  return prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}

/**
 * Get unread notification count
 */
export async function getUnreadNotificationCount(userId: string) {
  return prisma.notification.count({
    where: { userId, readAt: null },
  });
}
