/**
 * Message Server Functions
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type MessageType = {
  id: string
  role: string
  content: string
  chatId: string
  createdAt: Date
}

export const getMessages = createServerFn({ method: 'POST' })
  .inputValidator((data: { chatId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const chat = await shogo.db.chat.findFirst({
      where: { id: data.chatId, userId: data.userId },
    })
    if (!chat) {
      throw new Error('Chat not found')
    }

    const messages = await shogo.db.message.findMany({
      where: { chatId: data.chatId },
      orderBy: { createdAt: 'asc' },
    })
    return messages as MessageType[]
  })

export const saveMessage = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    chatId: string
    userId: string
    role: string
    content: string
  }) => data)
  .handler(async ({ data }) => {
    const chat = await shogo.db.chat.findFirst({
      where: { id: data.chatId, userId: data.userId },
    })
    if (!chat) {
      throw new Error('Chat not found')
    }

    const message = await shogo.db.message.create({
      data: {
        role: data.role,
        content: data.content,
        chatId: data.chatId,
      },
    })

    // Update chat timestamp
    await shogo.db.chat.update({
      where: { id: data.chatId },
      data: { updatedAt: new Date() },
    })

    // Auto-title from first user message
    const messageCount = await shogo.db.message.count({
      where: { chatId: data.chatId },
    })
    if (messageCount === 1 && data.role === 'user') {
      const title = data.content.slice(0, 50) + (data.content.length > 50 ? '...' : '')
      await shogo.db.chat.update({
        where: { id: data.chatId },
        data: { title },
      })
    }

    return message as MessageType
  })

export const deleteMessage = createServerFn({ method: 'POST' })
  .inputValidator((data: { messageId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const message = await shogo.db.message.findFirst({
      where: { id: data.messageId },
      include: { chat: true },
    })
    if (!message || message.chat.userId !== data.userId) {
      throw new Error('Message not found')
    }

    await shogo.db.message.delete({
      where: { id: data.messageId },
    })
    return { success: true }
  })
