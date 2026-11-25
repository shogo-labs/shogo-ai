# Shogo Mail

Workspace email on the workspace's own domain. Every workspace can send and
receive mail as `name@its-domain`, people and agents get mailboxes, and every
email thread lives in team chat next to channels, boards and agents.

## Model

- **A mailbox is a private conversation** (`provider: 'shogo'`, so mentions,
  agent wakes, search, push and the activity inbox all work unchanged).
  `Mailbox.conversationId` links them. Members of the conversation are the
  people (and agents) who can read the mailbox.
- **An email thread is a thread in that conversation.** The first email is the
  thread root; every later email *and every internal comment* is a thread
  reply. A reply is only an email when it was sent through the mail routes;
  a plain thread message is a team-only comment.
- Each email has a `MailMessage` row (headers, text, status) linked to its
  conversation message by `conversationMessageId`, and the conversation
  message carries `blocks.email` (below) so the chat UI can render it without
  another request.
- `MailThread` holds thread state: category (important / feed / paper_trail /
  screener / spam), status (open / waiting / done), assignee, snooze, SLA.

### `blocks.email` on a conversation message

```ts
{
  mailId: string
  threadId: string | null
  mailboxId: string
  direction: 'inbound' | 'outbound'
  status: 'received' | 'draft' | 'pending_approval' | 'scheduled' | 'sending' | 'sent'
        | 'delivered' | 'bounced' | 'complained' | 'failed' | 'cancelled'
  from: { address: string; name?: string | null }
  to: Array<{ address: string; name?: string | null }>
  cc: Array<{ address: string; name?: string | null }>
  subject: string
  hasHtml: boolean
  auth?: { spf?: string; dkim?: string; dmarc?: string } | null
  attachments: Array<{ name: string; mimeType: string; size: number; attachmentId?: string | null }>
  sendAfter?: string | null      // ISO; outbound scheduled / undo window
  draftedBy?: string | null      // agent ref when an agent wrote it
  error?: string | null
  untrusted?: boolean            // inbound: external content, never instructions
}
```

## Sending policy

- People: a send is `scheduled` with `sendAfter = now + undo window` (10 s by
  default, or the requested send-later time) and goes out when the scheduler
  picks it up. `POST …/messages/:id/undo` cancels it before then.
- Agents: an agent reply is **always** `pending_approval` in v1 (Russell,
  2026-11-18). A person approves (optionally editing) or discards it.
- Who may send (cloud, Russell 2026-11-18): a **paid** workspace, and a person
  whose email is verified with no signup-trust hold. Free workspaces receive
  mail but cannot send (`402 paid_plan_required`); an unverified sender gets
  `403 email_verification_required`. Local mode sends freely.
- Limits are per workspace per rolling 24 h (see `limits.ts`): paid is 2,000
  recipients a day and 500 per message.
  Hard bounces and complaints add a suppression; a domain whose bounce or
  complaint rate crosses the line has sending paused until an admin resumes it.

