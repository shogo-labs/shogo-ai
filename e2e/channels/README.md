# Channel Integration Tests

API-level integration tests for the agent channel system. These tests run against
a **live** agent runtime — local, staging, or production — and validate real
HTTP/SSE connectivity, message flow, channel health, and connect/disconnect lifecycle.

## Quick Start

```bash
# Local (agent runtime running on port 6200)
AGENT_URL=http://localhost:6200 bun run test:channels

# Staging (through the API proxy — requires auth cookie)
AGENT_URL=https://studio-staging.shogo.ai/api/projects/<PROJECT_ID>/agent-proxy \
  AUTH_COOKIE="better-auth.session_token=<YOUR_SESSION_TOKEN>" \
  bun run test:channels

# Run individual test suites
AGENT_URL=http://localhost:6200 bun run test:channels:status     # fast smoke test
AGENT_URL=http://localhost:6200 bun run test:channels:webchat    # WebChat only
AGENT_URL=http://localhost:6200 bun run test:channels:webhook    # Webhook only
AGENT_URL=http://localhost:6200 bun run test:channels:external   # Slack/Telegram/Discord/WhatsApp/Teams/Email
```

## Environment Variables

| Variable         | Required | Description                                              |
|------------------|----------|----------------------------------------------------------|
| `AGENT_URL`      | Yes      | Base URL of the agent runtime                            |
| `AUTH_COOKIE`    | Staging  | Session cookie for authenticated proxy access            |
| `WEBHOOK_SECRET` | No       | Shared secret if webhook channel has auth configured     |
| `TEST_TIMEOUT`   | No       | Per-test timeout in ms (default: 120000)                 |

## Test Files

### `agent-status.integration.test.ts` — Smoke Tests
- Health endpoint responds with `ok`
- Detailed status lists connected channels
- Channel connectivity matrix report (always passes, prints human-readable output)

### `webchat.integration.test.ts` — WebChat Channel
- Health endpoint returns `healthy`
- Widget config endpoint returns valid configuration
- Session creation and resumption
- **Send message → receive agent reply** (full round-trip through LLM)
- SSE event stream connects and emits `connected` event
- Welcome message via SSE (if configured)
- Widget.js script is served

### `webhook.integration.test.ts` — Webhook Channel
- Health endpoint returns `healthy`
- **Sync message → agent reply** (full round-trip through LLM)
- Input validation (missing message, invalid JSON)
- Auth rejection with wrong secret
- Test message endpoint (`/webhook/test`)
- Activity log returns recent entries
- Outbox polling

### `external-channels.integration.test.ts` — Slack, Telegram, Discord, WhatsApp, Teams, Email
- **Connect/disconnect API lifecycle**: validates that bad/missing credentials fail gracefully
  with clear error messages (tests all 5 channel types)
- **Invalid channel type rejection**: verifies unknown types are rejected
- **WhatsApp webhook**: verification challenge rejects bad tokens, POST always returns 200
- **Teams messaging endpoint**: returns 503 when not configured
- **Status reporting**: all channels report correct connected/disconnected state

## What Can vs Can't Be Tested

| Channel    | Health/Status | Send Message | Receive Message | Connect Validation |
|------------|:---:|:---:|:---:|:---:|
| WebChat    | Yes | Yes (HTTP POST) | Yes (SSE) | N/A (auto-connect) |
| Webhook    | Yes | Yes (HTTP POST) | Yes (sync reply) | N/A (auto-connect) |
| Telegram   | Yes | No (needs Bot API) | No (long polling) | Yes (bad token) |
| Slack      | Yes | No (needs Web API) | No (Socket Mode) | Yes (bad token) |
| Discord    | Yes | No (needs REST API) | No (WebSocket) | Yes (bad token) |
| WhatsApp   | Yes | No (needs Cloud API) | Webhook exists | Yes (bad token) |
| Teams      | Yes | No (needs Bot Framework) | Endpoint exists | Yes (bad creds) |
| Email      | Yes | No (needs SMTP) | No (IMAP) | Yes (missing creds) |

**Why can't we fully test external channels?**
These channels receive messages from external platforms (Slack pushes via WebSocket,
Telegram via long polling, etc.). We can't simulate those inbound events without
real platform credentials and real bot accounts. The tests verify the **agent-side
plumbing** — that the connect/disconnect APIs handle errors properly, webhook
endpoints respond correctly, and status is reported accurately.

## Prerequisites

1. The agent runtime must be running
2. For WebChat/Webhook message tests: those channels must be connected
3. For staging: you need a valid session cookie

### Getting a Session Cookie (Staging)

1. Sign into `https://studio-staging.shogo.ai`
2. Open browser DevTools → Application → Cookies
3. Copy the value of `better-auth.session_token`
4. Pass as `AUTH_COOKIE="better-auth.session_token=<value>"`

## Test Design Notes

- Tests gracefully skip when a channel isn't connected (warns instead of failing)
- Message round-trip tests have 120s timeouts for LLM processing time
- The connectivity report test always passes — for human review
- No Playwright needed; pure HTTP/SSE tests via Bun's test runner
- External channel connect tests intentionally use bad credentials to verify error handling
