// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helpers for Shogo Mail: addresses, subjects, Message-IDs, the JSON
 * columns, and the `blocks.email` shape the chat UI renders. No database, no
 * network, so every rule here is unit-tested on its own.
 */

export interface MailAddress {
  address: string
  name?: string | null
}

export interface MailAttachmentMeta {
  name: string
  mimeType: string
  size: number
  attachmentId?: string | null
}

export interface MailAuthResults {
  spf?: string
  dkim?: string
  dmarc?: string
}

export type MailStatus =
  | 'received' | 'draft' | 'pending_approval' | 'scheduled' | 'sending' | 'sent'
  | 'delivered' | 'bounced' | 'complained' | 'failed' | 'cancelled'

export interface EmailBlock {
  mailId: string
  threadId: string | null
  mailboxId: string
  direction: 'inbound' | 'outbound'
  status: MailStatus
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  hasHtml: boolean
  auth?: MailAuthResults | null
  attachments: MailAttachmentMeta[]
  sendAfter?: string | null
  draftedBy?: string | null
  error?: string | null
  untrusted?: boolean
}

const ADDRESS_RE = /^[^\s@<>()",;:]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase()
}

export function isValidAddress(value: string): boolean {
  return ADDRESS_RE.test(value.trim()) && value.length <= 254
}

export function isValidDomain(value: string): boolean {
  return DOMAIN_RE.test(value.trim().toLowerCase())
}

export function isValidLocalPart(value: string): boolean {
  return LOCAL_PART_RE.test(value) && !value.includes('..')
}

export function domainOf(address: string): string {
  return normalizeAddress(address).split('@')[1] ?? ''
}

/**
 * Parse one recipient as people type or paste it: `a@b.com`, `Name <a@b.com>`
 * or `"Last, First" <a@b.com>`. Null when there is no valid address.
 */
export function parseAddress(raw: unknown): MailAddress | null {
  if (raw && typeof raw === 'object') {
    const obj = raw as { address?: unknown; email?: unknown; name?: unknown }
    const address = typeof obj.address === 'string' ? obj.address : typeof obj.email === 'string' ? obj.email : ''
    if (!isValidAddress(address)) return null
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : null
    return { address: normalizeAddress(address), name }
  }
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  const angle = text.match(/^(.*)<([^<>]+)>\s*$/)
  if (angle) {
    const address = angle[2].trim()
    if (!isValidAddress(address)) return null
    const name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim()
    return { address: normalizeAddress(address), name: name || null }
  }
  return isValidAddress(text) ? { address: normalizeAddress(text), name: null } : null
}

/**
 * Parse a recipient list: an array, or one string separated by commas or
 * semicolons. Duplicates are dropped (first one wins); `invalid` lists what
 * could not be read so the caller can refuse instead of silently dropping it.
 */
export function parseAddressList(raw: unknown): { addresses: MailAddress[]; invalid: string[] } {
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? splitAddressString(raw)
      : []
  const seen = new Set<string>()
  const addresses: MailAddress[] = []
  const invalid: string[] = []
  for (const item of items) {
    if (typeof item === 'string' && !item.trim()) continue
    const parsed = parseAddress(item)
    if (!parsed) {
      invalid.push(typeof item === 'string' ? item : JSON.stringify(item))
      continue
    }
    if (seen.has(parsed.address)) continue
    seen.add(parsed.address)
    addresses.push(parsed)
  }
  return { addresses, invalid }
}