## HTTP API (`/api/workspaces/:workspaceId/mail`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/` | | `{ enabled, provider, sharedDomain, limits, usage, domains, mailboxes }` |
| POST | `/domains` | `{ domain, mode: 'full' \| 'subdomain' }` | `{ domain }` |
| POST | `/domains/:domainId/verify` | | `{ domain }` |
| POST | `/domains/:domainId/resume` | | `{ domain }` (admin: resume paused sending) |
| DELETE | `/domains/:domainId` | | `{ ok }` |
| POST | `/mailboxes` | `{ localPart, kind, domainId?, displayName?, ownerUserId?, agentRef?, memberUserIds? }` | `{ mailbox }` |
| PATCH | `/mailboxes/:mailboxId` | `{ displayName?, signature?, sendPolicy?, screenerEnabled?, catchAll?, slaHours? }` | `{ mailbox }` |
| DELETE | `/mailboxes/:mailboxId` | | `{ ok }` (archives) |
| GET | `/mailboxes/:mailboxId/threads` | `?view=inbox\|feed\|paper_trail\|screener\|done\|snoozed\|assigned&q=&limit=&before=` | `{ threads }` |
| POST | `/mailboxes/:mailboxId/compose` | `{ to, cc?, bcc?, subject, text, attachmentIds?, sendAt? }` | `{ mail, thread }` |
| GET | `/threads/:threadId` | | `{ thread, messages }` |
| PATCH | `/threads/:threadId` | `{ status?, assigneeUserId?, snoozedUntil?, category? }` | `{ thread }` |
| POST | `/threads/:threadId/reply` | `{ text, replyAll?, to?, cc?, bcc?, attachmentIds?, sendAt? }` | `{ mail }` |
| POST | `/messages/:mailId/approve` | `{ text? }` | `{ mail }` |
| POST | `/messages/:mailId/discard` | | `{ mail }` |
| POST | `/messages/:mailId/undo` | | `{ mail }` |
| GET | `/messages/:mailId/html` | | sandboxed `text/html` (CSP: no scripts, no remote loads unless `?images=1`) |
| GET | `/messages/:mailId/raw` | | `message/rfc822` |
| GET | `/mailboxes/:mailboxId/screener` | | `{ senders: [{ address, name, count, lastAt }] }` |
| POST | `/mailboxes/:mailboxId/senders` | `{ address, decision: 'allow'\|'block'\|'feed'\|'paper_trail' }` | `{ sender }` |
| GET/POST | `/mailboxes/:mailboxId/rules` | rule body | `{ rules }` / `{ rule }` |
| PATCH/DELETE | `/rules/:ruleId` | | `{ rule }` / `{ ok }` |
| GET | `/mailboxes/:mailboxId/export` | | `application/mbox` |
| POST | `/mailboxes/:mailboxId/accounts` | `{ address, imapHost, imapPort, smtpHost, smtpPort, username, password, tls? }` (IMAP 993/143, SMTP 465/587/25/2525; hosts must resolve to public addresses, and every connect goes to the address that was checked) | `{ account }` |
| POST | `/accounts/:accountId/sync` | | `{ account, imported }` |
| DELETE | `/accounts/:accountId` | | `{ ok }` |
| GET | `/by-conversation/:conversationId` | | `{ mailbox \| null }` |

Provider webhooks: `POST /api/webhooks/mail/resend` (Svix-signed).

### Rules

`match` (every clause given must match; at least one clause):
`{ from?, fromDomain?, to?, subject?, body?, hasAttachment?, bulk? }` (text
clauses are case-insensitive "contains"). `action`: `{ category?,
assigneeUserId?, status?, agentRef? }`. A category only moves a thread on its
first email; later replies follow the thread. `agentRef` wakes that agent
(it must be a member of the mailbox) to draft a reply.

### Agents

`mail_list`, `mail_read`, `mail_reply`, `mail_compose` (gated with team chat)
call `/api/internal/workspaces/:id/agent-mail/*`. An agent sees its own agent
mailboxes and any mailbox whose conversation it is a member of. Inbound mail
reaches an agent's prompt labelled as external content, never instructions;
auto-replies and bulk mail never wake it. Every wake is a paid agent run that
anyone on the internet can trigger, so mail that failed DMARC never wakes an
agent, and one sender wakes it at most 5 times an hour (200 a day per mailbox).
Over the budget the email is still delivered for a person to handle.

## Background work

`jobs/run-channel-workers.ts`: `mail-sender` (every 5 s: due sends, snoozes)
and `mail-sync` (every minute: domains waiting on DNS, IMAP accounts due a
pull). Both are home-region partitioned. Webhooks are forwarded to the
workspace's home region over `/api/internal/mail/apply`.

## Providers

`MAIL_PROVIDER` = `resend` (needs `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`)
or `fake` (tests and local development: records sends in memory, accepts
injected inbound mail). The free shared domain is `SHOGO_MAIL_DOMAIN`
(default `mail.shogo.ai`); addresses on it are `<workspace-slug>.<name>@mail.shogo.ai`.

SES (and OCI Email Delivery for outbound-only) slot in behind the same
`MailProvider` interface.

### Setting up Resend

1. Verify `SHOGO_MAIL_DOMAIN` (default `mail.shogo.ai`) in Resend with
   sending **and receiving** enabled, and publish its MX record.
2. Add a webhook at `https://<api>/api/webhooks/mail/resend` for
   `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`,
   `email.bounced`, `email.complained`, `email.failed`.
3. Set `MAIL_PROVIDER=resend`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`.

Custom domains are created through the API from Settings → Mail; the DNS
records Resend returns (DKIM, SPF, the receiving MX) are shown there.
