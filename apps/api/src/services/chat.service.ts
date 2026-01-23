/**
 * Chat Service - Prisma-based chat operations
 * Handles chat sessions, messages, and tool call logs
 */

import { prisma, type Prisma, ContextType, ChatRole, ToolCallStatus } from '../lib/prisma';

// ============================================================================
// Chat Sessions
// ============================================================================

/**
 * Get all chat sessions for a context (project or feature)
 */
export async function getChatSessions(
  contextType: ContextType,
  contextId: string,
  options?: {
    limit?: number;
    offset?: number;
  }
) {
  return prisma.chatSession.findMany({
    where: { contextType, contextId },
    orderBy: { lastActiveAt: 'desc' },
    take: options?.limit ?? 50,
    skip: options?.offset ?? 0,
  });
}

/**
 * Get a chat session by ID
 */
export async function getChatSession(sessionId: string) {
  return prisma.chatSession.findUnique({
    where: { id: sessionId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

/**
 * Create a new chat session
 */
export async function createChatSession(data: {
  contextType: ContextType;
  contextId?: string;
  name?: string;
  inferredName?: string;
  phase?: string;
  claudeCodeSessionId?: string;
}) {
  return prisma.chatSession.create({
    data: {
      contextType: data.contextType,
      contextId: data.contextId,
      name: data.name,
      inferredName: data.inferredName ?? 'New Chat',
      phase: data.phase,
      claudeCodeSessionId: data.claudeCodeSessionId,
    },
  });
}

/**
 * Update a chat session
 */
export async function updateChatSession(
  sessionId: string,
  data: Prisma.ChatSessionUpdateInput
) {
  return prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      ...data,
      lastActiveAt: new Date(),
    },
  });
}

/**
 * Delete a chat session
 */
export async function deleteChatSession(sessionId: string) {
  return prisma.chatSession.delete({
    where: { id: sessionId },
  });
}

/**
 * Update last active timestamp
 */
export async function touchChatSession(sessionId: string) {
  return prisma.chatSession.update({
    where: { id: sessionId },
    data: { lastActiveAt: new Date() },
  });
}

// ============================================================================
// Chat Messages
// ============================================================================

/**
 * Get messages for a chat session
 */
export async function getChatMessages(
  sessionId: string,
  options?: {
    limit?: number;
    offset?: number;
    afterId?: string;
  }
) {
  const where: Prisma.ChatMessageWhereInput = { sessionId };

  // If afterId is provided, get messages created after that message
  if (options?.afterId) {
    const afterMessage = await prisma.chatMessage.findUnique({
      where: { id: options.afterId },
      select: { createdAt: true },
    });
    if (afterMessage) {
      where.createdAt = { gt: afterMessage.createdAt };
    }
  }

  return prisma.chatMessage.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: options?.limit,
    skip: options?.offset,
  });
}

/**
 * Create a chat message
 */
export async function createChatMessage(data: {
  sessionId: string;
  role: ChatRole;
  content: string;
  imageData?: string;
  parts?: string;
}) {
  // Update session's lastActiveAt when adding a message
  await prisma.chatSession.update({
    where: { id: data.sessionId },
    data: { lastActiveAt: new Date() },
  });

  return prisma.chatMessage.create({
    data: {
      sessionId: data.sessionId,
      role: data.role,
      content: data.content,
      imageData: data.imageData,
      parts: data.parts,
    },
  });
}

/**
 * Update a chat message
 */
export async function updateChatMessage(
  messageId: string,
  data: Prisma.ChatMessageUpdateInput
) {
  return prisma.chatMessage.update({
    where: { id: messageId },
    data,
  });
}

/**
 * Delete a chat message
 */
export async function deleteChatMessage(messageId: string) {
  return prisma.chatMessage.delete({
    where: { id: messageId },
  });
}

// ============================================================================
// Tool Call Logs
// ============================================================================

/**
 * Get tool call logs for a chat session
 */
export async function getToolCallLogs(
  chatSessionId: string,
  options?: {
    messageId?: string;
    limit?: number;
    offset?: number;
  }
) {
  return prisma.toolCallLog.findMany({
    where: {
      chatSessionId,
      ...(options?.messageId ? { messageId: options.messageId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: options?.limit ?? 100,
    skip: options?.offset ?? 0,
  });
}

/**
 * Create a tool call log
 */
export async function createToolCallLog(data: {
  chatSessionId: string;
  messageId: string;
  toolName: string;
  status: ToolCallStatus;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  duration?: number;
}) {
  return prisma.toolCallLog.create({
    data: {
      chatSessionId: data.chatSessionId,
      messageId: data.messageId,
      toolName: data.toolName,
      status: data.status,
      args: data.args as Prisma.InputJsonValue,
      result: data.result as Prisma.InputJsonValue,
      duration: data.duration,
    },
  });
}

/**
 * Update a tool call log
 */
export async function updateToolCallLog(
  logId: string,
  data: {
    status?: ToolCallStatus;
    result?: Record<string, unknown>;
    duration?: number;
  }
) {
  return prisma.toolCallLog.update({
    where: { id: logId },
    data: {
      status: data.status,
      result: data.result as Prisma.InputJsonValue,
      duration: data.duration,
    },
  });
}
