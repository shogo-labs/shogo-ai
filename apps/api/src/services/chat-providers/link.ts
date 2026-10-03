// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signed, short-lived tokens for connecting chat apps that have no OAuth
 * install of their own (Teams, Google Chat) and for linking a chat account
 * to a Shogo user.
 *
 * Connect: an admin gets a code in Shogo and sends `@Shogo connect <code>`
 * from the chat app, which binds that tenant to the workspace.
 * Link: an unlinked person gets a private button to /auth/chat-link, which
 * binds their chat account to whoever signs in.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { getFrontendUrl } from '../../lib/cloud-urls'
import type { ExternalChatProvider } from '../chat-mode'

const CONNECT_TTL_MS = 30 * 60 * 1000
const LINK_TTL_MS = 30 * 60 * 1000

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET || process.env.CHAT_LINK_SECRET || ''
  if (!value) throw new Error('BETTER_AUTH_SECRET is required for chat connect and link tokens')
  return value
}

function sign(kind: string, payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', secret()).update(`${kind}.${encoded}`).digest('base64url')
  return `${encoded}.${mac}`
}

function open<T>(kind: string, token: string | null | undefined): T | null {
  const [encoded, mac] = (token ?? '').trim().split('.')
  if (!encoded || !mac) return null
  let expected: Buffer
  try {
    expected = Buffer.from(createHmac('sha256', secret()).update(`${kind}.${encoded}`).digest('base64url'))
  } catch {
    return null
  }
  const given = Buffer.from(mac)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (typeof payload?.exp !== 'number' || payload.exp < Date.now()) return null
    return payload as T
  } catch {
    return null
  }
}

export interface ConnectCode {
  workspaceId: string
  provider: ExternalChatProvider
  userId: string
  exp: number
  nonce: string
}

export function createConnectCode(input: Omit<ConnectCode, 'exp' | 'nonce'>): { code: string; expiresAt: Date } {
  const exp = Date.now() + CONNECT_TTL_MS
  return { code: sign('connect', { ...input, exp, nonce: randomUUID().slice(0, 8) }), expiresAt: new Date(exp) }
}

export function verifyConnectCode(code: string | null | undefined): ConnectCode | null {
  return open<ConnectCode>('connect', code)
}

/** `connect <code>` as the whole message (after the app mention is stripped). */
export function parseConnectCommand(text: string): string | null {
  const match = /^\s*connect\s+(\S+)\s*$/i.exec(text)
  return match ? match[1] : null
}

export interface LinkState {
  provider: ExternalChatProvider
  tenantId: string
  externalUserId: string
  displayName: string | null
  channelId: string | null
  messageId: string | null
  exp: number
}

export function createLinkState(input: Omit<LinkState, 'exp'>): string {
  return sign('link', { ...input, exp: Date.now() + LINK_TTL_MS })
}

export function verifyLinkState(state: string | null | undefined): LinkState | null {
  return open<LinkState>('link', state)
}

export function chatLinkUrl(input: Omit<LinkState, 'exp'>): string {
  return `${getFrontendUrl()}/auth/chat-link?state=${encodeURIComponent(createLinkState(input))}`
}
