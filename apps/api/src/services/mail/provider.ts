// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mail providers behind one interface. Resend today (sending, receiving,
 * domains, delivery webhooks); SES later; `fake` for tests and for a
 * desktop with no provider configured, where sends are recorded in memory.
 *
 * `MAIL_PROVIDER` picks one. Unset: Resend when `RESEND_API_KEY` is set,
 * otherwise fake.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { MailAddress } from './codec'
import { formatAddress } from './codec'

export interface ProviderDnsRecord {
  type: string
  name: string
  value: string
  priority?: number | null
  purpose: string
  status: string
}

export interface ProviderDomain {
  providerDomainId: string
  status: 'pending' | 'verifying' | 'active' | 'failed'
  records: ProviderDnsRecord[]
}

export interface OutboundAttachment {
  filename: string
  contentType: string
  content: Uint8Array
}

export interface OutboundEmail {
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  replyTo?: string | null
  subject: string
  text: string
  html: string
  messageId: string
  inReplyTo?: string | null
  references?: string | null
  attachments: OutboundAttachment[]
  /** Idempotency key: the MailMessage id, so a retried send is not delivered twice. */
  idempotencyKey: string
}

export interface ReceivedEmail {
  providerMessageId: string
  raw: Uint8Array
  envelopeTo: string[]
  auth: { spf?: string; dkim?: string; dmarc?: string } | null
}

export type DeliveryEventType = 'sent' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed'

export interface DeliveryEvent {
  type: DeliveryEventType
  providerMessageId: string
  recipients: string[]
  /** Hard bounce (the address does not exist), as opposed to a full mailbox or a transient failure. */
  permanent?: boolean
  detail?: string | null
}

export type WebhookEvent =
  | { kind: 'received'; providerMessageId: string }
  | { kind: 'delivery'; event: DeliveryEvent }
  | { kind: 'ignored'; type: string }

export interface MailProvider {
  readonly name: string
  createDomain(domain: string): Promise<ProviderDomain>
  getDomain(providerDomainId: string): Promise<ProviderDomain>
  verifyDomain(providerDomainId: string): Promise<ProviderDomain>
  deleteDomain(providerDomainId: string): Promise<void>
  send(email: OutboundEmail): Promise<{ providerMessageId: string }>
  fetchReceived(providerMessageId: string): Promise<ReceivedEmail>
  /** Verify a webhook request and read the event out of it; throws on a bad signature. */
  parseWebhook(rawBody: string, headers: (name: string) => string | undefined): WebhookEvent
}

export class MailProviderError extends Error {
  constructor(message: string, public status?: number, public retryable = false) {
    super(message)
  }
}

// ─── Resend ──────────────────────────────────────────────────────────────────

const RESEND_API = 'https://api.resend.com'

function mapResendStatus(status: unknown): ProviderDomain['status'] {
  switch (status) {
    case 'verified': return 'active'
    case 'pending': return 'verifying'
    case 'failed':
    case 'temporary_failure': return 'failed'
    default: return 'pending'
  }
}

function mapResendRecords(records: unknown): ProviderDnsRecord[] {
  if (!Array.isArray(records)) return []
  return records.map((r: any) => ({
    type: String(r?.type ?? ''),
    name: String(r?.name ?? ''),
    value: String(r?.value ?? ''),
    priority: typeof r?.priority === 'number' ? r.priority : null,
    purpose: String(r?.record ?? r?.type ?? ''),
    status: r?.status === 'verified' ? 'ok' : r?.status === 'failed' ? 'mismatch' : 'pending',
  }))
}

const encodeBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

/**
 * Svix signature check, as Resend signs its webhooks: HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the base64 secret after `whsec_`, any of
 * the space-separated `v1,<sig>` values may match, and the timestamp must be
 * within five minutes.
 */
export function verifySvixSignature(
  secret: string,
  rawBody: string,
  headers: (name: string) => string | undefined,
  nowMs = Date.now(),
): boolean {
  const id = headers('svix-id') ?? headers('webhook-id')
  const timestamp = headers('svix-timestamp') ?? headers('webhook-timestamp')
  const signatures = headers('svix-signature') ?? headers('webhook-signature')
  if (!id || !timestamp || !signatures) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 5 * 60) return false
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest()
  for (const part of signatures.split(' ')) {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) continue
    const given = Buffer.from(sig, 'base64')
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true
  }
  return false
}

export class ResendProvider implements MailProvider {
  readonly name = 'resend'

  constructor(private apiKey: string, private webhookSecret: string | null) {}

