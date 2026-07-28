// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
export type ChatSearchField = 'title' | 'project' | 'message'

export interface ChatSearchConversation {
  id: string
  title: string
  projectName?: string | null
  updatedAt: number
}

export interface ChatSearchMessage {
  id: string
  conversationId: string
  content: string
  createdAt: number
}

export interface ChatSearchDocument {
  id: string
  conversationId: string
  messageId?: string
  field: ChatSearchField
  text: string
  createdAt: number
  conversationUpdatedAt: number
}

export interface ChatSearchHit {
  conversationId: string
  messageId?: string
  field: ChatSearchField
  score: number
  text: string
  snippet: string
  ranges: Array<{ start: number; end: number }>
  createdAt: number
}

export interface ChatSearchConversationResult {
  conversationId: string
  title: string
  projectName?: string | null
  updatedAt: number
  score: number
  hits: ChatSearchHit[]
}

export interface ChatSearchResult {
  query: string
  conversations: ChatSearchConversationResult[]
}

export interface ChatSearchIndexSnapshot {
  conversations: ChatSearchConversation[]
  messages: ChatSearchMessage[]
}

interface TokenPosting {
  docId: string
  frequency: number
}

interface StoredDocument extends ChatSearchDocument {
  tokens: Map<string, number>
}

const MAX_SNIPPET_LENGTH = 160
const MAX_HITS_PER_CONVERSATION = 6

export function normalizeChatSearchQuery(query: string): string[] {
  const tokens = tokenize(query)
  return Array.from(new Set(tokens))
}

export function highlightChatSearchText(
  text: string,
  queryTokens: string[],
): Array<{ start: number; end: number }> {
  if (!text || queryTokens.length === 0) return []

  const lower = text.toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []

  for (const token of queryTokens) {
    if (!token) continue
    let start = lower.indexOf(token)
    while (start !== -1) {
      ranges.push({ start, end: start + token.length })
      start = lower.indexOf(token, start + 1)
    }
  }

  return mergeRanges(ranges)
}

export function buildChatSearchSnippet(text: string, queryTokens: string[]): string {
  const ranges = highlightChatSearchText(text, queryTokens)
  if (text.length <= MAX_SNIPPET_LENGTH) return text
  if (ranges.length === 0) return `${text.slice(0, MAX_SNIPPET_LENGTH - 1).trimEnd()}...`

  const anchor = ranges[0].start
  const half = Math.floor(MAX_SNIPPET_LENGTH / 2)
  const start = Math.max(0, anchor - half)
  const end = Math.min(text.length, start + MAX_SNIPPET_LENGTH)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  return `${prefix}${text.slice(start, end).trim()}${suffix}`
}

export class ChatSearchIndex {
  private conversations = new Map<string, ChatSearchConversation>()
  private messageIdsByConversation = new Map<string, Set<string>>()
  private documents = new Map<string, StoredDocument>()
  private docIdsByMessage = new Map<string, Set<string>>()
  private docIdsByConversationMetadata = new Map<string, Set<string>>()
  private postings = new Map<string, Map<string, TokenPosting>>()

  static fromSnapshot(snapshot: ChatSearchIndexSnapshot): ChatSearchIndex {
    const index = new ChatSearchIndex()
    for (const conversation of snapshot.conversations) {
      index.upsertConversation(conversation)
    }
    for (const message of snapshot.messages) {
      index.upsertMessage(message)
    }
    return index
  }

  get documentCount(): number {
    return this.documents.size
  }

  upsertConversation(conversation: ChatSearchConversation): void {
    const title = conversation.title.trim() || 'Untitled chat'
    const normalized: ChatSearchConversation = { ...conversation, title }
    this.conversations.set(conversation.id, normalized)
    this.deleteConversationMetadataDocuments(conversation.id)

    this.addDocument({
      id: `conversation:${conversation.id}:title`,
      conversationId: conversation.id,
      field: 'title',
      text: title,
      createdAt: conversation.updatedAt,
      conversationUpdatedAt: conversation.updatedAt,
    })

    if (conversation.projectName?.trim()) {
      this.addDocument({
        id: `conversation:${conversation.id}:project`,
        conversationId: conversation.id,
        field: 'project',
        text: conversation.projectName.trim(),
        createdAt: conversation.updatedAt,
        conversationUpdatedAt: conversation.updatedAt,
      })
    }
  }

  removeConversation(conversationId: string): void {
    this.conversations.delete(conversationId)
    this.deleteConversationMetadataDocuments(conversationId)
    const messageIds = this.messageIdsByConversation.get(conversationId)
    for (const messageId of messageIds ?? []) {
      this.removeMessage(messageId)
    }
    this.messageIdsByConversation.delete(conversationId)
  }

  upsertMessage(message: ChatSearchMessage): void {
    if (!this.conversations.has(message.conversationId)) {
      this.upsertConversation({
        id: message.conversationId,
        title: 'Untitled chat',
        updatedAt: message.createdAt,
      })
    }

    this.removeMessage(message.id)
    const conversation = this.conversations.get(message.conversationId)
    const conversationUpdatedAt = conversation?.updatedAt ?? message.createdAt
    this.addDocument({
      id: `message:${message.id}`,
      conversationId: message.conversationId,
      messageId: message.id,
      field: 'message',
      text: message.content,
      createdAt: message.createdAt,
      conversationUpdatedAt,
    })

    let messageIds = this.messageIdsByConversation.get(message.conversationId)
    if (!messageIds) {
      messageIds = new Set()
      this.messageIdsByConversation.set(message.conversationId, messageIds)
    }
    messageIds.add(message.id)
  }