/** Split on commas and semicolons that are not inside quotes or angle brackets. */
function splitAddressString(value: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  let angle = false
  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<') angle = true
    else if (ch === '>') angle = false
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** `Name <a@b.com>` with the name quoted when it needs to be. */
export function formatAddress(a: MailAddress): string {
  if (!a.name) return a.address
  const name = /[",;:<>@()[\]\\]/.test(a.name) ? `"${a.name.replace(/["\\]/g, '\\$&')}"` : a.name
  return `${name} <${a.address}>`
}

const REPLY_PREFIX_RE = /^\s*((re|fw|fwd|aw|wg|sv|vs|antw)\s*(\[\d+\])?\s*:\s*)+/i

/** The subject with Re:/Fwd: prefixes and extra whitespace removed, lower-cased: how threads match. */
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? '').replace(REPLY_PREFIX_RE, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function replySubject(subject: string | null | undefined): string {
  const s = (subject ?? '').trim()
  if (!s) return 'Re: (no subject)'
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`
}

/** A new RFC 5322 Message-ID on the sending domain. */
export function newMessageId(domain: string): string {
  return `<${crypto.randomUUID()}@${domain}>`
}

/** Message-IDs from a References / In-Reply-To header value, in order. */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return []
  return value.match(/<[^<>\s]+>/g) ?? []
}

/** The References header for a reply: the parent's References plus the parent, capped. */
export function replyReferences(parent: { rfcMessageId: string; references?: string | null }): string {
  const ids = [...parseMessageIds(parent.references), parent.rfcMessageId]
  const unique = ids.filter((id, i) => ids.indexOf(id) === i)
  // Mail servers choke on very long References lines; keep the first and the recent ones.
  const capped = unique.length > 20 ? [unique[0], ...unique.slice(-19)] : unique
  return capped.join(' ')
}

export function readJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function readAddressJson(raw: unknown): MailAddress[] {
  const value = readJson<unknown>(raw, [])
  return Array.isArray(value) ? value.map(parseAddress).filter((a): a is MailAddress => !!a) : []
}

/** Plain text from HTML for the snippet and the chat body when a message has no text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The new part of a reply: everything above the quoted history ("On … wrote:",
 * "-----Original Message-----", or a run of `>` lines). Falls back to the
 * whole text when nothing looks quoted.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const joined = `${line} ${lines[i + 1] ?? ''}`
    if (/^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(line)) { cut = i; break }
    if (/^\s*On\b.{0,200}\bwrote:\s*$/i.test(line) || /^\s*On\b.{0,200}\bwrote:\s*$/i.test(joined.trim())) { cut = i; break }
    if (/^\s*From:\s.+/i.test(line) && /^\s*(Sent|Date):\s.+/i.test(lines[i + 1] ?? '')) { cut = i; break }
    if (/^\s*>/.test(line) && lines.slice(i).every((l) => /^\s*>/.test(l) || !l.trim())) { cut = i; break }
  }
  const head = lines.slice(0, cut).join('\n').trim()
  return head || text.trim()
}

export function snippetOf(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Escape plain text into minimal HTML for the HTML part of an outbound email. */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const linked = escaped.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`)
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${linked}</div>`
}

/** Mail that announces itself as bulk: newsletters, receipts, notifications. */
export function looksBulk(headers: Record<string, string>): boolean {
  const h = (k: string) => headers[k.toLowerCase()] ?? ''
  if (h('list-unsubscribe') || h('list-id')) return true
  if (/^(bulk|list|junk)$/i.test(h('precedence').trim())) return true
  if (/auto-(generated|replied)/i.test(h('auto-submitted'))) return true
  return false
}

/** Mail we must never auto-answer (loops): auto replies, bounces, mailing lists. */
export function isAutoGenerated(headers: Record<string, string>, from: string): boolean {
  const h = (k: string) => headers[k.toLowerCase()] ?? ''
  if (/auto-(generated|replied|notified)/i.test(h('auto-submitted'))) return true
  if (h('x-autoreply') || h('x-autorespond')) return true
  if (/^(bulk|list|junk|auto_reply)$/i.test(h('precedence').trim())) return true
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(from)
}

/** Where an inbound thread first lands, before Screener decisions and rules. */
export function categorize(input: { bulk: boolean; screened: boolean; decision?: string | null }): string {
  if (input.decision === 'block') return 'spam'
  if (input.decision === 'feed') return 'feed'
  if (input.decision === 'paper_trail') return 'paper_trail'
  if (input.decision === 'allow') return 'important'
  if (input.screened) return 'screener'
  return input.bulk ? 'feed' : 'important'
}

export interface RuleMatch {
  from?: string | null
  fromDomain?: string | null
  to?: string | null
  subject?: string | null
  body?: string | null
  hasAttachment?: boolean | null
  bulk?: boolean | null
}

export interface RuleSubject {
  from: string
  to: string[]
  subject: string
  body: string
  hasAttachment: boolean
  bulk: boolean
}

const contains = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.trim().toLowerCase())

/** Whether a rule's match clause fits a message. Empty clauses never match (a rule must say something). */
export function ruleMatches(match: RuleMatch, mail: RuleSubject): boolean {
  const checks: boolean[] = []
  if (match.from?.trim()) checks.push(contains(mail.from, match.from))
  if (match.fromDomain?.trim()) checks.push(domainOf(mail.from) === match.fromDomain.trim().toLowerCase().replace(/^@/, ''))
  if (match.to?.trim()) checks.push(mail.to.some((t) => contains(t, match.to!)))
  if (match.subject?.trim()) checks.push(contains(mail.subject, match.subject))
  if (match.body?.trim()) checks.push(contains(mail.body, match.body))
  if (typeof match.hasAttachment === 'boolean') checks.push(mail.hasAttachment === match.hasAttachment)
  if (typeof match.bulk === 'boolean') checks.push(mail.bulk === match.bulk)
  return checks.length > 0 && checks.every(Boolean)
}

/** Headers as a lower-case map, first value wins. */
export function headerMap(headers: Array<{ key: string; value: string }> | Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (Array.isArray(headers)) {
    for (const h of headers) {
      const key = h.key.toLowerCase()
      if (!(key in out)) out[key] = h.value
    }
    return out
  }
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v
    else if (Array.isArray(v) && typeof v[0] === 'string') out[k.toLowerCase()] = v[0]
  }
  return out
}

/** A Gmail-like `mbox` entry for one message. */
export function mboxEntry(from: string, date: Date, raw: string): string {
  const body = raw.replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1')
  return `From ${from || 'MAILER-DAEMON'} ${date.toUTCString()}\n${body}${body.endsWith('\n') ? '' : '\n'}\n`
}
