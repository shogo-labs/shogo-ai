// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Check that an environment can receive Composio trigger webhooks.
 *
 * The Composio project's webhook URL is set once per environment in the
 * Composio dashboard (Project settings → Webhooks) to
 * `<API_URL>/api/webhooks/composio`, and its signing secret is stored as
 * `COMPOSIO_WEBHOOK_SECRET` on the API. This script signs a synthetic V3
 * trigger payload exactly the way Composio does and posts it to the endpoint,
 * so a wrong secret or a blocked route shows up before real triggers do.
 *
 * Usage:
 *   COMPOSIO_WEBHOOK_SECRET=... bun scripts/composio-trigger-webhook-check.ts https://studio-staging.shogo.ai
 *
 * Expected: HTTP 200 with `reason: "unknown_trigger"` (the synthetic trigger
 * id matches no subscription). 401 means the secret differs from the API's.
 */

import { createHmac, randomUUID } from 'node:crypto'

const base = (process.argv[2] || process.env.API_URL || 'http://localhost:8002').replace(/\/+$/, '')
const secret = process.env.COMPOSIO_WEBHOOK_SECRET
if (!secret) {
  console.error('COMPOSIO_WEBHOOK_SECRET is not set')
  process.exit(2)
}

const body = JSON.stringify({
  id: `evt_${randomUUID()}`,
  timestamp: new Date().toISOString(),
  type: 'composio.trigger.message',
  metadata: {
    log_id: 'log_check',
    trigger_slug: 'GITHUB_ISSUE_ADDED_EVENT',
    trigger_id: `ti_check_${randomUUID()}`,
    connected_account_id: 'ca_check',
    auth_config_id: 'ac_check',
    user_id: 'shogo_check',
  },
  data: { check: true },
})
const id = `msg_${randomUUID()}`
const timestamp = Math.floor(Date.now() / 1000).toString()
const signature = `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64')}`

const url = `${base}/api/webhooks/composio`
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
  body,
})
const text = await res.text()
console.log(`POST ${url} → ${res.status} ${text}`)
if (res.status !== 200) {
  console.error(res.status === 401
    ? 'The API rejected the signature: its COMPOSIO_WEBHOOK_SECRET differs from the one used here.'
    : res.status === 503
      ? 'The API has no COMPOSIO_API_KEY or COMPOSIO_WEBHOOK_SECRET configured.'
      : 'Unexpected response.')
  process.exit(1)
}
console.log(`OK. Make sure the Composio project webhook URL is set to ${url}.`)
