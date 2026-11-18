// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bring an existing mailbox (Gmail or Outlook with an app password, any IMAP
 * host) into Shogo. New mail is pulled over IMAP into a Shogo mailbox exactly
 * like hosted mail, and replies go out through the account's own SMTP, so the
 * other side sees the person's usual address. Gmail/Microsoft OAuth comes
 * later behind the same `MailAccount` row.
 */

import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { prisma } from '../../lib/prisma'
import { homeRegionWorkspaceWhere } from '../../lib/region'
import { resolvePublicHost, UnsafeUrlError } from '../../lib/safe-fetch'
import { decryptSecret, encryptSecret, isSecretCryptoConfigured } from '../../lib/secret-crypto'
import { getWorkspaceRole, loadAccess } from '../conversation.service'
import { formatAddress, isValidAddress, normalizeAddress, readJson } from './codec'
import { MailError, ingestInbound, serializeAccount } from './mail.service'
import { MailProviderError, type OutboundEmail } from './provider'

const db = prisma as any

/** Mail an account's first sync brings in; older history stays where it is. */
const BACKFILL_MESSAGES = 50
const SYNC_BATCH = 200
const SYNC_INTERVAL_MS = 2 * 60_000
const CONNECT_TIMEOUT_MS = 20_000

interface AccountCredentials {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  username: string
  password: string
  tls: boolean
}

interface SyncCursor {
  uidValidity?: string
  lastUid?: number
  imapHost?: string
  smtpHost?: string
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9.-]+$/i
const IMAP_PORTS = new Set([993, 143])
const SMTP_PORTS = new Set([465, 587, 25, 2525])

/** Hosts an account may point at: public names only, never this machine or a private network. */
function assertPublicHost(host: string) {
  const h = host.trim().toLowerCase()
  if (!HOST_RE.test(h) || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(\d+\.){3}\d+$/.test(h)) {
    throw new MailError(400, 'invalid_host', `Use the provider's public host name, e.g. imap.gmail.com (not ${host})`)
  }
}

/**
 * The name check above is not enough on its own: a public name can point at a
 * private address. Resolve it, refuse private addresses, and connect to the
 * address we checked (TLS still verifies the name).
 */
export async function publicAddressFor(host: string): Promise<string> {
  assertPublicHost(host)
  try {
    return await resolvePublicHost(host)
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      throw new MailError(400, 'invalid_host', `${host} does not resolve to a public mail server`)
    }
    throw err
  }
}

/** What a person may see about a failed sign-in: never the raw socket error (it would map the network). */
export function describeMailError(err: unknown, host: string): string {
  const e = err as any
  if (e instanceof MailError) return e.message
  const code = Number(e?.responseCode ?? 0)
  if (e?.authenticationFailed || code === 535 || code === 534 || e?.code === 'EAUTH') {
    return `${host} rejected the username or password. For Gmail and Outlook, use an app password.`
  }
  if (e?.code === 'ETIMEDOUT' || /timeout/i.test(String(e?.message ?? ''))) return `Timed out connecting to ${host}`
  return `Could not connect to ${host}. Check the host, port and TLS setting.`
}

function credentialsFrom(input: Record<string, unknown>): AccountCredentials {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
  const port = (k: string, fallback: number, allowed: Set<number>, label: string) => {
    if (input[k] === undefined || input[k] === null || input[k] === '') return fallback
    const n = Number(input[k])
    if (!allowed.has(n)) throw new MailError(400, 'invalid_port', `${label} port must be one of ${[...allowed].join(', ')}`)
    return n
  }
  const creds = {
    imapHost: str('imapHost'),
    imapPort: port('imapPort', 993, IMAP_PORTS, 'IMAP'),
    smtpHost: str('smtpHost'),
    smtpPort: port('smtpPort', 465, SMTP_PORTS, 'SMTP'),
    username: str('username') || str('address'),
    password: typeof input.password === 'string' ? input.password : '',
    tls: input.tls !== false,
  }
  if (!creds.imapHost || !creds.smtpHost || !creds.username || !creds.password) {
    throw new MailError(400, 'invalid_account', 'IMAP host, SMTP host, username and password are all needed')
  }
  assertPublicHost(creds.imapHost)
  assertPublicHost(creds.smtpHost)
  return creds
}

