// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Mail: workspace email on the workspace's own domain. A mailbox is a
 * private conversation and an email thread is a thread in it, so the chat
 * timeline shows mail through `blocks.email`; these routes cover the rest
 * (domains, mailboxes, sending, thread state, the screener, rules).
 *
 * Contract: apps/api/src/services/mail/README.md
 * (`/api/workspaces/:workspaceId/mail`). Errors are the server's own `error`
 * string — the HTTP client throws a ShogoError carrying it.
 */
type HttpClient = ReturnType<typeof import('./workspace-http').workspaceHttpProxy>

/**
 * The workspace client, resolved on first call. Pure helpers here
 * (`emailBlockOf`, formatting) are imported by every chat row; loading the
 * HTTP stack only when a request is made keeps those imports free of it.
 */
function lazyWorkspaceHttp(): HttpClient {
  let client: HttpClient | null = null
  return new Proxy({} as HttpClient, {
    get(_target, prop) {
      client ??= (require('./workspace-http') as typeof import('./workspace-http')).workspaceHttpProxy()
      const value = (client as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === 'function' ? value.bind(client) : value
    },
  })
}

export type MailDirection = 'inbound' | 'outbound'
export type MailStatus =
  | 'received'
  | 'draft'
  | 'pending_approval'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'cancelled'
export type MailDomainMode = 'full' | 'subdomain'
export type MailboxKind = 'person' | 'shared' | 'agent'
export type MailSendPolicy = 'draft' | 'approve' | 'auto'
export type MailCategory = 'important' | 'feed' | 'paper_trail' | 'screener' | 'spam'
export type MailThreadStatus = 'open' | 'waiting' | 'done'
export type MailView = 'inbox' | 'feed' | 'paper_trail' | 'screener' | 'done' | 'snoozed' | 'assigned'
export type SenderDecision = 'allow' | 'block' | 'feed' | 'paper_trail'

export interface MailAddress {
  address: string
  name?: string | null
}

export interface MailAttachmentRef {
  name: string
  mimeType: string
  size: number
  attachmentId?: string | null
}

/** `blocks.email` on a conversation message. */
export interface EmailBlock {
  mailId: string
  threadId: string | null
  mailboxId: string
  direction: MailDirection
  status: MailStatus
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  hasHtml: boolean
  auth?: { spf?: string; dkim?: string; dmarc?: string } | null
  attachments: MailAttachmentRef[]
  sendAfter?: string | null
  draftedBy?: string | null
  error?: string | null
  untrusted?: boolean
}

export interface MailDnsRecord {
  type: string
  name: string
  value: string
  priority?: number | null
  purpose?: string | null
  status?: 'ok' | 'missing' | 'mismatch' | 'pending' | string | null
  found?: string | null
}

export interface MailDomain {
  id: string
  domain: string
  mode: MailDomainMode | 'shogo'
  status: string
  records?: MailDnsRecord[]
  dnsRecords?: MailDnsRecord[]
  verifiedAt?: string | null
  lastCheckedAt?: string | null
  lastError?: string | null
  sendingPaused?: boolean
  pausedAt?: string | null
  pausedReason?: string | null
}

export interface MailboxAccount {
  id: string
  address: string
  imapHost?: string
  smtpHost?: string
  lastSyncAt?: string | null
  lastError?: string | null
  status?: string | null
}

export interface Mailbox {
  id: string
  workspaceId?: string
  domainId?: string | null
  localPart: string
  address: string
  kind: MailboxKind
  displayName?: string | null
  ownerUserId?: string | null
  agentRef?: string | null
  conversationId: string
  sendPolicy: MailSendPolicy
  screenerEnabled: boolean
  catchAll?: boolean
  signature?: string | null
  slaHours?: number | null
  archivedAt?: string | null
  accounts?: MailboxAccount[]
}

export interface MailLimits {
  dailySend?: number
  perMailboxDaily?: number
  recipientsPerMessage?: number
  [key: string]: number | undefined
}

export interface MailUsage {
  sent24h?: number
  [key: string]: number | undefined
}

export interface MailOverview {
  enabled: boolean
  provider: string
  sharedDomain: string | null
  limits: MailLimits | null
  usage: MailUsage | null
  domains: MailDomain[]
  mailboxes: Mailbox[]
}

export interface MailThread {
  id: string
  mailboxId: string
  subject: string
  category: MailCategory
  status: MailThreadStatus
  assigneeUserId?: string | null
  snoozedUntil?: string | null
  slaDueAt?: string | null
  lastMessageAt?: string | null
  /** The conversation message that roots this thread in the mailbox channel. */
  rootMessageId?: string | null
  threadRootMessageId?: string | null
  conversationId?: string | null
  snippet?: string | null
  messageCount?: number | null
  unread?: boolean | null
  participants?: MailAddress[] | null
  from?: MailAddress | null
}

export interface MailMessageRow {
  id: string
  direction: MailDirection
  status: MailStatus
  subject: string
  text?: string | null
  from: MailAddress
  to: MailAddress[]
  cc?: MailAddress[]
  createdAt?: string
  sendAfter?: string | null
  error?: string | null
  conversationMessageId?: string | null
}

export interface ScreenerSender {
  address: string
  name?: string | null
  count: number
  lastAt: string | null
}

export interface MailRuleMatch {
  from?: string | null
  to?: string | null
  subject?: string | null
  body?: string | null
}

export interface MailRuleAction {
  category?: MailCategory | null
  assigneeUserId?: string | null
  status?: MailThreadStatus | null
  agentRef?: string | null
  label?: string | null
}

export interface MailRule {
  id: string
  mailboxId: string
  name?: string | null
  instruction?: string | null
  match?: MailRuleMatch | null
  action?: MailRuleAction | null
  enabled?: boolean
  position?: number
}

export interface MailRuleInput {
  name?: string
  instruction?: string
  match?: MailRuleMatch
  action?: MailRuleAction
  enabled?: boolean
}

export interface ComposeInput {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  attachmentIds?: string[]
  sendAt?: string
}

export interface ReplyInput {
  text: string
  replyAll?: boolean
  to?: string[]
  cc?: string[]
  bcc?: string[]
  attachmentIds?: string[]
  sendAt?: string
}

export interface ConnectAccountInput {
  address: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  username: string
  password: string
  tls?: boolean
}

export const MAIL_VIEWS: Array<{ id: MailView; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'feed', label: 'Feed' },
  { id: 'paper_trail', label: 'Paper trail' },
  { id: 'screener', label: 'Screener' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'done', label: 'Done' },
  { id: 'assigned', label: 'Assigned to me' },
]