  private async call<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${RESEND_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'shogo-mail/1',
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      const message = data?.message ?? data?.error ?? (text.slice(0, 300) || `Resend returned ${res.status}`)
      throw new MailProviderError(String(message), res.status, res.status === 429 || res.status >= 500)
    }
    return data as T
  }

  private domainFrom(data: any): ProviderDomain {
    return { providerDomainId: String(data?.id ?? ''), status: mapResendStatus(data?.status), records: mapResendRecords(data?.records) }
  }

  async createDomain(domain: string): Promise<ProviderDomain> {
    const created = await this.call('POST', '/domains', {
      name: domain,
      capabilities: { sending: 'enabled', receiving: 'enabled' },
    })
    // People read their own mail here; no open or click tracking on it.
    await this.call('PATCH', `/domains/${encodeURIComponent(created.id)}`, { open_tracking: false, click_tracking: false }).catch(() => {})
    return this.domainFrom(created)
  }

  async getDomain(providerDomainId: string): Promise<ProviderDomain> {
    return this.domainFrom(await this.call('GET', `/domains/${encodeURIComponent(providerDomainId)}`))
  }

  async verifyDomain(providerDomainId: string): Promise<ProviderDomain> {
    await this.call('POST', `/domains/${encodeURIComponent(providerDomainId)}/verify`)
    return this.getDomain(providerDomainId)
  }

  async deleteDomain(providerDomainId: string): Promise<void> {
    await this.call('DELETE', `/domains/${encodeURIComponent(providerDomainId)}`)
  }

  async send(email: OutboundEmail): Promise<{ providerMessageId: string }> {
    const headers: Record<string, string> = { 'Message-ID': email.messageId }
    if (email.inReplyTo) headers['In-Reply-To'] = email.inReplyTo
    if (email.references) headers.References = email.references
    const data = await this.call(
      'POST',
      '/emails',
      {
        from: formatAddress(email.from),
        to: email.to.map(formatAddress),
        ...(email.cc.length ? { cc: email.cc.map(formatAddress) } : {}),
        ...(email.bcc.length ? { bcc: email.bcc.map(formatAddress) } : {}),
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers,
        ...(email.attachments.length
          ? { attachments: email.attachments.map((a) => ({ filename: a.filename, content: encodeBase64(a.content), content_type: a.contentType })) }
          : {}),
      },
      { 'Idempotency-Key': email.idempotencyKey },
    )
    return { providerMessageId: String(data?.id ?? '') }
  }

  async fetchReceived(providerMessageId: string): Promise<ReceivedEmail> {
    const data = await this.call('GET', `/emails/receiving/${encodeURIComponent(providerMessageId)}`)
    const url = data?.raw?.download_url
    if (typeof url !== 'string') throw new MailProviderError('The received email has no raw download', 502, true)
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new MailProviderError(`Could not download the received email (${res.status})`, res.status, true)
    const raw = new Uint8Array(await res.arrayBuffer())
    const envelopeTo = [
      ...(Array.isArray(data?.to) ? data.to : []),
      ...(Array.isArray(data?.received_for) ? data.received_for : []),
    ].filter((v): v is string => typeof v === 'string')
    const auth = data?.authentication && typeof data.authentication === 'object'
      ? { spf: data.authentication.spf, dkim: data.authentication.dkim, dmarc: data.authentication.dmarc }
      : null
    return { providerMessageId, raw, envelopeTo, auth }
  }

  parseWebhook(rawBody: string, headers: (name: string) => string | undefined): WebhookEvent {
    if (!this.webhookSecret) throw new MailProviderError('RESEND_WEBHOOK_SECRET is not set', 503)
    if (!verifySvixSignature(this.webhookSecret, rawBody, headers)) throw new MailProviderError('Bad webhook signature', 401)
    return parseResendEvent(JSON.parse(rawBody))
  }
}

