// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-click unsubscribe for lifecycle email (SHO-615).
 *
 * `GET /api/email/unsubscribe?u=&t=` renders a small confirmation page with a
 * button. It deliberately changes nothing: mail clients and security scanners
 * prefetch GET links, so a state change here would unsubscribe people who never
 * clicked. `POST` with the same params is the RFC 8058 one-click a mail client
 * sends (Gmail's `List-Unsubscribe-Post: List-Unsubscribe=One-Click`), and it is
 * what sets the opt-out.
 *
 * The link is signed (`lib/lifecycle-email.ts`); an unsigned or edited `t` is a
 * 400. The path is exempted from the session gate in
 * `middleware/api-auth-gate.ts` — the signature is the credential.
 */
import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { verifyUnsubscribeToken } from '../lib/lifecycle-email'
import { unsubscribeUser } from '../services/loops.service'

const PAGE_STYLE =
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0b0d;color:#e7e7ea;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}' +
  'main{max-width:420px;text-align:center}main h1{font-size:20px;margin:0 0 12px}p{color:#a1a1aa;line-height:1.5;margin:0 0 20px}' +
  'button{background:#e27927;color:#0b0b0d;border:0;border-radius:10px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer}'

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><style>${PAGE_STYLE}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`
}

export function emailUnsubscribeRoutes(): Hono {
  const app = new Hono()

  app.get('/unsubscribe', (c) => {
    const u = c.req.query('u') ?? ''
    const t = c.req.query('t') ?? ''
    if (!verifyUnsubscribeToken(u, t)) {
      return c.html(page('That link is not valid', '<p>This unsubscribe link is missing or has been edited. Use the link from a recent email, or turn these emails off in your account settings.</p>'), 400)
    }
    const action = `/api/email/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`
    return c.html(
      page(
        'Turn off lifecycle emails?',
        `<p>You will stop receiving build-ready, usage and reminder emails. Receipts and payment notices are transactional and will still be sent.</p>` +
          `<form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`,
      ),
      200,
    )
  })

  app.post('/unsubscribe', async (c) => {
    const u = c.req.query('u') ?? ''
    const t = c.req.query('t') ?? ''
    if (!verifyUnsubscribeToken(u, t)) {
      return c.json({ ok: false, error: 'invalid_signature' }, 400)
    }
    // `updateMany` so a stale link for a deleted user is a no-op rather than a
    // 500 to the mail client.
    await prisma.user.updateMany({ where: { id: u }, data: { lifecycleEmailOptOutAt: new Date() } })
    try {
      // Fire-and-forget by contract (no-op unless Loops is configured); await it
      // so a test can observe the call, but never let it fail the 200.
      await unsubscribeUser(u)
    } catch (err: any) {
      console.warn('[EmailUnsubscribe] Loops unsubscribe failed:', err?.message ?? err)
    }
    return c.html(
      page('You’re unsubscribed', '<p>You will no longer receive lifecycle emails from Shogo. Receipts and payment notices will still be sent.</p>'),
      200,
    )
  })

  return app
}