export const MAIL_CATEGORY_LABELS: Record<MailCategory, string> = {
  important: 'Inbox',
  feed: 'Feed',
  paper_trail: 'Paper trail',
  screener: 'Screener',
  spam: 'Spam',
}

export const MAIL_STATUS_LABELS: Record<MailThreadStatus, string> = {
  open: 'Open',
  waiting: 'Waiting',
  done: 'Done',
}

/** `blocks.email` of a message, or null when it is not an email. */
export function emailBlockOf(message: { blocks?: Record<string, unknown> | null } | null | undefined): EmailBlock | null {
  const block = message?.blocks?.email as EmailBlock | undefined
  return block && typeof block === 'object' && typeof block.mailId === 'string' ? block : null
}

export function formatAddress(a: MailAddress | null | undefined): string {
  if (!a) return ''
  return a.name ? `${a.name} <${a.address}>` : a.address
}

export function formatAddressList(list: MailAddress[] | null | undefined): string {
  return (list ?? []).map(formatAddress).join(', ')
}

/** Split "a@x.com, b@y.com; c@z.com" into addresses. */
export function parseAddressList(input: string): string[] {
  return input
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The DNS records a domain shows, whichever field the server filled. */
export function domainRecords(domain: MailDomain): MailDnsRecord[] {
  return domain.records ?? domain.dnsRecords ?? []
}

export function threadRootMessageId(thread: MailThread): string | null {
  return thread.rootMessageId ?? thread.threadRootMessageId ?? null
}

/** A failed or soft-failed SPF/DKIM/DMARC result. */
export function authFailed(result: string | undefined | null): boolean {
  if (!result) return false
  const r = result.toLowerCase()
  return r !== 'pass' && r !== 'none' && r !== 'neutral'
}

export function mailApi() {
  const http = lazyWorkspaceHttp()
  const base = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/mail`
  const seg = (s: string) => encodeURIComponent(s)
  return {
    async overview(workspaceId: string): Promise<MailOverview> {
      return (await http.get<MailOverview>(base(workspaceId))).data
    },

    // Domains
    async addDomain(workspaceId: string, input: { domain: string; mode: MailDomainMode }): Promise<MailDomain> {
      return (await http.post<{ domain: MailDomain }>(`${base(workspaceId)}/domains`, input)).data.domain
    },
    async verifyDomain(workspaceId: string, domainId: string): Promise<MailDomain> {
      return (await http.post<{ domain: MailDomain }>(`${base(workspaceId)}/domains/${seg(domainId)}/verify`, {})).data.domain
    },
    async resumeDomain(workspaceId: string, domainId: string): Promise<MailDomain> {
      return (await http.post<{ domain: MailDomain }>(`${base(workspaceId)}/domains/${seg(domainId)}/resume`, {})).data.domain
    },
    async deleteDomain(workspaceId: string, domainId: string): Promise<void> {
      await http.delete(`${base(workspaceId)}/domains/${seg(domainId)}`)
    },

    // Mailboxes
    async createMailbox(
      workspaceId: string,
      input: {
        localPart: string
        kind: MailboxKind
        domainId?: string | null
        displayName?: string
        ownerUserId?: string
        agentRef?: string
        memberUserIds?: string[]
      },
    ): Promise<Mailbox> {
      return (await http.post<{ mailbox: Mailbox }>(`${base(workspaceId)}/mailboxes`, input)).data.mailbox
    },
    async updateMailbox(
      workspaceId: string,
      mailboxId: string,
      patch: Partial<Pick<Mailbox, 'displayName' | 'signature' | 'sendPolicy' | 'screenerEnabled' | 'catchAll' | 'slaHours'>>,
    ): Promise<Mailbox> {
      return (await http.patch<{ mailbox: Mailbox }>(`${base(workspaceId)}/mailboxes/${seg(mailboxId)}`, patch)).data.mailbox
    },
    async archiveMailbox(workspaceId: string, mailboxId: string): Promise<void> {
      await http.delete(`${base(workspaceId)}/mailboxes/${seg(mailboxId)}`)
    },
    async threads(
      workspaceId: string,
      mailboxId: string,
      opts: { view?: MailView; q?: string; limit?: number; before?: string } = {},
    ): Promise<MailThread[]> {
      const params = new URLSearchParams()
      if (opts.view) params.set('view', opts.view)
      if (opts.q) params.set('q', opts.q)
      if (opts.limit) params.set('limit', String(opts.limit))
      if (opts.before) params.set('before', opts.before)
      return (await http.get<{ threads: MailThread[] }>(`${base(workspaceId)}/mailboxes/${seg(mailboxId)}/threads?${params}`)).data.threads ?? []
    },
    async compose(workspaceId: string, mailboxId: string, input: ComposeInput): Promise<{ mail: MailMessageRow; thread: MailThread }> {
      return (await http.post<{ mail: MailMessageRow; thread: MailThread }>(`${base(workspaceId)}/mailboxes/${seg(mailboxId)}/compose`, input)).data
    },
    async byConversation(workspaceId: string, conversationId: string): Promise<Mailbox | null> {
      return (await http.get<{ mailbox: Mailbox | null }>(`${base(workspaceId)}/by-conversation/${seg(conversationId)}`)).data.mailbox ?? null
    },
    exportUrl(workspaceId: string, mailboxId: string): string {
      return `${base(workspaceId)}/mailboxes/${seg(mailboxId)}/export`
    },

    // Threads
    async thread(workspaceId: string, threadId: string): Promise<{ thread: MailThread; messages: MailMessageRow[] }> {
      return (await http.get<{ thread: MailThread; messages: MailMessageRow[] }>(`${base(workspaceId)}/threads/${seg(threadId)}`)).data
    },
    async updateThread(
      workspaceId: string,
      threadId: string,
      patch: { status?: MailThreadStatus; assigneeUserId?: string | null; snoozedUntil?: string | null; category?: MailCategory },
    ): Promise<MailThread> {
      return (await http.patch<{ thread: MailThread }>(`${base(workspaceId)}/threads/${seg(threadId)}`, patch)).data.thread
    },
    async reply(workspaceId: string, threadId: string, input: ReplyInput): Promise<MailMessageRow> {
      return (await http.post<{ mail: MailMessageRow }>(`${base(workspaceId)}/threads/${seg(threadId)}/reply`, input)).data.mail
    },

    // Messages
    async approve(workspaceId: string, mailId: string, text?: string): Promise<MailMessageRow> {
      return (await http.post<{ mail: MailMessageRow }>(`${base(workspaceId)}/messages/${seg(mailId)}/approve`, text !== undefined ? { text } : {})).data.mail
    },
    async discard(workspaceId: string, mailId: string): Promise<MailMessageRow> {
      return (await http.post<{ mail: MailMessageRow }>(`${base(workspaceId)}/messages/${seg(mailId)}/discard`, {})).data.mail
    },
    async undo(workspaceId: string, mailId: string): Promise<MailMessageRow> {
      return (await http.post<{ mail: MailMessageRow }>(`${base(workspaceId)}/messages/${seg(mailId)}/undo`, {})).data.mail
    },
    /** The sanitized HTML body (the server's CSP blocks scripts and remote loads unless `images`). */
    async html(workspaceId: string, mailId: string, opts: { images?: boolean } = {}): Promise<string> {
      const res = await http.get<string>(`${base(workspaceId)}/messages/${seg(mailId)}/html${opts.images ? '?images=1' : ''}`)
      return typeof res.data === 'string' ? res.data : ''
    },
    rawUrl(workspaceId: string, mailId: string): string {
      return `${base(workspaceId)}/messages/${seg(mailId)}/raw`
    },

    // Screener
    async screener(workspaceId: string, mailboxId: string): Promise<ScreenerSender[]> {
      return (await http.get<{ senders: ScreenerSender[] }>(`${base(workspaceId)}/mailboxes/${seg(mailboxId)}/screener`)).data.senders ?? []
    },
    async decideSender(workspaceId: string, mailboxId: string, address: string, decision: SenderDecision) {
      return (await http.post<{ sender: unknown }>(`${base(workspaceId)}/mailboxes/${seg(mailboxId)}/senders`, { address, decision })).data.sender
    },

    // Rules
    async rules(workspaceId: string, mailboxId: string): Promise<MailRule[]> {
      return (await http.get<{ rules: MailRule[] }>(`${base(workspaceId)}/mailboxes/${seg(mailboxId)}/rules`)).data.rules ?? []
    },
    async createRule(workspaceId: string, mailboxId: string, input: MailRuleInput): Promise<MailRule> {
      return (await http.post<{ rule: MailRule }>(`${base(workspaceId)}/mailboxes/${seg(mailboxId)}/rules`, input)).data.rule
    },
    async updateRule(workspaceId: string, ruleId: string, patch: MailRuleInput): Promise<MailRule> {
      return (await http.patch<{ rule: MailRule }>(`${base(workspaceId)}/rules/${seg(ruleId)}`, patch)).data.rule
    },
    async deleteRule(workspaceId: string, ruleId: string): Promise<void> {
      await http.delete(`${base(workspaceId)}/rules/${seg(ruleId)}`)
    },

    // Connected IMAP/SMTP accounts
    async connectAccount(workspaceId: string, mailboxId: string, input: ConnectAccountInput): Promise<MailboxAccount> {
      return (await http.post<{ account: MailboxAccount }>(`${base(workspaceId)}/mailboxes/${seg(mailboxId)}/accounts`, input)).data.account
    },
    async syncAccount(workspaceId: string, accountId: string): Promise<{ account: MailboxAccount; imported: number }> {
      return (await http.post<{ account: MailboxAccount; imported: number }>(`${base(workspaceId)}/accounts/${seg(accountId)}/sync`, {})).data
    },
    async deleteAccount(workspaceId: string, accountId: string): Promise<void> {
      await http.delete(`${base(workspaceId)}/accounts/${seg(accountId)}`)
    },
  }
}

export type MailApi = ReturnType<typeof mailApi>