  removeMessage(messageId: string): void {
    const docIds = this.docIdsByMessage.get(messageId)
    for (const docId of docIds ?? []) {
      const doc = this.documents.get(docId)
      this.deleteDocument(docId)
      if (doc) this.messageIdsByConversation.get(doc.conversationId)?.delete(messageId)
    }
    this.docIdsByMessage.delete(messageId)
  }

  search(query: string, options?: { limit?: number }): ChatSearchResult {
    const queryTokens = normalizeChatSearchQuery(query)
    if (queryTokens.length === 0) return { query, conversations: [] }

    const candidates = new Map<string, { doc: StoredDocument; score: number }>()
    for (const token of queryTokens) {
      for (const [term, postings] of this.postings) {
        const isExact = term === token
        const isPrefix = !isExact && term.startsWith(token)
        if (!isExact && !isPrefix) continue

        for (const posting of postings.values()) {
          const doc = this.documents.get(posting.docId)
          if (!doc) continue
          const previous = candidates.get(doc.id)?.score ?? 0
          const fieldBoost = doc.field === 'title' ? 30 : doc.field === 'project' ? 18 : 0
          const matchBoost = isExact ? 80 : 45
          const frequencyBoost = Math.min(posting.frequency, 8) * 6
          candidates.set(doc.id, {
            doc,
            score: previous + matchBoost + fieldBoost + frequencyBoost,
          })
        }
      }
    }

    const grouped = new Map<string, ChatSearchConversationResult>()
    const now = Date.now()
    for (const { doc, score } of candidates.values()) {
      const conversation = this.conversations.get(doc.conversationId)
      if (!conversation) continue
      const recencyBoost = computeRecencyBoost(conversation.updatedAt, now)
      const ranges = highlightChatSearchText(doc.text, queryTokens)
      const hit: ChatSearchHit = {
        conversationId: doc.conversationId,
        messageId: doc.messageId,
        field: doc.field,
        score: score + recencyBoost,
        text: doc.text,
        snippet: buildChatSearchSnippet(doc.text, queryTokens),
        ranges,
        createdAt: doc.createdAt,
      }

      const existing = grouped.get(doc.conversationId)
      if (existing) {
        existing.score += hit.score
        existing.hits.push(hit)
      } else {
        grouped.set(doc.conversationId, {
          conversationId: doc.conversationId,
          title: conversation.title,
          projectName: conversation.projectName,
          updatedAt: conversation.updatedAt,
          score: hit.score,
          hits: [hit],
        })
      }
    }

    const conversations = Array.from(grouped.values())
      .map((result) => ({
        ...result,
        hits: result.hits
          .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
          .slice(0, MAX_HITS_PER_CONVERSATION),
      }))
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)

    return {
      query,
      conversations: conversations.slice(0, options?.limit ?? 50),
    }
  }

  private addDocument(document: ChatSearchDocument): void {
    this.deleteDocument(document.id)
    const tokens = countTokens(document.text)
    const stored: StoredDocument = { ...document, tokens }
    this.documents.set(document.id, stored)

    if (document.messageId) {
      addToSetMap(this.docIdsByMessage, document.messageId, document.id)
    } else {
      addToSetMap(this.docIdsByConversationMetadata, document.conversationId, document.id)
    }

    for (const [token, frequency] of tokens) {
      let tokenPostings = this.postings.get(token)
      if (!tokenPostings) {
        tokenPostings = new Map()
        this.postings.set(token, tokenPostings)
      }
      tokenPostings.set(document.id, { docId: document.id, frequency })
    }
  }

  private deleteConversationMetadataDocuments(conversationId: string): void {
    const docIds = this.docIdsByConversationMetadata.get(conversationId)
    for (const docId of docIds ?? []) {
      this.deleteDocument(docId)
    }
    this.docIdsByConversationMetadata.delete(conversationId)
  }

  private deleteDocument(docId: string): void {
    const existing = this.documents.get(docId)
    if (!existing) return
    this.documents.delete(docId)

    for (const token of existing.tokens.keys()) {
      const tokenPostings = this.postings.get(token)
      tokenPostings?.delete(docId)
      if (tokenPostings?.size === 0) this.postings.delete(token)
    }

    if (existing.messageId) {
      const messageDocs = this.docIdsByMessage.get(existing.messageId)
      messageDocs?.delete(docId)
      if (messageDocs?.size === 0) this.docIdsByMessage.delete(existing.messageId)
    } else {
      const metadataDocs = this.docIdsByConversationMetadata.get(existing.conversationId)
      metadataDocs?.delete(docId)
      if (metadataDocs?.size === 0) this.docIdsByConversationMetadata.delete(existing.conversationId)
    }
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9_]+/g) ?? []
}

function countTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(value)
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  return ranges
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .reduce<Array<{ start: number; end: number }>>((merged, range) => {
      const previous = merged[merged.length - 1]
      if (!previous || range.start > previous.end) {
        merged.push({ ...range })
      } else {
        previous.end = Math.max(previous.end, range.end)
      }
      return merged
    }, [])
}

function computeRecencyBoost(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, (now - updatedAt) / 86_400_000)
  return Math.max(0, 12 - ageDays)
}