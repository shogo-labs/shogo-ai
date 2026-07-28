// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { API_URL } from './api'

export interface ChatSearchHitDto {
  conversationId: string
  messageId?: string
  field: 'title' | 'project' | 'message'
  score: number
  text: string
  snippet: string
  ranges: Array<{ start: number; end: number }>
  createdAt: number
}

export interface ChatSearchConversationDto {
  conversationId: string
  title: string
  contextType?: string | null
  projectId?: string | null
  projectName?: string | null
  workspaceId?: string | null
  updatedAt: number
  score: number
  hits: ChatSearchHitDto[]
}

export interface ChatSearchResponseDto {
  ok: true
  query: string
  conversations: ChatSearchConversationDto[]
  hasMore: boolean
  nextOffset: number | null
}

export async function searchWorkspaceChats(input: {
  workspaceId: string
  query: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<ChatSearchResponseDto> {
  const params = new URLSearchParams({
    workspaceId: input.workspaceId,
    q: input.query,
    limit: String(input.limit ?? 10),
    offset: String(input.offset ?? 0),
  })
  const res = await fetch(`${API_URL}/api/chat-search?${params.toString()}`, {
    signal: input.signal,
    credentials: Platform.OS === 'web' ? 'include' : undefined,
  } as RequestInit)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok !== true) {
    throw new Error(data?.error?.message || 'Chat search failed')
  }
  return data as ChatSearchResponseDto
}