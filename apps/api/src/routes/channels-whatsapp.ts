// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WhatsApp platform routes — Meta Tech Provider (Embedded Signup) flow.
 *
 * Public entry points (exempt from auth gate):
 *   GET  /api/channels/whatsapp/connect          — hosted signup page
 *   POST /api/channels/whatsapp/connect/complete  — finish signup, upsert binding
 *   GET  /api/channels/whatsapp/webhook           — Meta webhook verification
 *   POST /api/channels/whatsapp/webhook           — Meta webhook delivery
 *
 * Session-authenticated:
 *   POST /api/projects/:projectId/channels/whatsapp/connect-link
 *
 * Cloud-forwarded (from desktop local API, runtime-token auth):
 *   POST /api/channels/whatsapp/connect-link/instance
 */

import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { timingSafeEqual } from 'node:crypto'
import { prisma } from '../lib/prisma'
import { encryptSecret, decryptSecret } from '../lib/secret-crypto'
import { whatsappEmbeddedSignupAvailable } from '../lib/whatsapp-platform'
import { WHATSAPP_API_BASE, WHATSAPP_GRAPH_VERSION, verifyMetaSignature } from '@shogo/shared-runtime/whatsapp-graph'
import { isShogoCloudAuthed } from '../lib/cloud-forwarding'
import { forwardToProjectRuntime } from '../services/agent-call.service'

// ─── Token signing (reuse chat-providers/link.ts pattern) ───────────────────

import { createHmac } from 'node:crypto'

const WA_CONNECT_TTL_MS = 15 * 60 * 1000
const WA_CONNECT_KIND = 'wa-connect'

function waConnectSecret(): string {
  const v = process.env.BETTER_AUTH_SECRET || ''
  if (!v) throw new Error('BETTER_AUTH_SECRET is required for WhatsApp connect tokens')
  return v
}

function signWaState(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', waConnectSecret()).update(`${WA_CONNECT_KIND}.${encoded}`).digest('base64url')
  return `${encoded}.${mac}`
}

interface WaConnectState {
  workspaceId: string
  projectId: string
  userId: string
  instanceId?: string | null
  nonce: string
  exp: number
}

function verifyWaState(token: string | null | undefined): WaConnectState | null {
  const [encoded, mac] = (token ?? '').trim().split('.')
  if (!encoded || !mac) return null
  let expected: Buffer
  try {
    expected = Buffer.from(createHmac('sha256', waConnectSecret()).update(`${WA_CONNECT_KIND}.${encoded}`).digest('base64url'))
  } catch {
    return null
  }
  const given = Buffer.from(mac)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (typeof payload?.exp !== 'number' || payload.exp < Date.now()) return null
    return payload as WaConnectState
  } catch {
    return null
  }
}

// ─── Meta Graph helpers ──────────────────────────────────────────────────────

interface MetaErrorBody { error?: { code?: number; message?: string; fbtrace_id?: string } }

async function graphGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${WHATSAPP_API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    let err: MetaErrorBody = {}
    try { err = await res.json() } catch { /* ignore */ }
    throw Object.assign(new Error(`Meta API ${res.status}: ${err.error?.message ?? res.statusText}`), {
      metaCode: err.error?.code,
      fbtrace_id: err.error?.fbtrace_id,
    })
  }
  return res.json()
}

