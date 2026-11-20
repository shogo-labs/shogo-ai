// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Mail HTTP API. `mailRoutes` serves people (session auth, mounted
 * under `/api`); `agentMailRoutes` serves the `mail_*` agent tools through
 * the internal runtime API. The contract is in services/mail/README.md.
 */

import { Hono } from 'hono'
import { ConversationError } from '../services/conversation.service'
import * as mail from '../services/mail/mail.service'
import { MailError } from '../services/mail/mail.service'
import { connectAccount, disconnectAccount, syncAccountForUser } from '../services/mail/imap-account'

export interface MailRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

export interface AgentMailAuthContext {
  workspaceId: string
  projectId?: string
}

export interface AgentMailRoutesConfig {
  authorize: (c: any) => Promise<AgentMailAuthContext | Response>
}

function errorResponse(c: any, err: unknown) {
  if (err instanceof MailError || err instanceof ConversationError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status)
  }
  console.error('[Mail] request failed:', err)
  return c.json({ error: { code: 'internal', message: (err as Error)?.message ?? 'Something went wrong' } }, 500)
}

async function readJson(c: any): Promise<Record<string, any>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

/** Accepts the snake_case names agent tools use and the camelCase the app sends. */
function pick(body: Record<string, any>, ...names: string[]): any {
  for (const n of names) if (body[n] !== undefined) return body[n]
  return undefined
}

/** No scripts, no forms, no frames, and no remote loads (tracking pixels) unless the reader asked for images. */
function htmlPolicy(images: boolean): string {
  const img = images ? 'img-src data: cid: https: http:' : 'img-src data: cid:'
  return `default-src 'none'; style-src 'unsafe-inline'; font-src data:; ${img}; form-action 'none'; base-uri 'none'`
}

function htmlHeaders(images: boolean): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `${htmlPolicy(images)}; sandbox allow-popups allow-popups-to-escape-sandbox`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, max-age=300',
  }
}

/**
 * The policy also goes in a meta tag, because the app shows the HTML through
 * `srcdoc`, where response headers do not apply; and links open in a new tab,
 * never inside the frame.
 *
 * The policy is the very first thing in the document. Inserting it after a
 * `<head>` match could land it after content the sender put first (or inside
 * a `<header>`), where browsers ignore it and remote images load. The
 * sender's own `http-equiv` metas (refresh, a looser policy) are removed: a
 * refresh would navigate the phone's WebView, which hands it to the browser.
 */
