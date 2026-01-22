/**
 * Chat Server Functions
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { MessageType } from './messages'

export type ChatType = {
  id: string
  title: string
  visibility: string
  userId: string
  createdAt: Date
  updatedAt: Date
}

export type ChatWithMessages = ChatType & {
  messages: MessageType[]
}

export const getChats = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    const chats = await shogo.db.chat.findMany({
      where: { userId: data.userId },
      orderBy: { updatedAt: 'desc' },
    })
    return chats as ChatType[]
  })

export const getChat = createServerFn({ method: 'POST' })
  .inputValidator((data: { chatId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const chat = await shogo.db.chat.findFirst({
      where: { id: data.chatId, userId: data.userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    return chat as ChatWithMessages | null
  })

export const createChat = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string; title?: string; visibility?: string }) => data)
  .handler(async ({ data }) => {
    const chat = await shogo.db.chat.create({
      data: {
        title: data.title || 'New Chat',
        visibility: data.visibility || 'private',
        userId: data.userId,
      },
    })
    return chat as ChatType
  })

export const updateChatTitle = createServerFn({ method: 'POST' })
  .inputValidator((data: { chatId: string; userId: string; title: string }) => data)
  .handler(async ({ data }) => {
    const existing = await shogo.db.chat.findFirst({
      where: { id: data.chatId, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Chat not found')
    }

    const chat = await shogo.db.chat.update({
      where: { id: data.chatId },
      data: { title: data.title },
    })
    return chat as ChatType
  })

export const deleteChat = createServerFn({ method: 'POST' })
  .inputValidator((data: { chatId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const existing = await shogo.db.chat.findFirst({
      where: { id: data.chatId, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Chat not found')
    }

    await shogo.db.chat.delete({
      where: { id: data.chatId },
    })
    return { success: true }
  })