/** Read a Resend webhook payload (already verified). */
export function parseResendEvent(payload: any): WebhookEvent {
  const type = String(payload?.type ?? '')
  const data = payload?.data ?? {}
  const id = String(data.email_id ?? data.id ?? '')
  const recipients: string[] = Array.isArray(data.to) ? data.to.filter((v: unknown): v is string => typeof v === 'string') : []
  switch (type) {
    case 'email.received':
      return { kind: 'received', providerMessageId: id }
    case 'email.sent':
      return { kind: 'delivery', event: { type: 'sent', providerMessageId: id, recipients } }
    case 'email.delivered':
      return { kind: 'delivery', event: { type: 'delivered', providerMessageId: id, recipients } }
    case 'email.delivery_delayed':
      return { kind: 'delivery', event: { type: 'delayed', providerMessageId: id, recipients } }
    case 'email.bounced': {
      const bounce = data.bounce ?? {}
      const permanent = /permanent|hard/i.test(String(bounce.type ?? '')) || /general|noemail|suppressed/i.test(String(bounce.subType ?? ''))
      return { kind: 'delivery', event: { type: 'bounced', providerMessageId: id, recipients, permanent, detail: bounce.message ?? null } }
    }
    case 'email.complained':
      return { kind: 'delivery', event: { type: 'complained', providerMessageId: id, recipients } }
    case 'email.failed':
      return { kind: 'delivery', event: { type: 'failed', providerMessageId: id, recipients, detail: data.failed?.reason ?? data.reason ?? null } }
    default:
      return { kind: 'ignored', type }
  }
}

// ─── Fake (tests, desktop without a provider) ────────────────────────────────

export class FakeMailProvider implements MailProvider {
  readonly name = 'fake'
  readonly sent: OutboundEmail[] = []
  readonly inbox = new Map<string, ReceivedEmail>()
  readonly domains = new Map<string, ProviderDomain & { name: string }>()
  /** Domains whose DNS a test has "published"; verify flips them to active. */
  readonly published = new Set<string>()
  failNextSend: string | null = null

  async createDomain(domain: string): Promise<ProviderDomain> {
    const id = `fake-domain-${crypto.randomUUID()}`
    const records: ProviderDnsRecord[] = [
      { type: 'TXT', name: 'resend._domainkey', value: 'p=FAKEKEY', purpose: 'DKIM', status: 'pending' },
      { type: 'MX', name: 'send', value: 'feedback-smtp.example.com', priority: 10, purpose: 'SPF', status: 'pending' },
      { type: 'TXT', name: 'send', value: 'v=spf1 include:example.com ~all', purpose: 'SPF', status: 'pending' },
      { type: 'MX', name: '@', value: 'inbound.example.com', priority: 10, purpose: 'Receiving', status: 'pending' },
    ]
    const row = { providerDomainId: id, status: 'pending' as const, records, name: domain }
    this.domains.set(id, row)
    return row
  }

  async getDomain(id: string): Promise<ProviderDomain> {
    const row = this.domains.get(id)
    if (!row) throw new MailProviderError('Domain not found', 404)
    return row
  }

  async verifyDomain(id: string): Promise<ProviderDomain> {
    const row = this.domains.get(id)
    if (!row) throw new MailProviderError('Domain not found', 404)
    const ok = this.published.has(row.name)
    const next = {
      ...row,
      status: ok ? ('active' as const) : ('verifying' as const),
      records: row.records.map((r) => ({ ...r, status: ok ? 'ok' : 'pending' })),
    }
    this.domains.set(id, next)
    return next
  }

  async deleteDomain(id: string): Promise<void> {
    this.domains.delete(id)
  }

  async send(email: OutboundEmail): Promise<{ providerMessageId: string }> {
    if (this.failNextSend) {
      const message = this.failNextSend
      this.failNextSend = null
      throw new MailProviderError(message, 422)
    }
    this.sent.push(email)
    return { providerMessageId: `fake-${email.idempotencyKey}` }
  }

  async fetchReceived(id: string): Promise<ReceivedEmail> {
    const row = this.inbox.get(id)
    if (!row) throw new MailProviderError('Received email not found', 404)
    return row
  }

  parseWebhook(rawBody: string): WebhookEvent {
    return parseResendEvent(JSON.parse(rawBody))
  }
}

let override: MailProvider | null = null
let cached: MailProvider | null = null

export function setMailProviderForTests(provider: MailProvider | null): void {
  override = provider
  cached = null
}

export function getMailProvider(): MailProvider {
  if (override) return override
  if (cached) return cached
  const choice = (process.env.MAIL_PROVIDER ?? '').toLowerCase()
  const apiKey = process.env.RESEND_API_KEY
  if ((choice === 'resend' || (!choice && apiKey)) && apiKey) {
    cached = new ResendProvider(apiKey, process.env.RESEND_WEBHOOK_SECRET ?? null)
  } else {
    cached = new FakeMailProvider()
  }
  return cached
}

/** The free shared domain every workspace gets, no DNS needed. */
export function sharedMailDomain(): string {
  return (process.env.SHOGO_MAIL_DOMAIN ?? 'mail.shogo.ai').trim().toLowerCase()
}