export function prepareHtml(html: string, images: boolean): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${htmlPolicy(images).replace(/"/g, '&quot;')}"><meta name="referrer" content="no-referrer"><base target="_blank">`
  const body = html.replace(/<meta\b[^>]*\bhttp-equiv\b[^>]*>/gi, '').replace(/<base\b[^>]*>/gi, '')
  return `${head}${body}`
}

export function mailRoutes(config: MailRoutesConfig): Hono {
  const router = new Hono()
  const ws = '/workspaces/:workspaceId/mail'

  async function user(c: any): Promise<string | Response> {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    return userId
  }

  /** Wraps a handler: resolves the user, maps errors. */
  function route(handler: (c: any, userId: string) => Promise<Response>) {
    return async (c: any) => {
      const userId = await user(c)
      if (userId instanceof Response) return userId
      try {
        return await handler(c, userId)
      } catch (err) {
        return errorResponse(c, err)
      }
    }
  }

  /** Mailbox/thread/message ids are global, but the URL's workspace must match the row's. */
  async function assertWorkspace(c: any, workspaceId: string | null | undefined) {
    if (workspaceId && workspaceId !== c.req.param('workspaceId')) throw new MailError(404, 'not_found', 'Not found')
  }

  router.get(ws, route(async (c, userId) => c.json(await mail.getMailOverview(c.req.param('workspaceId'), userId))))

  // Domains
  router.post(`${ws}/domains`, route(async (c, userId) => {
    const body = await readJson(c)
    return c.json({ domain: await mail.addDomain(c.req.param('workspaceId'), userId, body) }, 201)
  }))
  router.post(`${ws}/domains/:domainId/verify`, route(async (c, userId) =>
    c.json({ domain: await mail.verifyDomain(c.req.param('workspaceId'), userId, c.req.param('domainId')) })))
  router.post(`${ws}/domains/:domainId/resume`, route(async (c, userId) =>
    c.json({ domain: await mail.resumeDomain(c.req.param('workspaceId'), userId, c.req.param('domainId')) })))
  router.delete(`${ws}/domains/:domainId`, route(async (c, userId) =>
    c.json(await mail.removeDomain(c.req.param('workspaceId'), userId, c.req.param('domainId')))))

  // Mailboxes
  router.post(`${ws}/mailboxes`, route(async (c, userId) => {
    const body = await readJson(c)
    return c.json({ mailbox: await mail.createMailbox(c.req.param('workspaceId'), userId, body) }, 201)
  }))

  async function mailboxIn(c: any) {
    const { prisma } = await import('../lib/prisma')
    const row = await prisma.mailbox.findUnique({ where: { id: c.req.param('mailboxId') }, select: { workspaceId: true } })
    if (!row) throw new MailError(404, 'not_found', 'Mailbox not found')
    await assertWorkspace(c, row.workspaceId)
    return c.req.param('mailboxId') as string
  }

  router.patch(`${ws}/mailboxes/:mailboxId`, route(async (c, userId) => {
    const id = await mailboxIn(c)
    return c.json({ mailbox: await mail.updateMailbox(id, userId, await readJson(c)) })
  }))
  router.delete(`${ws}/mailboxes/:mailboxId`, route(async (c, userId) => c.json(await mail.archiveMailbox(await mailboxIn(c), userId))))
  router.get(`${ws}/mailboxes/:mailboxId/threads`, route(async (c, userId) => {
    const id = await mailboxIn(c)
    const threads = await mail.listThreads(id, userId, {
      view: c.req.query('view'),
      q: c.req.query('q'),
      limit: c.req.query('limit'),
      before: c.req.query('before'),
    })
    return c.json({ threads })
  }))
  router.post(`${ws}/mailboxes/:mailboxId/compose`, route(async (c, userId) => {
    const id = await mailboxIn(c)
    return c.json(await mail.compose(id, { kind: 'user', userId }, await readJson(c)), 201)
  }))
  router.get(`${ws}/mailboxes/:mailboxId/screener`, route(async (c, userId) =>
    c.json({ senders: await mail.listScreener(await mailboxIn(c), userId) })))
  router.post(`${ws}/mailboxes/:mailboxId/senders`, route(async (c, userId) => {
    const id = await mailboxIn(c)
    return c.json({ sender: await mail.decideSender(id, userId, await readJson(c)) })
  }))
  router.get(`${ws}/mailboxes/:mailboxId/rules`, route(async (c, userId) =>
    c.json({ rules: await mail.listRules(await mailboxIn(c), userId) })))
  router.post(`${ws}/mailboxes/:mailboxId/rules`, route(async (c, userId) => {
    const id = await mailboxIn(c)
    return c.json({ rule: await mail.createRule(id, userId, await readJson(c)) }, 201)
  }))
  router.patch(`${ws}/rules/:ruleId`, route(async (c, userId) =>
    c.json({ rule: await mail.updateRule(c.req.param('ruleId'), userId, await readJson(c)) })))
  router.delete(`${ws}/rules/:ruleId`, route(async (c, userId) => c.json(await mail.deleteRule(c.req.param('ruleId'), userId))))
  router.get(`${ws}/mailboxes/:mailboxId/export`, route(async (c, userId) => {
    const { filename, body } = await mail.exportMailbox(await mailboxIn(c), userId)
    return new Response(body, {
      headers: {
        'Content-Type': 'application/mbox; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9@._-]/g, '_')}"`,
      },
    })
  }))
  router.post(`${ws}/mailboxes/:mailboxId/accounts`, route(async (c, userId) => {
    const id = await mailboxIn(c)
    return c.json({ account: await connectAccount(id, userId, await readJson(c)) }, 201)
  }))
  router.post(`${ws}/accounts/:accountId/sync`, route(async (c, userId) => c.json(await syncAccountForUser(c.req.param('accountId'), userId))))
  router.delete(`${ws}/accounts/:accountId`, route(async (c, userId) => c.json(await disconnectAccount(c.req.param('accountId'), userId))))

  // Threads
  router.get(`${ws}/threads/:threadId`, route(async (c, userId) => {
    const result = await mail.getThread(c.req.param('threadId'), userId)
    await assertWorkspace(c, (result.thread as any).workspaceId)
    return c.json(result)
  }))
  router.patch(`${ws}/threads/:threadId`, route(async (c, userId) =>
    c.json({ thread: await mail.updateThread(c.req.param('threadId'), userId, await readJson(c)) })))
  router.post(`${ws}/threads/:threadId/reply`, route(async (c, userId) => {
    const body = await readJson(c)
    const result = await mail.replyToThread(c.req.param('threadId'), userId, {
      ...body,
      replyAll: pick(body, 'replyAll', 'reply_all'),
      attachmentIds: pick(body, 'attachmentIds', 'attachment_ids'),
      sendAt: pick(body, 'sendAt', 'send_at'),
    })
    return c.json({ mail: result.mail, thread: result.thread }, 201)
  }))

  // One email
  router.post(`${ws}/messages/:mailId/approve`, route(async (c, userId) =>
    c.json({ mail: await mail.approveMail(c.req.param('mailId'), userId, await readJson(c)) })))
  router.post(`${ws}/messages/:mailId/discard`, route(async (c, userId) =>
    c.json({ mail: await mail.discardMail(c.req.param('mailId'), userId) })))
  router.post(`${ws}/messages/:mailId/undo`, route(async (c, userId) =>
    c.json({ mail: await mail.undoMail(c.req.param('mailId'), userId) })))
  router.get(`${ws}/messages/:mailId/html`, route(async (c, userId) => {
    const row = await mail.mailForUser(c.req.param('mailId'), userId)
    await assertWorkspace(c, row.workspaceId)
    const images = c.req.query('images') === '1'
    return new Response(prepareHtml(await mail.mailHtml(row), images), { headers: htmlHeaders(images) })
  }))
  router.get(`${ws}/messages/:mailId/raw`, route(async (c, userId) => {
    const row = await mail.mailForUser(c.req.param('mailId'), userId)
    await assertWorkspace(c, row.workspaceId)
    return new Response(await mail.mailRaw(row), {
      headers: { 'Content-Type': 'message/rfc822; charset=utf-8', 'Content-Disposition': `attachment; filename="${row.id}.eml"` },
    })
  }))

  router.get(`${ws}/by-conversation/:conversationId`, route(async (c, userId) =>
    c.json({ mailbox: await mail.mailboxByConversation(c.req.param('conversationId'), userId) })))

  return router
}