async function graphPost(path: string, body: unknown, token: string): Promise<unknown> {
  const res = await fetch(`${WHATSAPP_API_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let err: MetaErrorBody = {}
    try { err = await res.json() } catch { /* ignore */ }
    throw Object.assign(new Error(`Meta API ${res.status}: ${err.error?.message ?? res.statusText}`), {
      metaCode: err.error?.code,
      fbtrace_id: err.error?.fbtrace_id,
    })
  }
  return res.json()
}

// ─── Hosted signup page HTML ─────────────────────────────────────────────────

function signupPage(params: { state: string; appId: string; configId: string; errorMsg?: string }): string {
  const { state, appId, configId, errorMsg } = params
  const graphVersion = WHATSAPP_GRAPH_VERSION
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect WhatsApp — Shogo</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh;
         margin: 0; background: #f8fafc; color: #1e293b; }
  .card { background: #fff; border-radius: 16px; box-shadow: 0 4px 32px rgba(0,0,0,.08);
          padding: 2.5rem; max-width: 420px; width: 90%; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  p { color: #64748b; margin: 0 0 1.5rem; font-size: .95rem; }
  .btn { background: #25d366; color: #fff; border: none; border-radius: 10px;
         font-size: 1rem; font-weight: 600; padding: .85rem 2rem; cursor: pointer;
         display: inline-flex; align-items: center; gap: .5rem; transition: background .15s; }
  .btn:hover { background: #1db954; }
  .btn:disabled { background: #94a3b8; cursor: not-allowed; }
  .status { margin-top: 1.5rem; min-height: 1.5rem; color: #64748b; font-size: .9rem; }
  .success { color: #16a34a; font-weight: 600; }
  .error-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;
               color: #dc2626; padding: .75rem 1rem; font-size: .9rem; margin-bottom: 1rem; }
  .wa-icon { width: 24px; height: 24px; }
</style>
</head>
<body>
<div class="card">
  <h1>Connect WhatsApp</h1>
  <p>Works with your existing WhatsApp Business app — your phone keeps working.</p>
  ${errorMsg ? `<div class="error-box">${errorMsg}</div>` : ''}
  <button class="btn" id="connectBtn" onclick="startSignup()">
    <svg class="wa-icon" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
    Connect with Meta
  </button>
  <div class="status" id="status"></div>
</div>
<script>
  var APP_ID   = ${JSON.stringify(appId)};
  var CONFIG_ID = ${JSON.stringify(configId)};
  var STATE    = ${JSON.stringify(state)};
  var sessionInfo = null;
  var oauthCode   = null;

  window.addEventListener('message', function(e) {
    if (e.origin !== 'https://www.facebook.com' && e.origin !== 'https://web.facebook.com') return;
    var d = e.data;
    if (!d || d.type !== 'WA_EMBEDDED_SIGNUP') return;
    if (d.event === 'FINISH' || d.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
      sessionInfo = d.data || {};
      sessionInfo._event = d.event;
      maybeSendComplete();
    } else if (d.event === 'CANCEL') {
      setStatus('Sign-up was cancelled. Close this window and try again.', false);
      document.getElementById('connectBtn').disabled = false;
    } else if (d.event === 'ERROR') {
      setStatus('Meta reported an error. Please try again.', false);
      document.getElementById('connectBtn').disabled = false;
    }
  });

  function fbLoginCallback(response) {
    if (!response || response.status !== 'connected') {
      setStatus('Meta sign-in failed or was cancelled.', false);
      document.getElementById('connectBtn').disabled = false;
      return;
    }
    oauthCode = response.authResponse && response.authResponse.code;
    maybeSendComplete();
  }

  function maybeSendComplete() {
    if (!oauthCode || !sessionInfo) return;
    setStatus('Finishing setup…', false);
    var body = {
      t: STATE,
      code: oauthCode,
      event: sessionInfo._event,
      wabaId: sessionInfo.waba_id,
      phoneNumberId: sessionInfo.phone_number_id,
      businessId: sessionInfo.business_id,
    };
    fetch('/api/channels/whatsapp/connect/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    .then(function(r) { return r.json().then(function(d) { return { status: r.status, body: d }; }); })
    .then(function(r) {
      if (r.body.choose) {
        renderPicker(r.body.choose);
        return;
      }
      if (!r.body.ok) {
        setStatus(r.body.error || 'Setup failed. Please try again.', false);
        document.getElementById('connectBtn').disabled = false;
        return;
      }
      var msg = '\u2705 Connected: ' + (r.body.displayPhoneNumber || r.body.phoneNumberId);
      if (r.body.coexistence) msg += '. Syncing contacts and chats — keep the WhatsApp Business app open for a few minutes.';
      setStatus(msg, true);
      if (window.opener) {
        try { window.opener.postMessage({ type: 'shogo:whatsapp-connected', phoneNumberId: r.body.phoneNumberId }, window.location.origin); } catch(e) {}
        setTimeout(function() { window.close(); }, 3000);
      }
    })
    .catch(function(e) {
      setStatus('Network error. Please try again.', false);
      document.getElementById('connectBtn').disabled = false;
    });
  }

  function renderPicker(numbers) {
    var html = '<p style="font-weight:600;margin-bottom:.75rem">Pick the number to connect:</p>';
    numbers.forEach(function(n) {
      html += '<button class="btn" style="width:100%;margin-bottom:.5rem;justify-content:center" onclick="pickNumber(' + JSON.stringify(n.phoneNumberId) + ')">' + n.displayPhoneNumber + '</button>';
    });
    document.getElementById('status').innerHTML = html;
  }

  function pickNumber(phoneNumberId) {
    if (!oauthCode || !sessionInfo) return;
    document.querySelectorAll('#status button').forEach(function(b) { b.disabled = true; });
    var body = { t: STATE, code: oauthCode, event: sessionInfo._event, wabaId: sessionInfo.waba_id, phoneNumberId: phoneNumberId, businessId: sessionInfo.business_id };
    fetch('/api/channels/whatsapp/connect/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    .then(function(r) { return r.json().then(function(d) { return { status: r.status, body: d }; }); })
    .then(function(r) {
      if (r.body.ok) {
        var msg = '\u2705 Connected: ' + (r.body.displayPhoneNumber || r.body.phoneNumberId);
        if (r.body.coexistence) msg += '. Syncing contacts and chats.';
        setStatus(msg, true);
        if (window.opener) {
          try { window.opener.postMessage({ type: 'shogo:whatsapp-connected', phoneNumberId: r.body.phoneNumberId }, window.location.origin); } catch(e) {}
          setTimeout(function() { window.close(); }, 3000);
        }
      } else {
        setStatus(r.body.error || 'Setup failed.', false);
      }
    });
  }

  function startSignup() {
    document.getElementById('connectBtn').disabled = true;
    setStatus('Opening Meta sign-in…', false);
    FB.login(fbLoginCallback, {
      config_id: CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3',
      },
    });
  }

  function setStatus(msg, success) {
    var el = document.getElementById('status');
    el.className = 'status' + (success ? ' success' : '');
    el.textContent = msg;
  }

  window.fbAsyncInit = function() {
    FB.init({ appId: APP_ID, version: ${JSON.stringify(WHATSAPP_GRAPH_VERSION)}, xfbml: false, cookie: false });
  };
  (function(d,s,id){var js,fjs=d.getElementsByTagName(s)[0];if(d.getElementById(id))return;js=d.createElement(s);js.id=id;js.src='https://connect.facebook.net/en_US/sdk.js';fjs.parentNode.insertBefore(js,fjs);}(document,'script','facebook-jssdk'));
</script>
</body>
</html>`
}

function errorPage(msg: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>WhatsApp Connect — Error</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 32px rgba(0,0,0,.08);padding:2.5rem;max-width:420px;width:90%;text-align:center}
h1{color:#dc2626}p{color:#64748b}</style></head>
<body><div class="card"><h1>Connection Error</h1><p>${msg.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p></div></body></html>`
}

// ─── Route factory ────────────────────────────────────────────────────────────

export type WhatsAppChannelRoutesConfig = {
  resolveUserId: (c: any) => Promise<string | null>
}

export function whatsappChannelRoutes(config: WhatsAppChannelRoutesConfig) {
  const { resolveUserId } = config
  const app = new Hono()

  // ── POST /projects/:projectId/channels/whatsapp/connect-link ──────────────
  app.post('/projects/:projectId/channels/whatsapp/connect-link', async (c) => {
    const userId = await resolveUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)

    const projectId = c.req.param('projectId')
    // Check project access
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    })
    if (!project) return c.json({ error: 'Project not found' }, 404)

    const localMode = process.env.SHOGO_LOCAL_MODE === 'true'

    // Desktop: forward to cloud
    if (localMode && isShogoCloudAuthed()) {
      const shogoApiKey = process.env.SHOGO_API_KEY!
      const deviceId = process.env.SHOGO_DEVICE_ID || ''
      const cloudApiUrl = process.env.SHOGO_PUBLIC_API_URL || process.env.BETTER_AUTH_URL || ''
      if (!cloudApiUrl) return c.json({ code: 'whatsapp_embedded_signup_unavailable', error: 'Cloud API URL not configured' }, 412)
      const res = await fetch(`${cloudApiUrl.replace(/\/$/, '')}/api/channels/whatsapp/connect-link/instance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${shogoApiKey}`,
          'x-shogo-device-id': deviceId,
        },
        body: JSON.stringify({ projectId }),
      })
      const body = await res.json().catch(() => ({})) as any
      return c.json(body, res.status as any)
    }

    if (!whatsappEmbeddedSignupAvailable()) {
      return c.json({ code: 'whatsapp_embedded_signup_unavailable', error: 'WhatsApp Embedded Signup is not configured on this server. Set WHATSAPP_META_APP_ID, WHATSAPP_META_APP_SECRET, and WHATSAPP_ES_CONFIG_ID, or use your own Meta app under Advanced.' }, 412)
    }

    return issueConnectLink(c, { workspaceId: project.workspaceId, projectId, userId, instanceId: null })
  })

  // ── POST /channels/whatsapp/connect-link/instance (desktop forward) ───────
  // Runtime-agnostic; auth is SHOGO_API_KEY. The desktop local API forwards here.
  app.post('/channels/whatsapp/connect-link/instance', async (c) => {
    const authHeader = c.req.header('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!token) return c.json({ error: 'Unauthorized' }, 401)

    // Resolve Instance by API key + device id
    const { resolveApiKey } = await import('./api-keys')
    const keyResult = await resolveApiKey(token).catch(() => null)
    if (!keyResult) return c.json({ error: 'Invalid API key' }, 401)

    const deviceId = c.req.header('x-shogo-device-id') || ''
    const { projectId } = await c.req.json<{ projectId: string }>().catch(() => ({ projectId: '' }))
    if (!projectId) return c.json({ error: 'projectId is required' }, 400)

    if (!whatsappEmbeddedSignupAvailable()) {
      return c.json({ code: 'whatsapp_embedded_signup_unavailable', error: 'WhatsApp Embedded Signup is not configured on this server.' }, 412)
    }

    // Find the instance for this key+device pair
    const instance = deviceId ? await prisma.instance.findFirst({
      where: { userId: keyResult.userId, deviceId },
      select: { id: true, workspaceId: true },
    }) : null

    const workspaceId = instance?.workspaceId ?? keyResult.workspaceId
    if (!workspaceId) return c.json({ error: 'Cannot determine workspace for this device' }, 400)

    return issueConnectLink(c, {
      workspaceId,
      projectId,
      userId: keyResult.userId,
      instanceId: instance?.id ?? null,
    })
  })

  // ── GET /channels/whatsapp/connect (hosted signup page) ──────────────────
  app.get('/channels/whatsapp/connect', async (c) => {
    const t = c.req.query('t')
    const state = verifyWaState(t)
    if (!state) {
      return c.html(errorPage('This link has expired or is invalid. Please request a new one from your Shogo agent.'), 400)
    }

    const appId = process.env.WHATSAPP_META_APP_ID || ''
    const configId = process.env.WHATSAPP_ES_CONFIG_ID || ''
    if (!appId || !configId) {
      return c.html(errorPage('WhatsApp Embedded Signup is not configured on this server.'), 503)
    }

    return c.html(signupPage({ state: t!, appId, configId }))
  })

  // ── POST /channels/whatsapp/connect/complete ─────────────────────────────
  app.post('/channels/whatsapp/connect/complete', async (c) => {
    const body = await c.req.json<{
      t: string
      code: string
      event: string
      wabaId?: string
      phoneNumberId?: string
      businessId?: string
    }>().catch(() => null)

    if (!body?.t || !body.code || !body.event || !body.wabaId) {
      return c.json({ error: 'Missing required fields' }, 400)
    }

    const state = verifyWaState(body.t)
    if (!state) return c.json({ error: 'Invalid or expired connect token' }, 401)

    const appId = process.env.WHATSAPP_META_APP_ID!
    const appSecret = process.env.WHATSAPP_META_APP_SECRET!
    if (!appId || !appSecret) return c.json({ error: 'WhatsApp Embedded Signup is not configured' }, 503)

    const isCoexistence = body.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'

    // 1. Exchange code for business token
    let accessToken: string
    try {
      const tokenRes = await fetch(
        `https://graph.facebook.com/oauth/access_token?client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(body.code)}`,
      )
      if (!tokenRes.ok) {
        const err = await tokenRes.text()
        console.error(`[WhatsApp] Token exchange failed: ${err}`)
        return c.json({ error: 'Failed to exchange Meta code. Please try again.' }, 502)
      }
      const tokenData = await tokenRes.json() as { access_token?: string }
      if (!tokenData.access_token) return c.json({ error: 'No access token returned from Meta' }, 502)
      accessToken = tokenData.access_token
    } catch (err: any) {
      console.error('[WhatsApp] Token exchange error:', err?.message)
      return c.json({ error: 'Network error exchanging Meta code' }, 502)
    }

    // 2. Verify phone number from Graph (never trust client-supplied IDs)
    let phoneNumberId = body.phoneNumberId
    let displayPhoneNumber: string | undefined
    let verifiedName: string | undefined
    let onBizApp = false

    try {
      const pnListData = await graphGet(`${body.wabaId}/phone_numbers`, accessToken) as {
        data?: Array<{ id: string; display_phone_number?: string; verified_name?: string; is_on_biz_app?: boolean; platform_type?: string }>
      }
      const numbers = pnListData.data ?? []

      if (numbers.length > 1 && !phoneNumberId) {
        // Client must pick
        return c.json({
          choose: numbers.map((n) => ({ phoneNumberId: n.id, displayPhoneNumber: n.display_phone_number ?? n.id })),
        })
      }

      const targetId = phoneNumberId || numbers[0]?.id
      const pn = numbers.find((n) => n.id === targetId) || numbers[0]
      if (!pn) return c.json({ error: 'No phone number found in this WABA' }, 400)

      phoneNumberId = pn.id
      displayPhoneNumber = pn.display_phone_number
      verifiedName = pn.verified_name
      onBizApp = !!pn.is_on_biz_app
    } catch (err: any) {
      console.error('[WhatsApp] Phone number lookup failed:', err?.message)
      return c.json({ error: `Failed to verify phone number with Meta: ${err.message}` }, 502)
    }

    if (!phoneNumberId) return c.json({ error: 'Could not determine phone number ID' }, 400)

    // 3. Conflict check: same number, different project
    const existingBinding = await prisma.whatsAppNumberBinding.findUnique({ where: { phoneNumberId } })
    if (existingBinding && existingBinding.projectId !== state.projectId) {
      const otherProject = await prisma.project.findUnique({ where: { id: existingBinding.projectId }, select: { name: true } })
      return c.json({ error: `This number is already connected to ${otherProject?.name ?? 'another project'}. Disconnect it there first.` }, 409)
    }

    // 4. Subscribe WABA to Shogo's app
    try {
      await graphPost(`${body.wabaId}/subscribed_apps`, {}, accessToken)
    } catch (err: any) {
      console.error('[WhatsApp] WABA subscription failed:', err?.message)
      // Non-fatal for the flow
    }

    // 5. Register (non-coexistence only)
    let pin: string | null = null
    if (!isCoexistence && !onBizApp) {
      pin = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('')
      try {
        await graphPost(`${phoneNumberId}/register`, { messaging_product: 'whatsapp', pin }, accessToken)
      } catch (err: any) {
        console.error('[WhatsApp] Register failed:', err?.message, { phoneNumberId })
        return c.json({ error: `Failed to register number with Meta: ${err.message}` }, 502)
      }
    }

    // 6. Upsert binding
    const tokenEncrypted = encryptSecret(accessToken)
    const pinEncrypted = pin ? encryptSecret(pin) : undefined

    const coexistence = isCoexistence || onBizApp

    const binding = await prisma.whatsAppNumberBinding.upsert({
      where: { phoneNumberId },
      create: {
        workspaceId: state.workspaceId,
        projectId: state.projectId,
        instanceId: state.instanceId ?? undefined,
        phoneNumberId,
        wabaId: body.wabaId,
        businessId: body.businessId,
        displayPhoneNumber,
        verifiedName,
        coexistence,
        tokenEncrypted,
        pinEncrypted,
        status: 'active',
        connectedByUserId: state.userId,
      },
      update: {
        workspaceId: state.workspaceId,
        projectId: state.projectId,
        instanceId: state.instanceId ?? undefined,
        wabaId: body.wabaId,
        businessId: body.businessId,
        displayPhoneNumber,
        verifiedName,
        coexistence,
        tokenEncrypted,
        ...(pinEncrypted ? { pinEncrypted } : {}),
        status: 'active',
        statusReason: null,
      },
    })

    // 7. Coexistence sync (one-shot guards)
    let syncError: string | undefined
    if (coexistence && !binding.syncStartedAt) {
      let contactsSyncRequestId: string | undefined
      let historySyncRequestId: string | undefined
      try {
        const syncRes1 = await graphPost(`${phoneNumberId}/smb_app_data`, { sync_type: 'smb_app_state_sync' }, accessToken) as { request_id?: string }
        contactsSyncRequestId = syncRes1.request_id
      } catch (err: any) {
        console.error('[WhatsApp] smb_app_state_sync failed:', err?.message, { phoneNumberId })
        syncError = `Contacts sync error: ${err.message}`
      }
      try {
        const syncRes2 = await graphPost(`${phoneNumberId}/smb_app_data`, { sync_type: 'history' }, accessToken) as { request_id?: string }
        historySyncRequestId = syncRes2.request_id
      } catch (err: any) {
        console.error('[WhatsApp] history sync failed:', err?.message, { phoneNumberId })
        syncError = syncError ? `${syncError}; History sync error: ${err.message}` : `History sync error: ${err.message}`
      }
      await prisma.whatsAppNumberBinding.update({
        where: { phoneNumberId },
        data: {
          contactsSyncRequestId,
          historySyncRequestId,
          syncStartedAt: new Date(),
          ...(syncError ? { statusReason: syncError } : {}),
        },
      })
    }

    // 8. Push channel into runtime
    const pushPayload = JSON.stringify({
      type: 'whatsapp',
      config: {
        credentialSource: 'platform',
        phoneNumberId,
        wabaId: body.wabaId,
        displayPhoneNumber,
      },
    })
    try {
      await forwardToProjectRuntime(
        c,
        state.projectId,
        state.workspaceId,
        '/agent/channels/connect',
        pushPayload,
        { timeoutMs: 8_000, retryOnTransportError: false, reportUndelivered: false },
      )
    } catch (err: any) {
      console.warn('[WhatsApp] Could not push channel to runtime (will reconcile on start):', err?.message)
    }

    return c.json({
      ok: true,
      phoneNumberId,
      displayPhoneNumber,
      verifiedName,
      coexistence,
      runtimePushed: true,
      ...(syncError ? { syncWarning: syncError } : {}),
    })
  })

  // ── GET /channels/whatsapp/webhook (Meta verification) ───────────────────
  app.get('/channels/whatsapp/webhook', (c) => {
    const mode = c.req.query('hub.mode')
    const token = c.req.query('hub.verify_token')
    const challenge = c.req.query('hub.challenge')

    if (mode !== 'subscribe' || !token || !challenge) return c.text('Forbidden', 403)

    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || ''
    if (!verifyToken) return c.text('Forbidden', 403)

    const expected = Buffer.from(verifyToken)
    const received = Buffer.from(token)
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return c.text('Forbidden', 403)

    return c.text(challenge)
  })

  // ── POST /channels/whatsapp/webhook (Meta webhook delivery) ──────────────
  app.post('/channels/whatsapp/webhook', async (c) => {
    const rawBody = await c.req.text()
    const sigHeader = c.req.header('x-hub-signature-256') || ''
    const appSecret = process.env.WHATSAPP_META_APP_SECRET || ''

    if (!verifyMetaSignature(rawBody, sigHeader, appSecret)) {
      console.warn('[WhatsApp/webhook] Signature mismatch')
      return c.text('Forbidden', 403)
    }

    let body: any
    try { body = JSON.parse(rawBody) } catch { return c.text('Bad Request', 400) }

    // Fan out by binding
    const groups = new Map<string, { binding: any; changes: any[] }>()

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const phoneId = change?.value?.metadata?.phone_number_id
        const wabaId = change?.value?.account_update?.waba_info?.waba_id ?? entry.id

        let bindingId: string | undefined
        if (phoneId) {
          const b = await prisma.whatsAppNumberBinding.findUnique({
            where: { phoneNumberId: phoneId },
            select: { id: true, projectId: true, workspaceId: true, instanceId: true, status: true },
          })
          if (b) bindingId = b.id
        } else if (wabaId) {
          const b = await prisma.whatsAppNumberBinding.findFirst({
            where: { wabaId },
            select: { id: true, projectId: true, workspaceId: true, instanceId: true, status: true },
          })
          if (b) bindingId = b.id
        }

        if (!bindingId) {
          console.log('[WhatsApp/webhook] Unknown phone/WABA — dropping:', { phoneId, wabaId })
          continue
        }

        if (!groups.has(bindingId)) {
          const b = await prisma.whatsAppNumberBinding.findUnique({
            where: { id: bindingId },
            select: { id: true, projectId: true, workspaceId: true, instanceId: true, status: true },
          })
          if (b) groups.set(bindingId, { binding: b, changes: [] })
        }
        groups.get(bindingId)?.changes.push({ ...change, _entryId: entry.id })
      }
    }

    // Deliver to each binding's project runtime
    const deliveries = Array.from(groups.values()).map(async ({ binding, changes }) => {
      // Handle PARTNER_REMOVED
      for (const ch of changes) {
        if (ch.field === 'account_update' && ch.value?.event === 'PARTNER_REMOVED') {
          await prisma.whatsAppNumberBinding.update({
            where: { id: binding.id },
            data: { status: 'disconnected', statusReason: ch.value.disconnection_info?.reason ?? 'partner_removed' },
          }).catch(() => {})
        }
      }

      const payload = JSON.stringify({
        object: body.object,
        entry: [{ id: changes[0]?._entryId ?? '', changes: changes.map(({ _entryId: _, ...rest }) => rest) }],
      })

      // Check home region (workspace.homeRegion vs this pod's region)
      const wsRow = await prisma.workspace.findUnique({
        where: { id: binding.workspaceId },
        select: { homeRegion: true },
      })
      const homeRegion = wsRow?.homeRegion
      const currentRegion = process.env.SHOGO_REGION || process.env.AWS_DEFAULT_REGION || ''
      if (homeRegion && homeRegion !== currentRegion) {
        const regionKey = homeRegion.toUpperCase().replace(/-/g, '_')
        const peerApiUrl = process.env[`SHOGO_PEER_API_URL_${regionKey}`]
        if (peerApiUrl) {
          const fwd = await fetch(`${peerApiUrl}/api/channels/whatsapp/webhook`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-hub-signature-256': `sha256=${createHmac('sha256', appSecret).update(payload).digest('hex')}`,
            },
            body: payload,
          })
          if (!fwd.ok) throw new Error(`Peer region ${homeRegion} returned ${fwd.status}`)
          return
        }
      }

      await forwardToProjectRuntime(
        c,
        binding.projectId,
        binding.workspaceId,
        '/agent/channels/whatsapp/relay',
        payload,
        { timeoutMs: 8_000, retryOnTransportError: false, reportUndelivered: false },
      )
    })

    const results = await Promise.allSettled(deliveries)
    const anyFailed = results.some((r) => r.status === 'rejected')

    if (anyFailed) {
      results.forEach((r) => {
        if (r.status === 'rejected') console.error('[WhatsApp/webhook] Delivery failed:', r.reason)
      })
      // Return 503 so Meta retries; dedupe in runtime makes this safe
      return c.text('Service Unavailable', 503)
    }

    return c.text('OK', 200)
  })

  return app
}

// ─── Shared helper ────────────────────────────────────────────────────────────

export async function issueConnectLinkForRuntime(
  c: any,
  opts: { workspaceId: string; projectId: string; userId: string; instanceId: string | null },
) {
  return issueConnectLink(c, opts)
}

async function issueConnectLink(
  c: any,
  opts: { workspaceId: string; projectId: string; userId: string; instanceId: string | null },
) {
  const exp = Date.now() + WA_CONNECT_TTL_MS
  const token = signWaState({
    workspaceId: opts.workspaceId,
    projectId: opts.projectId,
    userId: opts.userId,
    instanceId: opts.instanceId,
    nonce: randomBytes(8).toString('hex'),
    exp,
  })

  const publicApiUrl = (
    process.env.SHOGO_PUBLIC_API_URL ||
    process.env.BETTER_AUTH_URL ||
    'http://localhost:8002'
  ).replace(/\/$/, '')

  const url = `${publicApiUrl}/api/channels/whatsapp/connect?t=${encodeURIComponent(token)}`
  return c.json({ url, expiresAt: new Date(exp).toISOString() })
}
