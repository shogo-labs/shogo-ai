// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WhatsApp Channel Adapter — production-grade
 *
 * Connects to the WhatsApp Business Cloud API (Meta).
 *
 * Requirements:
 * - Meta Business App with WhatsApp product enabled
 * - Phone number ID and permanent system-user access token
 * - App Secret (from Basic Settings) for HMAC-SHA256 signature verification
 *
 * The adapter registers webhook routes on the agent runtime's Hono server
 * via the static `registerWebhookRoutes()` method, called once during server
 * setup. Routes are mounted at both
 *   /agent/channels/whatsapp/webhook  (canonical)
 *   /webhooks/whatsapp               (legacy alias)
 */

import { timingSafeEqual, createHmac, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, extname } from 'path'
import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'
import { transcribeAudioBuffer } from '../lib/transcribe'
import { WHATSAPP_GRAPH_VERSION, verifyMetaSignature } from '@shogo/shared-runtime/whatsapp-graph'

const WHATSAPP_API = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}`
const MEDIA_SIZE_CAP_BYTES = 25 * 1024 * 1024
const DEDUPE_MAX = 5_000
const DEDUPE_TTL_MS = 48 * 60 * 60 * 1000

// ─── Meta API helpers ────────────────────────────────────────────────────────

interface MetaErrorBody {
  error?: { code?: number; title?: string; message?: string }
}

class MetaApiError extends Error {
  constructor(
    readonly metaCode: number | undefined,
    readonly metaTitle: string | undefined,
    message: string
  ) {
    super(message)
    this.name = 'MetaApiError'
  }
}

async function graphPost(url: string, body: unknown, accessToken: string): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let parsed: MetaErrorBody = {}
    try { parsed = await res.json() } catch { /* ignore */ }
    const code = parsed.error?.code
    const title = parsed.error?.title
    const msg = parsed.error?.message || res.statusText
    throw new MetaApiError(code, title, `Meta API error ${res.status} (${code ?? ''}): ${msg}`)
  }
  return res.json()
}

// ─── Dedupe store ────────────────────────────────────────────────────────────

interface DedupeEntry { id: string; at: number }

class DedupeStore {
  private seen: Map<string, number> = new Map()
  private filePath: string | null

  constructor(workspaceDir: string | null) {
    this.filePath = workspaceDir
      ? join(workspaceDir, '.shogo', 'channels', 'whatsapp-seen.json')
      : null
    this.load()
  }

  private load() {
    if (!this.filePath || !existsSync(this.filePath)) return
    try {
      const entries: DedupeEntry[] = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      const cutoff = Date.now() - DEDUPE_TTL_MS
      for (const e of entries) {
        if (e.at > cutoff) this.seen.set(e.id, e.at)
      }
    } catch { /* corrupt file is a cold start */ }
  }

  private save() {
    if (!this.filePath) return
    try {
      const dir = this.filePath.split('/').slice(0, -1).join('/')
      mkdirSync(dir, { recursive: true })
      const entries: DedupeEntry[] = []
      const cutoff = Date.now() - DEDUPE_TTL_MS
      for (const [id, at] of this.seen) {
        if (at > cutoff) entries.push({ id, at })
      }
      writeFileSync(this.filePath, JSON.stringify(entries))
    } catch { /* non-fatal */ }
  }

  has(id: string): boolean {
    const at = this.seen.get(id)
    if (!at) return false
    if (Date.now() - at > DEDUPE_TTL_MS) {
      this.seen.delete(id)
      return false
    }
    return true
  }

  add(id: string) {
    if (this.seen.size >= DEDUPE_MAX) {
      // Evict oldest
      let oldest = Infinity
      let oldestKey = ''
      for (const [k, v] of this.seen) {
        if (v < oldest) { oldest = v; oldestKey = k }
      }
      this.seen.delete(oldestKey)
    }
    this.seen.set(id, Date.now())
    this.save()
  }
}

// ─── Paused-contact tracking ─────────────────────────────────────────────────

interface PauseEntry { until: number; timer: ReturnType<typeof setTimeout> }

// ─── Outbound status tracking ────────────────────────────────────────────────

interface StatusCounts { sent: number; delivered: number; read: number; failed: number }
interface FailureEntry { to: string; code: number | undefined; title: string | undefined; at: number }

// ─── Main adapter ────────────────────────────────────────────────────────────

export class WhatsAppAdapter implements ChannelAdapter {
  private accessToken: string = ''
  private phoneNumberId: string = ''
  private verifyToken: string = ''
  private appSecret: string = ''
  private handoffPauseMs: number = 720 * 60 * 1000
  private workspaceDir: string | null = null
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  private connected = false
  private error: string | undefined
  private displayPhoneNumber: string = ''
  private dedupe: DedupeStore | null = null

  // Platform (Meta Tech Provider) credential source
  /** 'own' = customer's own Meta app config (SHO-460 behaviour, default).
   *  'platform' = Shogo Tech Provider flow (SHO-463). Token is fetched from API.
   */
  private credentialSource: 'own' | 'platform' = 'own'
  private projectId: string = ''
  private wabaId: string = ''
  private coexistenceMode = false
  /** Contacts display-name map (populated from smb_app_state_sync webhooks) */
  private contactNames: Map<string, string> = new Map()

  private statusCounts: StatusCounts = { sent: 0, delivered: 0, read: 0, failed: 0 }
  private lastFailure: FailureEntry | null = null
  private pausedContacts: Map<string, PauseEntry> = new Map()
  // last inbound msg id per contact — used for sendTyping
  private lastInboundMsgId: Map<string, string> = new Map()
  // per-phone outbound message queue (maintains order per contact)
  private sendQueues: Map<string, Promise<void>> = new Map()

  /** Singleton map: phoneNumberId -> adapter instance (for webhook routing) */
  static instances = new Map<string, WhatsAppAdapter>()

  constructor(config?: Record<string, string>) {
    if (config?.accessToken) this.accessToken = config.accessToken
    if (config?.phoneNumberId) this.phoneNumberId = config.phoneNumberId
    if (config?.verifyToken) this.verifyToken = config.verifyToken
    if (config?.appSecret) this.appSecret = config.appSecret
    if (config?._workspaceDir) this.workspaceDir = config._workspaceDir
    if (config?.handoffPauseMinutes) {
      this.handoffPauseMs = parseInt(config.handoffPauseMinutes, 10) * 60 * 1000
    }
    if (config?.credentialSource === 'platform') {
      this.credentialSource = 'platform'
      this.projectId = config.projectId || ''
      this.wabaId = config.wabaId || ''
      this.displayPhoneNumber = config.displayPhoneNumber || ''
    }
  }

  /**
   * Fetch the access token from the internal API for platform-credential channels.
   * Token is kept in memory only.
   */
  private async fetchPlatformToken(): Promise<void> {
    const { deriveApiUrl, getInternalHeaders } = await import('../internal-api')
    const apiUrl = deriveApiUrl()
    if (!apiUrl) throw new Error('Cannot fetch WhatsApp credentials: API URL is not configured')
    const path = `/api/internal/projects/${encodeURIComponent(this.projectId)}/channels/whatsapp/credentials?phoneNumberId=${encodeURIComponent(this.phoneNumberId)}`
    const res = await fetch(`${apiUrl}${path}`, { headers: getInternalHeaders(), signal: AbortSignal.timeout(10_000) })
    const json = await res.json().catch(() => null) as any
    if (!res.ok) throw new Error(json?.error ?? `WhatsApp credentials fetch failed: HTTP ${res.status}`)
    this.accessToken = json.accessToken
    if (json.wabaId) this.wabaId = json.wabaId
  }

  async connect(config: Record<string, string>): Promise<void> {
    if (config.credentialSource === 'platform') {
      this.credentialSource = 'platform'
      this.phoneNumberId = config.phoneNumberId
      this.projectId = config.projectId || ''
      this.wabaId = config.wabaId || ''
      this.displayPhoneNumber = config.displayPhoneNumber || ''
      if (config.handoffPauseMinutes) {
        this.handoffPauseMs = parseInt(config.handoffPauseMinutes, 10) * 60 * 1000
      }
      if (config._workspaceDir) this.workspaceDir = config._workspaceDir

      if (!this.phoneNumberId) throw new Error('WhatsApp phone number ID is required')
      await this.fetchPlatformToken()

      this.dedupe = new DedupeStore(this.workspaceDir)
      WhatsAppAdapter.instances.set(this.phoneNumberId, this)
      this.connected = true
      this.error = undefined
      console.log(`[WhatsApp/platform] Connected as ${this.displayPhoneNumber || this.phoneNumberId}`)
      return
    }

    this.accessToken = config.accessToken
    this.phoneNumberId = config.phoneNumberId
    this.appSecret = config.appSecret || ''
    if (config.handoffPauseMinutes) {
      this.handoffPauseMs = parseInt(config.handoffPauseMinutes, 10) * 60 * 1000
    }
    if (config._workspaceDir) this.workspaceDir = config._workspaceDir

    if (!this.accessToken) throw new Error('WhatsApp access token is required')
    if (!this.phoneNumberId) throw new Error('WhatsApp phone number ID is required')
    if (!this.appSecret) throw new Error('WhatsApp appSecret is required — add it from Meta App → Basic Settings → App Secret')

    // Auto-generate a verifyToken if one was not provided
    this.verifyToken = config.verifyToken || randomBytes(16).toString('hex')

    const res = await fetch(`${WHATSAPP_API}/${this.phoneNumberId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`WhatsApp API validation failed: ${err}`)
    }

    const data = (await res.json()) as { display_phone_number?: string; verified_name?: string }
    this.displayPhoneNumber = data.display_phone_number || this.phoneNumberId
    console.log(`[WhatsApp] Connected as ${data.verified_name || this.displayPhoneNumber}`)

    this.dedupe = new DedupeStore(this.workspaceDir)
    WhatsAppAdapter.instances.set(this.phoneNumberId, this)
    this.connected = true
    this.error = undefined
  }

  async disconnect(): Promise<void> {
    WhatsAppAdapter.instances.delete(this.phoneNumberId)
    for (const entry of this.pausedContacts.values()) clearTimeout(entry.timer)
    this.pausedContacts.clear()
    this.connected = false
    console.log('[WhatsApp] Disconnected')
  }

  /** For platform channels: re-fetch token once on 190/401, then propagate. */
  private async graphPostWithTokenRefresh(url: string, body: unknown): Promise<unknown> {
    try {
      return await graphPost(url, body, this.accessToken)
    } catch (err: any) {
      if (this.credentialSource === 'platform' && (err?.metaCode === 190 || err?.message?.includes('401'))) {
        await this.fetchPlatformToken()
        return graphPost(url, body, this.accessToken)
      }
      throw err
    }
  }

  async sendMessage(recipientPhone: string, content: string): Promise<void> {
    if (!this.accessToken) throw new Error('Not connected')
    // Split into chunks of ≤4096 chars
    const chunks: string[] = []
    for (let i = 0; i < content.length; i += 4096) {
      chunks.push(content.slice(i, i + 4096))
    }
    // Queue sends per contact to maintain ordering
    const prev = this.sendQueues.get(recipientPhone) ?? Promise.resolve()
    const next = prev.then(async () => {
      for (const chunk of chunks) {
        await graphPost(`${WHATSAPP_API}/${this.phoneNumberId}/messages`, {
          messaging_product: 'whatsapp',
          to: recipientPhone,
          type: 'text',
          text: { body: chunk },
        }, this.accessToken)
      }
    }).catch((err: MetaApiError | Error) => {
      const extra = err instanceof MetaApiError && err.metaCode === 131047
        ? ' — recipient is outside the 24-hour window; use a template message'
        : ''
      throw new Error(`${err.message}${extra}`)
    })
    this.sendQueues.set(recipientPhone, next.catch(() => {}))
    await next
  }

  async sendTemplate(
    recipientPhone: string,
    template: { name: string; language: string; components?: unknown[] }
  ): Promise<void> {
    if (!this.accessToken) throw new Error('Not connected')
    await graphPost(`${WHATSAPP_API}/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        components: template.components || [],
      },
    }, this.accessToken)
  }

  async sendTyping(channelId: string): Promise<void> {
    const msgId = this.lastInboundMsgId.get(channelId)
    if (!msgId || !this.accessToken) return
    try {
      await graphPost(`${WHATSAPP_API}/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: msgId,
        typing_indicator: { type: 'text' },
      }, this.accessToken)
    } catch { /* typing is best-effort */ }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    const paused = Array.from(this.pausedContacts.entries()).map(([phone, e]) => ({
      phone,
      resumesAt: new Date(e.until).toISOString(),
    }))
    return {
      type: 'whatsapp',
      connected: this.connected,
      error: (this.credentialSource === 'own' && !this.appSecret && this.connected) ? 'add appSecret to receive messages' : this.error,
      metadata: {
        phoneNumberId: this.phoneNumberId,
        displayNumber: this.displayPhoneNumber,
        verifyToken: this.verifyToken,
        statusCounts: this.statusCounts,
        lastFailure: this.lastFailure,
        pausedContacts: paused,
        credentialSource: this.credentialSource,
        ...(this.credentialSource === 'platform' ? {
          wabaId: this.wabaId,
          coexistence: this.coexistenceMode,
        } : {}),
      },
    }
  }

  // ── Coexistence helpers ───────────────────────────────────────────────────

  /** Persist contact names to disk so they survive restarts. */
  private saveContactNames() {
    if (!this.workspaceDir || this.contactNames.size === 0) return
    try {
      const filePath = join(this.workspaceDir, '.shogo', 'channels', 'whatsapp-contacts.json')
      mkdirSync(join(this.workspaceDir, '.shogo', 'channels'), { recursive: true })
      writeFileSync(filePath, JSON.stringify(Object.fromEntries(this.contactNames)), 'utf-8')
    } catch { /* non-fatal */ }
  }

  private pauseContact(phone: string) {
    const existing = this.pausedContacts.get(phone)
    if (existing) clearTimeout(existing.timer)
    const until = Date.now() + this.handoffPauseMs
    const timer = setTimeout(() => this.pausedContacts.delete(phone), this.handoffPauseMs)
    this.pausedContacts.set(phone, { until, timer })
  }

  resumeContact(phone: string) {
    const entry = this.pausedContacts.get(phone)
    if (entry) clearTimeout(entry.timer)
    this.pausedContacts.delete(phone)
  }

  private isContactPaused(phone: string): boolean {
    const entry = this.pausedContacts.get(phone)
    if (!entry) return false
    if (Date.now() >= entry.until) {
      clearTimeout(entry.timer)
      this.pausedContacts.delete(phone)
      return false
    }
    return true
  }

  // ── Media helpers ─────────────────────────────────────────────────────────

  private async downloadMedia(mediaId: string): Promise<{
    buffer: Buffer
    mimeType: string
    ext: string
  } | null> {
    if (!this.accessToken) return null
    try {
      // Step 1: resolve the URL
      const metaRes = await fetch(`${WHATSAPP_API}/${mediaId}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      })
      if (!metaRes.ok) return null
      const meta = (await metaRes.json()) as {
        url?: string
        mime_type?: string
        file_size?: number
      }
      if (!meta.url) return null
      if (meta.file_size && meta.file_size > MEDIA_SIZE_CAP_BYTES) return null

      // Step 2: download the binary
      const dlRes = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(60_000),
      })
      if (!dlRes.ok) return null

      const contentLength = parseInt(dlRes.headers.get('content-length') || '0', 10)
      if (contentLength > MEDIA_SIZE_CAP_BYTES) return null

      const arrayBuf = await dlRes.arrayBuffer()
      const buffer = Buffer.from(arrayBuf)

      const mime = meta.mime_type || dlRes.headers.get('content-type') || ''
      const ext = mimeToExt(mime)
      return { buffer, mimeType: mime, ext }
    } catch { return null }
  }

  private saveMediaFile(msgId: string, buffer: Buffer, ext: string): string | null {
    if (!this.workspaceDir) return null
    try {
      const dateStr = new Date().toISOString().slice(0, 10)
      const dir = join(this.workspaceDir, 'files', 'whatsapp', dateStr)
      mkdirSync(dir, { recursive: true })
      const fileName = `${msgId}${ext}`
      const filePath = join(dir, fileName)
      writeFileSync(filePath, buffer)
      return `files/whatsapp/${dateStr}/${fileName}`
    } catch { return null }
  }

  // ── Status helpers ────────────────────────────────────────────────────────

  private markRead(msgId: string, to: string) {
    if (!this.accessToken) return
    // fire-and-forget
    graphPost(`${WHATSAPP_API}/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: msgId,
    }, this.accessToken).catch(() => {})
  }

  // ── Webhook processing ────────────────────────────────────────────────────

  /**
   * Process an incoming webhook payload. Called from the POST route after
   * the 200 ACK has already been sent.
   */
  async handleWebhook(body: any): Promise<void> {
    if (!body?.entry) return

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const { field, value } = change

        // ── Delivery statuses ────────────────────────────────────────────
        if (field === 'messages' && value?.statuses) {
          for (const st of value.statuses) {
            if (!st?.status) continue
            const dedupeKey = `status:${st.id}:${st.status}`
            if (this.dedupe?.has(dedupeKey)) continue
            this.dedupe?.add(dedupeKey)

            switch (st.status) {
              case 'sent': this.statusCounts.sent++; break
              case 'delivered': this.statusCounts.delivered++; break
              case 'read': this.statusCounts.read++; break
              case 'failed': {
                this.statusCounts.failed++
                this.lastFailure = {
                  to: st.recipient_id,
                  code: st.errors?.[0]?.code,
                  title: st.errors?.[0]?.title,
                  at: Date.now(),
                }
                break
              }
            }
          }
        }

        // ── Owner echo → pause bot for that contact ───────────────────────
        if (field === 'smb_message_echoes' && value?.messages) {
          for (const msg of value.messages) {
            const to = msg.to || msg.recipient_id
            if (!to) continue
            const dedupeKey = `echo:${msg.id}`
            if (this.dedupe?.has(dedupeKey)) continue
            this.dedupe?.add(dedupeKey)

            this.pauseContact(to)
            // Write the echo as a suppress-turn message so context is preserved
            this.messageHandler?.({
              text: `[Owner replied from WhatsApp Business app]: ${msg.text?.body || '(media)'}`,
              channelId: to,
              channelType: 'whatsapp',
              senderId: 'owner',
              senderName: 'Owner',
              timestamp: Date.now(),
              metadata: { suppressTurn: true },
            })
          }
          continue
        }

        // ── Coexistence: history webhook ─────────────────────────────────
        if (field === 'history' && value?.messages) {
          const MAX_HISTORY = 100
          const msgs = Array.isArray(value.messages) ? value.messages.slice(-MAX_HISTORY) : []
          for (const msg of msgs) {
            const from = msg.from ?? msg.wa_id ?? 'unknown'
            const text = msg.text?.body || msg.caption || `[${msg.type ?? 'media'}]`
            const ts = msg.timestamp ? parseInt(msg.timestamp, 10) * 1000 : Date.now()
            this.messageHandler?.({
              text,
              channelId: from,
              channelType: 'whatsapp',
              senderId: msg.from_me ? 'owner' : from,
              senderName: msg.from_me ? 'Owner' : (this.contactNames.get(from) || from),
              timestamp: ts,
              metadata: { suppressTurn: true, historical: true },
            })
          }
          continue
        }

        // ── Coexistence: contact sync ────────────────────────────────────
        if (field === 'smb_app_state_sync' && value?.contacts) {
          for (const contact of (value.contacts as any[])) {
            const id = contact.wa_id ?? contact.id
            const name = contact.profile?.name ?? contact.name
            if (id && name) this.contactNames.set(id, name)
          }
          this.saveContactNames()
          continue
        }

        // ── account_update PARTNER_REMOVED ────────────────────────────────
        if (field === 'account_update' && value?.event === 'PARTNER_REMOVED') {
          this.error = `WhatsApp access was revoked — reconnect (${value.disconnection_info?.reason ?? 'partner_removed'})`
          this.connected = false
          continue
        }

        // ── Inbound messages ──────────────────────────────────────────────
        if (field !== 'messages' || !value?.messages) continue

        const phoneNumberId = value.metadata?.phone_number_id
        if (phoneNumberId && phoneNumberId !== this.phoneNumberId) continue

        for (const msg of value.messages) {
          if (!msg?.id) continue

          // Dedupe
          if (this.dedupe?.has(msg.id)) continue
          this.dedupe?.add(msg.id)

          // In coexistence, `from` may be absent and only a business-scoped `user_id` present.
          const from = (msg.from || msg.user_id) as string
          const contact = value.contacts?.find((c: any) => c.wa_id === from || c.user_id === from)
          const senderName = contact?.profile?.name || this.contactNames.get(from) || from
          const ts = msg.timestamp ? parseInt(msg.timestamp, 10) * 1000 : Date.now()

          this.lastInboundMsgId.set(from, msg.id)
          this.markRead(msg.id, from)

          let text = ''
          let metadata: Record<string, unknown> = {}

          switch (msg.type) {
            case 'text': {
              text = msg.text?.body || ''
              if (msg.context?.id) metadata.replyTo = msg.context.id
              break
            }
            case 'audio': {
              const media = await this.downloadMedia(msg.audio?.id)
              if (media) {
                const filePath = this.saveMediaFile(msg.id, media.buffer, media.ext)
                const transcription = await transcribeAudioBuffer(media.buffer, { ext: media.ext })
                if ('error' in transcription) {
                  text = filePath ? `[Voice note — ${filePath}]` : '[Voice note — could not download]'
                } else {
                  const dur = transcription.duration ? `${Math.round(transcription.duration)}s` : ''
                  text = filePath
                    ? `[Voice note ${dur} — ${filePath}] ${transcription.text}`
                    : `[Voice note ${dur}] ${transcription.text}`
                }
              } else {
                text = '[Voice note — over size limit or unavailable]'
              }
              break
            }
            case 'image':
            case 'video':
            case 'sticker': {
              const mediaData = msg[msg.type] as any
              const media = await this.downloadMedia(mediaData?.id)
              const caption = mediaData?.caption || ''
              if (media) {
                const filePath = this.saveMediaFile(msg.id, media.buffer, media.ext)
                text = caption
                  ? `${caption}\n[${msg.type.charAt(0).toUpperCase() + msg.type.slice(1)} attached: ${filePath || 'unavailable'}]`
                  : `[${msg.type.charAt(0).toUpperCase() + msg.type.slice(1)} attached: ${filePath || 'unavailable'}]`
              } else {
                text = caption
                  ? `${caption}\n[${msg.type} — over size limit or unavailable]`
                  : `[${msg.type} — over size limit or unavailable]`
              }
              break
            }
            case 'document': {
              const doc = msg.document as any
              const media = await this.downloadMedia(doc?.id)
              const caption = doc?.caption || ''
              const filename = doc?.filename || 'document'
              if (media) {
                const filePath = this.saveMediaFile(msg.id, media.buffer, media.ext || extname(filename))
                text = caption
                  ? `${caption}\n[Document: ${filename} — ${filePath || 'unavailable'}]`
                  : `[Document: ${filename} — ${filePath || 'unavailable'}]`
              } else {
                text = `[Document: ${filename} — over size limit or unavailable]`
              }
              break
            }
            case 'location': {
              const loc = msg.location as any
              const name = loc?.name ? `${loc.name}, ` : ''
              const address = loc?.address ? `${loc.address} ` : ''
              text = `[Location: ${name}${address}(${loc?.latitude},${loc?.longitude})]`
              break
            }
            case 'contacts': {
              const contacts = (msg.contacts as any[]) || []
              const names = contacts.map((c: any) => {
                const phone = c.phones?.[0]?.phone || ''
                return `${c.name?.formatted_name || 'Unknown'}${phone ? ` (${phone})` : ''}`
              })
              text = `[Contacts: ${names.join(', ')}]`
              break
            }
            case 'interactive': {
              const inter = msg.interactive as any
              if (inter?.type === 'button_reply') {
                text = inter.button_reply.title
                metadata.interactiveId = inter.button_reply.id
              } else if (inter?.type === 'list_reply') {
                text = inter.list_reply.title
                metadata.interactiveId = inter.list_reply.id
              } else {
                text = '[Interactive message]'
              }
              break
            }
            case 'button': {
              // Template quick-reply
              text = msg.button?.text || '[Button reply]'
              metadata.buttonPayload = msg.button?.payload
              break
            }
            case 'reaction': {
              // Log only, no turn
              console.log(`[WhatsApp] Reaction ${msg.reaction?.emoji} on message ${msg.reaction?.message_id}`)
              continue
            }
            default: {
              // 131060 is expected coexistence noise — log only
              const errorCode = msg.errors?.[0]?.code
              if (errorCode === 131060) {
                continue
              }
              console.log(`[WhatsApp] Unsupported message type: ${msg.type}`)
              continue
            }
          }

          // /resume command
          if (text.trim() === '/resume') {
            this.resumeContact(from)
            // Send confirmation and don't run a turn
            this.sendMessage(from, 'Bot resumed. The agent will now reply to your messages.').catch(() => {})
            continue
          }

          const suppressTurn = this.isContactPaused(from)
          this.messageHandler?.({
            text,
            channelId: from,
            channelType: 'whatsapp',
            senderId: from,
            senderName,
            timestamp: ts,
            metadata: { ...metadata, suppressTurn: suppressTurn || undefined },
          })
        }
      }
    }
  }

  /**
   * Register WhatsApp webhook routes on the Hono app.
   * Called once during server setup.
   * Mounts both /agent/channels/whatsapp/webhook (canonical) and
   * /webhooks/whatsapp (legacy alias).
   */
  static registerWebhookRoutes(app: any): void {
    function handleGet(c: any) {
      const mode = c.req.query('hub.mode')
      const token = c.req.query('hub.verify_token')
      const challenge = c.req.query('hub.challenge')

      if (mode !== 'subscribe' || !token) return c.text('Forbidden', 403)

      // Route to the adapter whose verifyToken matches — constant-time compare
      for (const adapter of WhatsAppAdapter.instances.values()) {
        if (!adapter.verifyToken) continue
        const expected = Buffer.from(adapter.verifyToken)
        const received = Buffer.from(token)
        if (
          expected.length === received.length &&
          timingSafeEqual(expected, received)
        ) {
          console.log('[WhatsApp] Webhook verified')
          return c.text(challenge)
        }
      }
      return c.text('Forbidden', 403)
    }

    async function handlePost(c: any) {
      // ── 1. Signature verification ─────────────────────────────────────
      const sigHeader = c.req.header('x-hub-signature-256') || ''
      const rawBody = await c.req.text()

      // Find the adapter for this payload (by phone_number_id in first entry)
      let body: any
      try { body = JSON.parse(rawBody) } catch {
        return c.text('Bad Request', 400)
      }

      // Try to route by phone_number_id to pick the right appSecret
      const phoneId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id
      const adapter = phoneId
        ? WhatsAppAdapter.instances.get(phoneId)
        : undefined

      if (!adapter || !adapter.appSecret) {
        // No adapter or missing appSecret — 403
        return c.text('Forbidden', 403)
      }

      // Verify the HMAC
      const expected = `sha256=${createHmac('sha256', adapter.appSecret).update(rawBody).digest('hex')}`
      const receivedBuf = Buffer.from(sigHeader)
      const expectedBuf = Buffer.from(expected)
      if (
        receivedBuf.length !== expectedBuf.length ||
        !timingSafeEqual(receivedBuf, expectedBuf)
      ) {
        console.warn('[WhatsApp] Signature mismatch')
        return c.text('Forbidden', 403)
      }

      // ── 2. Acknowledge immediately ────────────────────────────────────
      // All processing happens after responding 200

      // ── 3. Route each entry/change to the right adapter ──────────────
      setImmediate(() => {
        // Fan out: each entry/change may have a different phone_number_id
        for (const entry of (body.entry || [])) {
          for (const change of (entry.changes || [])) {
            const changePhoneId = change?.value?.metadata?.phone_number_id
            const targetAdapter = changePhoneId
              ? WhatsAppAdapter.instances.get(changePhoneId)
              : adapter
            if (targetAdapter) {
              targetAdapter.handleWebhook({ entry: [{ ...entry, changes: [change] }] })
                .catch((err) => console.error('[WhatsApp] handleWebhook error:', err))
            }
          }
        }
      })

      return c.text('OK', 200)
    }

    // Canonical path
    app.get('/agent/channels/whatsapp/webhook', handleGet)
    app.post('/agent/channels/whatsapp/webhook', handlePost)
    // Legacy alias
    app.get('/webhooks/whatsapp', handleGet)
    app.post('/webhooks/whatsapp', handlePost)

    // ── Platform relay route (SHO-463) ─────────────────────────────────
    // Receives already-verified payloads from the platform webhook on the API.
    // The API has already checked the HMAC; this is behind runtime-token auth
    // (not isPublicChannelIngressPath).
    app.post('/agent/channels/whatsapp/relay', async (c: any) => {
      let body: any
      try { body = await c.req.json() } catch { return c.text('Bad Request', 400) }

      setImmediate(() => {
        for (const entry of (body.entry || [])) {
          for (const change of (entry.changes || [])) {
            const changePhoneId = change?.value?.metadata?.phone_number_id
            if (changePhoneId) {
              const targetAdapter = WhatsAppAdapter.instances.get(changePhoneId)
              if (targetAdapter) {
                targetAdapter.handleWebhook({ entry: [{ ...entry, changes: [change] }] })
                  .catch((err: any) => console.error('[WhatsApp/relay] handleWebhook error:', err))
              }
            }
          }
        }
      })

      return c.text('OK', 200)
    })
  }

  /**
   * Reconcile platform bindings on gateway start.
   * Called by the channel gateway after all channels from config.json have been loaded.
   * Fetches the API's binding list for this project and hot-connects any that are missing.
   */
  static async reconcilePlatformBindings(opts: {
    projectId: string
    connectChannel: (type: string, config: Record<string, string>) => Promise<void>
  }): Promise<void> {
    if (!opts.projectId) return
    const { deriveApiUrl, getInternalHeaders } = await import('../internal-api')
    const apiUrl = deriveApiUrl()
    if (!apiUrl) return

    try {
      const res = await fetch(
        `${apiUrl}/api/internal/projects/${encodeURIComponent(opts.projectId)}/channels/whatsapp/bindings`,
        { headers: getInternalHeaders(), signal: AbortSignal.timeout(10_000) },
      )
      if (!res.ok) return
      const { bindings } = await res.json() as { bindings: Array<{
        phoneNumberId: string; wabaId: string; displayPhoneNumber?: string;
        status: string; statusReason?: string;
      }> }

      for (const binding of bindings) {
        const existing = WhatsAppAdapter.instances.get(binding.phoneNumberId)
        if (existing) {
          // Already connected; update status if needed
          if (binding.status === 'disconnected' || binding.status === 'needs_reconnect') {
            existing.error = `WhatsApp access was revoked — reconnect (${binding.statusReason ?? binding.status})`
            existing.connected = false
          }
          continue
        }

        if (binding.status !== 'active') continue

        await opts.connectChannel('whatsapp', {
          credentialSource: 'platform',
          phoneNumberId: binding.phoneNumberId,
          wabaId: binding.wabaId,
          displayPhoneNumber: binding.displayPhoneNumber ?? '',
          projectId: opts.projectId,
        }).catch((err: any) => {
          console.warn(`[WhatsApp/reconcile] Failed to reconnect ${binding.phoneNumberId}:`, err?.message)
        })
      }
    } catch (err: any) {
      console.warn('[WhatsApp/reconcile] Binding reconcile failed:', err?.message)
    }
  }
}

// ─── Mime → extension map ────────────────────────────────────────────────────

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/webm': '.webm',
    'audio/aac': '.aac',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
    'application/pdf': '.pdf',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  }
  const base = mime.split(';')[0].trim().toLowerCase()
  return map[base] || '.bin'
}