/** Checked on every connect, not only when the account is saved: DNS can change afterwards. */
async function imapClient(c: AccountCredentials) {
  if (!IMAP_PORTS.has(c.imapPort)) throw new MailError(400, 'invalid_port', 'IMAP port not allowed')
  const address = await publicAddressFor(c.imapHost)
  return new ImapFlow({
    host: address,
    servername: c.imapHost,
    port: c.imapPort,
    secure: c.tls,
    auth: { user: c.username, pass: c.password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 60_000,
  } as any)
}

async function smtpTransport(c: AccountCredentials) {
  if (!SMTP_PORTS.has(c.smtpPort)) throw new MailError(400, 'invalid_port', 'SMTP port not allowed')
  const address = await publicAddressFor(c.smtpHost)
  return nodemailer.createTransport({
    host: address,
    port: c.smtpPort,
    secure: c.smtpPort === 465,
    requireTLS: c.smtpPort !== 465,
    tls: { servername: c.smtpHost },
    auth: { user: c.username, pass: c.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
  } as any)
}

function decrypt(row: any): AccountCredentials {
  return JSON.parse(decryptSecret(row.credentialsEncrypted)) as AccountCredentials
}

export async function connectAccount(mailboxId: string, userId: string, input: Record<string, unknown>) {
  if (!isSecretCryptoConfigured()) throw new MailError(503, 'crypto_unavailable', 'This server cannot store mailbox passwords (SECRETS_ENCRYPTION_KEY is not set)')
  const mailbox = await db.mailbox.findUnique({ where: { id: mailboxId } })
  if (!mailbox || mailbox.archivedAt) throw new MailError(404, 'not_found', 'Mailbox not found')
  const access = await loadAccess(mailbox.conversationId, userId).catch(() => null)
  const role = await getWorkspaceRole(mailbox.workspaceId, userId)
  if (!access && role !== 'owner' && role !== 'admin') throw new MailError(404, 'not_found', 'Mailbox not found')
  if (mailbox.kind === 'person' && mailbox.ownerUserId !== userId) {
    throw new MailError(403, 'forbidden', 'Only the owner can connect their own account to a personal mailbox')
  }
  const address = typeof input.address === 'string' ? normalizeAddress(input.address) : ''
  if (!isValidAddress(address)) throw new MailError(400, 'invalid_address', 'Enter the account’s email address')
  const creds = credentialsFrom(input)

  // Prove both sides work before saving anything.
  try {
    const imap = await imapClient(creds)
    await imap.connect()
    await imap.logout()
  } catch (err) {
    throw new MailError(400, 'imap_failed', describeMailError(err, creds.imapHost))
  }
  try {
    await (await smtpTransport(creds)).verify()
  } catch (err) {
    throw new MailError(400, 'smtp_failed', describeMailError(err, creds.smtpHost))
  }

  const provider = /gmail\.com$/i.test(creds.imapHost) ? 'gmail' : /outlook|office365/i.test(creds.imapHost) ? 'microsoft' : 'imap'
  const cursor: SyncCursor = { imapHost: creds.imapHost, smtpHost: creds.smtpHost }
  const row = await db.mailAccount.upsert({
    where: { mailboxId_address: { mailboxId, address } },
    create: {
      workspaceId: mailbox.workspaceId,
      userId,
      mailboxId,
      provider,
      address,
      credentialsEncrypted: encryptSecret(JSON.stringify(creds)),
      syncCursor: JSON.stringify(cursor),
      status: 'active',
    },
    update: { credentialsEncrypted: encryptSecret(JSON.stringify(creds)), status: 'active', lastError: null, userId },
  })
  void syncAccount(row.id).catch(() => {})
  return serializeAccount(row)
}

async function accountForUser(accountId: string, userId: string) {
  const row = await db.mailAccount.findUnique({ where: { id: accountId }, include: { mailbox: true } })
  if (!row) throw new MailError(404, 'not_found', 'Account not found')
  const role = await getWorkspaceRole(row.workspaceId, userId)
  if (row.userId !== userId && role !== 'owner' && role !== 'admin') throw new MailError(404, 'not_found', 'Account not found')
  return row
}

export async function disconnectAccount(accountId: string, userId: string) {
  await accountForUser(accountId, userId)
  await db.mailAccount.delete({ where: { id: accountId } })
  return { ok: true }
}

export async function syncAccountForUser(accountId: string, userId: string) {
  await accountForUser(accountId, userId)
  const imported = await syncAccount(accountId)
  const row = await db.mailAccount.findUnique({ where: { id: accountId } })
  return { account: serializeAccount(row), imported }
}

/** Pull new INBOX mail since the last sync. Returns how many emails were imported. */
export async function syncAccount(accountId: string): Promise<number> {
  const row = await db.mailAccount.findUnique({ where: { id: accountId } })
  if (!row || row.status === 'paused') return 0
  const creds = decrypt(row)
  const cursor = readJson<SyncCursor>(row.syncCursor, {})
  let imap: ImapFlow | null = null
  let imported = 0
  try {
    imap = await imapClient(creds)
    await imap.connect()
    const lock = await imap.getMailboxLock('INBOX')
    try {
      const box: any = imap.mailbox
      const uidValidity = String(box?.uidValidity ?? '')
      const fresh = !cursor.lastUid || cursor.uidValidity !== uidValidity
      const uidNext = Number(box?.uidNext ?? 1)
      const from = fresh ? Math.max(1, uidNext - BACKFILL_MESSAGES) : cursor.lastUid! + 1
      let lastUid = fresh ? from - 1 : cursor.lastUid!
      if (from < uidNext) {
        for await (const msg of imap.fetch(`${from}:*`, { uid: true, source: true }, { uid: true })) {
          if (!msg.source || msg.uid <= lastUid) continue
          await ingestInbound({
            raw: new Uint8Array(msg.source),
            provider: 'imap',
            providerMessageId: `imap:${row.id}:${uidValidity}:${msg.uid}`,
            mailboxId: row.mailboxId,
            quiet: fresh,
          })
          lastUid = msg.uid
          imported++
          if (imported >= SYNC_BATCH) break
        }
      }
      await db.mailAccount.update({
        where: { id: row.id },
        data: { syncCursor: JSON.stringify({ ...cursor, uidValidity, lastUid }), lastSyncAt: new Date(), lastError: null, status: 'active' },
      })
    } finally {
      lock.release()
    }
    await imap.logout()
  } catch (err) {
    await db.mailAccount.update({ where: { id: row.id }, data: { lastSyncAt: new Date(), lastError: describeMailError(err, creds.imapHost).slice(0, 500), status: 'error' } })
    try { imap?.close() } catch {}
  }
  return imported
}

/** Send through the account's own SMTP (the mail keeps the person's usual address and reputation). */
export async function sendViaAccount(account: any, email: OutboundEmail): Promise<{ providerMessageId: string }> {
  const creds = decrypt(account)
  try {
    const info = await (await smtpTransport(creds)).sendMail({
      from: formatAddress({ address: account.address, name: email.from.name }),
      to: email.to.map(formatAddress),
      cc: email.cc.map(formatAddress),
      bcc: email.bcc.map(formatAddress),
      subject: email.subject,
      text: email.text,
      html: email.html,
      messageId: email.messageId,
      inReplyTo: email.inReplyTo ?? undefined,
      references: email.references ?? undefined,
      attachments: email.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content) })),
    })
    return { providerMessageId: String(info.messageId ?? email.messageId) }
  } catch (err: any) {
    if (err instanceof MailError) throw new MailProviderError(err.message, 400, false)
    const code = Number(err?.responseCode ?? 0)
    throw new MailProviderError(String(err?.message ?? 'SMTP send failed'), code || undefined, !code || code >= 400 && code < 500)
  }
}

/** Background: sync every active account that is due. */
export async function syncDueAccounts(now = new Date()): Promise<number> {
  const home = homeRegionWorkspaceWhere()
  const rows = await db.mailAccount.findMany({
    where: {
      status: { in: ['active', 'error'] },
      OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(now.getTime() - SYNC_INTERVAL_MS) } }],
      mailbox: { archivedAt: null, ...(home ? { workspace: home } : {}) },
    },
    take: 10,
    select: { id: true },
  })
  for (const r of rows) await syncAccount(r.id)
  return rows.length
}