/** Provider webhooks (public; the provider's signature is the auth). Cloud only. */
export function mailWebhookRoutes(): Hono {
  const router = new Hono()
  router.post('/webhooks/mail/:provider', async (c) => {
    const { handleMailWebhook } = await import('../services/mail/webhook')
    const result = await handleMailWebhook({ rawBody: await c.req.text(), header: (name) => c.req.header(name) })
    return c.json(result.body, result.status)
  })
  return router
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export function agentMailRoutes(config: AgentMailRoutesConfig): Hono {
  const router = new Hono()
  const base = '/workspaces/:workspaceId/agent-mail'

  function route(handler: (c: any, ctx: { workspaceId: string; projectId: string | null }, body: Record<string, any>) => Promise<Response>) {
    return async (c: any) => {
      const body = c.req.method === 'GET' ? {} : await readJson(c)
      const auth = await config.authorize(c)
      if (auth instanceof Response) return auth
      // A project token pins the agent; a workspace runtime may speak as one of its own projects.
      let projectId: string | null = auth.projectId ?? null
      if (auth.projectId === undefined) {
        const claimed = body.projectId ?? c.req.query('projectId')
        if (typeof claimed === 'string' && claimed) {
          const { prisma } = await import('../lib/prisma')
          const project = await prisma.project.findUnique({ where: { id: claimed }, select: { workspaceId: true } })
          projectId = project?.workspaceId === auth.workspaceId ? claimed : null
        }
      }
      try {
        return await handler(c, { workspaceId: auth.workspaceId, projectId }, body)
      } catch (err) {
        return errorResponse(c, err)
      }
    }
  }

  router.get(`${base}/mailboxes`, route(async (c, ctx) =>
    c.json({ mailboxes: await mail.agentListMailboxes(ctx.workspaceId, ctx.projectId) })))
  router.get(`${base}/threads`, route(async (c, ctx) => {
    const mailbox = c.req.query('mailbox')
    if (!mailbox) throw new MailError(400, 'mailbox_required', 'Say which mailbox (address or id); mail_list with no mailbox lists them')
    return c.json({ threads: await mail.agentListThreads(ctx.workspaceId, ctx.projectId, mailbox, { view: c.req.query('view'), q: c.req.query('q'), limit: c.req.query('limit') }) })
  }))
  router.get(`${base}/threads/:threadId`, route(async (c, ctx) =>
    c.json(await mail.agentReadThread(ctx.workspaceId, ctx.projectId, c.req.param('threadId')))))
  router.post(`${base}/threads/:threadId/reply`, route(async (c, ctx, body) => {
    const result = await mail.agentReply(ctx.workspaceId, ctx.projectId, c.req.param('threadId'), {
      text: body.text,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      replyAll: pick(body, 'replyAll', 'reply_all'),
    })
    return c.json({ mail: result.mail, note: 'Drafted. A person must approve it in the mailbox before it is sent.' }, 201)
  }))
  router.post(`${base}/compose`, route(async (c, ctx, body) => {
    const mailbox = typeof body.mailbox === 'string' ? body.mailbox : ''
    if (!mailbox) throw new MailError(400, 'mailbox_required', 'Say which mailbox to send from')
    const result = await mail.agentCompose(ctx.workspaceId, ctx.projectId, mailbox, {
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      text: body.text,
    })
    return c.json({ mail: result.mail, thread: result.thread, note: 'Drafted. A person must approve it in the mailbox before it is sent.' }, 201)
  }))

  return router
}
