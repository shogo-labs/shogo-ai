#!/usr/bin/env bun
/**
 * Voice webhooks management + e2e harness.
 *
 * One script to set up, inspect, and exercise the Twilio + ElevenLabs
 * webhooks used by the Mode B voice telephony stack.
 *
 * Features:
 *   - Starts (or attaches to) an ngrok tunnel pointing at the local API.
 *   - Lists / creates / deletes ElevenLabs post_call_transcription webhooks.
 *   - Rotates and writes `ELEVENLABS_WEBHOOK_SECRET` back to `.env.local`.
 *   - Lists Twilio numbers and rewrites their voice / statusCallback URLs.
 *   - Fires signed synthetic webhook payloads at the local API so you can
 *     verify metering end-to-end without placing a real call.
 *
 * Env (picked up from `.env.local` automatically):
 *   ELEVENLABS_API_KEY        required for el:* commands
 *   TWILIO_ACCOUNT_SID        required for twilio:* commands
 *   TWILIO_AUTH_TOKEN         required for twilio:* and test:twilio
 *   ELEVENLABS_WEBHOOK_SECRET required for test:elevenlabs (auto-populated by el:create)
 *   API_PORT                  defaults to 8002
 *   NGROK_AUTHTOKEN           optional — if unset, uses whatever is in ~/.ngrok2
 *
 * Usage:
 *   bun scripts/voice-webhooks.ts setup                           # end-to-end bootstrap
 *   bun scripts/voice-webhooks.ts tunnel:start
 *   bun scripts/voice-webhooks.ts tunnel:url
 *   bun scripts/voice-webhooks.ts el:list
 *   bun scripts/voice-webhooks.ts el:create <publicUrl>
 *   bun scripts/voice-webhooks.ts el:delete <webhookId>
 *   bun scripts/voice-webhooks.ts twilio:list-numbers
 *   bun scripts/voice-webhooks.ts twilio:update-callbacks <publicUrl> [projectId]
 *   bun scripts/voice-webhooks.ts test:elevenlabs <localApiUrl> [projectId]
 *   bun scripts/voice-webhooks.ts test:twilio <localApiUrl> <projectId>
 *   bun scripts/voice-webhooks.ts status
 *   bun scripts/voice-webhooks.ts doctor
 */

import { spawn, $ } from 'bun'
import { createHmac } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Config + env loading
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dir, '..')
const ENV_PATH = resolve(ROOT, '.env.local')
const API_PORT = Number(process.env.API_PORT ?? 8002)
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels'

/**
 * Minimal .env loader. We intentionally don't pull in dotenv — we only
 * need the four secrets this script cares about, and the file is small.
 */
async function loadEnvLocal(): Promise<Record<string, string>> {
  if (!existsSync(ENV_PATH)) return {}
  const raw = await readFile(ENV_PATH, 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i)
    if (!m) continue
    const [, k, vRaw] = m
    if (!k || vRaw === undefined) continue
    const v = vRaw.replace(/^['"]|['"]$/g, '')
    if (!(k in process.env)) process.env[k] = v
    out[k] = v
  }
  return out
}

/** Upsert a key in `.env.local`, preserving surrounding content. */
async function upsertEnvVar(key: string, value: string): Promise<void> {
  const existing = existsSync(ENV_PATH) ? await readFile(ENV_PATH, 'utf8') : ''
  const line = `${key}=${value}`
  const re = new RegExp(`^${key}=.*$`, 'm')
  const next = re.test(existing)
    ? existing.replace(re, line)
    : existing.endsWith('\n') || existing === ''
      ? existing + line + '\n'
      : existing + '\n' + line + '\n'
  await writeFile(ENV_PATH, next, 'utf8')
  process.env[key] = value
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[voice-webhooks] Missing required env var: ${name}`)
    process.exit(1)
  }
  return v
}

// ---------------------------------------------------------------------------
// ngrok
// ---------------------------------------------------------------------------

interface NgrokTunnel {
  name: string
  public_url: string
  proto: string
  config: { addr: string }
}

async function getNgrokUrl(): Promise<string | null> {
  try {
    const res = await fetch(NGROK_API)
    if (!res.ok) return null
    const json = (await res.json()) as { tunnels: NgrokTunnel[] }
    const https = json.tunnels.find(
      (t) => t.proto === 'https' && t.config.addr.endsWith(`:${API_PORT}`),
    )
    return https?.public_url ?? null
  } catch {
    return null
  }
}

async function ensureNgrok(): Promise<string> {
  const existing = await getNgrokUrl()
  if (existing) {
    console.log(`[ngrok] Reusing existing tunnel: ${existing} → :${API_PORT}`)
    return existing
  }
  console.log(`[ngrok] Starting tunnel on port ${API_PORT}…`)
  const proc = spawn({
    cmd: ['ngrok', 'http', String(API_PORT), '--log=stdout'],
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  })
  // Don't wait for ngrok to finish — detach + poll the local agent API.
  proc.unref?.()
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const url = await getNgrokUrl()
    if (url) {
      console.log(`[ngrok] Tunnel ready: ${url} → :${API_PORT}`)
      return url
    }
  }
  throw new Error(
    `ngrok did not come up within 15s. Is the 'ngrok' CLI installed (brew install ngrok) and authed (ngrok config add-authtoken ...)?`,
  )
}

// ---------------------------------------------------------------------------
// ElevenLabs webhook API
// ---------------------------------------------------------------------------
//
// Reference: https://elevenlabs.io/docs/conversational-ai/workflows/post-call-webhooks
// Endpoints:
//   GET    /v1/workspace/webhooks
//   POST   /v1/workspace/webhooks               body: { name, webhook_url, webhook_events: [...], usage_type }
//   DELETE /v1/workspace/webhooks/:webhook_id
//
// The `auth_connection` secret is returned only on creation. We persist it
// to `.env.local` as ELEVENLABS_WEBHOOK_SECRET immediately.

const EL_BASE = 'https://api.elevenlabs.io'

async function elRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const key = requireEnv('ELEVENLABS_API_KEY')
  const res = await fetch(`${EL_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'xi-api-key': key,
      'Content-Type': 'application/json',
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`ElevenLabs ${init.method ?? 'GET'} ${path} → ${res.status}: ${text}`)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

interface ElWebhook {
  webhook_id: string
  webhook_secret?: string | null
  // `list` responses include these; `create` responses don't.
  name?: string
  webhook_url?: string
  webhook_events?: string[]
  usage?: { usage_type?: string }
  auth_type?: string
}

async function elList(): Promise<ElWebhook[]> {
  const res = await elRequest<{ webhooks: ElWebhook[] }>('/v1/workspace/webhooks')
  return res.webhooks ?? []
}

async function elCreate(publicUrl: string): Promise<ElWebhook> {
  const hookUrl = publicUrl.replace(/\/$/, '') + '/api/voice/elevenlabs/webhook'
  const body = {
    settings: {
      auth_type: 'hmac',
      name: `shogo-post-call-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`,
      webhook_url: hookUrl,
    },
  }
  const res = await elRequest<ElWebhook>('/v1/workspace/webhooks', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  const secret = res.webhook_secret
  if (secret) {
    await upsertEnvVar('ELEVENLABS_WEBHOOK_SECRET', secret)
    console.log('[el] ELEVENLABS_WEBHOOK_SECRET written to .env.local')
  } else {
    console.warn(
      '[el] Webhook created but no HMAC secret returned. Rotate it in the ElevenLabs dashboard\n' +
        '     and paste into .env.local as ELEVENLABS_WEBHOOK_SECRET.',
    )
  }
  return res
}

async function elDelete(id: string): Promise<void> {
  await elRequest(`/v1/workspace/webhooks/${id}`, { method: 'DELETE' })
}

// ---------------------------------------------------------------------------
// Twilio REST API
// ---------------------------------------------------------------------------

const TW_BASE = 'https://api.twilio.com/2010-04-01'

function twAuthHeader(): string {
  const sid = requireEnv('TWILIO_ACCOUNT_SID')
  const token = requireEnv('TWILIO_AUTH_TOKEN')
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
}

async function twRequest<T>(
  path: string,
  init: RequestInit & { form?: Record<string, string> } = {},
): Promise<T> {
  const sid = requireEnv('TWILIO_ACCOUNT_SID')
  const url = `${TW_BASE}/Accounts/${sid}${path}`
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
    Authorization: twAuthHeader(),
  }
  let body: string | undefined
  if (init.form) {
    body = new URLSearchParams(init.form).toString()
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  const res = await fetch(url, { ...init, headers, body: body ?? init.body })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Twilio ${init.method ?? 'GET'} ${path} → ${res.status}: ${text}`)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

interface TwilioNumber {
  sid: string
  phone_number: string
  friendly_name: string
  voice_url: string
  status_callback: string
}

async function twListNumbers(): Promise<TwilioNumber[]> {
  const res = await twRequest<{ incoming_phone_numbers: TwilioNumber[] }>(
    '/IncomingPhoneNumbers.json?PageSize=100',
  )
  return res.incoming_phone_numbers ?? []
}

async function twUpdateNumberCallback(
  sid: string,
  opts: { statusCallback?: string; voiceUrl?: string },
): Promise<TwilioNumber> {
  const form: Record<string, string> = {}
  if (opts.statusCallback) {
    form.StatusCallback = opts.statusCallback
    form.StatusCallbackMethod = 'POST'
  }
  if (opts.voiceUrl) {
    form.VoiceUrl = opts.voiceUrl
    form.VoiceMethod = 'POST'
  }
  return twRequest<TwilioNumber>(`/IncomingPhoneNumbers/${sid}.json`, {
    method: 'POST',
    form,
  })
}

// ---------------------------------------------------------------------------
// Signature helpers (mirror apps/api/src/lib/*)
// ---------------------------------------------------------------------------

function signElevenLabs(secret: string, rawBody: string): string {
  const t = Math.floor(Date.now() / 1000).toString()
  const v0 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return `t=${t},v0=${v0}`
}

function signTwilio(
  authToken: string,
  fullUrl: string,
  params: Record<string, string>,
): string {
  const keys = Object.keys(params).sort()
  let data = fullUrl
  for (const k of keys) data += k + params[k]
  return createHmac('sha1', authToken).update(data).digest('base64')
}

// ---------------------------------------------------------------------------
// Synthetic webhook tests
// ---------------------------------------------------------------------------

async function testElevenLabs(localApiBase: string, projectId?: string) {
  const secret = requireEnv('ELEVENLABS_WEBHOOK_SECRET')
  const url = localApiBase.replace(/\/$/, '') + '/api/voice/elevenlabs/webhook'
  const conversationId = `test-conv-${Date.now()}`
  const payload = {
    type: 'post_call_transcription',
    data: {
      conversation_id: conversationId,
      agent_id: `test-agent-${projectId ?? 'unknown'}`,
      metadata: {
        call_duration_secs: 42,
        phone_call: {
          direction: 'inbound',
          external_number: '+15550001111',
          agent_number: '+15550002222',
          call_sid: `CAtest${Date.now()}`,
        },
      },
    },
  }
  const raw = JSON.stringify(payload)
  const sig = signElevenLabs(secret, raw)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'elevenlabs-signature': sig,
    },
    body: raw,
  })
  const text = await res.text()
  console.log(`[test:elevenlabs] ${res.status} ${res.statusText}`)
  console.log(text)
  if (!res.ok) process.exit(1)
}

async function testTwilio(localApiBase: string, projectId: string) {
  const authToken = requireEnv('TWILIO_AUTH_TOKEN')
  const url = localApiBase.replace(/\/$/, '') + `/api/voice/twilio/status/${projectId}`
  const params: Record<string, string> = {
    AccountSid: requireEnv('TWILIO_ACCOUNT_SID'),
    CallSid: `CAtest${Date.now()}`,
    CallStatus: 'completed',
    CallDuration: '42',
    Direction: 'inbound',
    From: '+15550001111',
    To: '+15550002222',
  }
  const sig = signTwilio(authToken, url, params)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': sig,
    },
    body: new URLSearchParams(params).toString(),
  })
  const text = await res.text()
  console.log(`[test:twilio] ${res.status} ${res.statusText}`)
  console.log(text)
  if (!res.ok) process.exit(1)
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

async function doctor() {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  checks.push({ name: 'ELEVENLABS_API_KEY', ok: !!process.env.ELEVENLABS_API_KEY })
  checks.push({
    name: 'ELEVENLABS_WEBHOOK_SECRET',
    ok: !!process.env.ELEVENLABS_WEBHOOK_SECRET,
    detail: 'run el:create to populate',
  })
  checks.push({ name: 'TWILIO_ACCOUNT_SID', ok: !!process.env.TWILIO_ACCOUNT_SID })
  checks.push({ name: 'TWILIO_AUTH_TOKEN', ok: !!process.env.TWILIO_AUTH_TOKEN })

  try {
    const r = await $`which ngrok`.quiet().text()
    if (!r.trim()) throw new Error('not found')
    checks.push({ name: 'ngrok CLI', ok: true, detail: r.trim() })
  } catch {
    checks.push({
      name: 'ngrok CLI',
      ok: false,
      detail: 'install via `brew install ngrok` or download from https://ngrok.com',
    })
  }

  try {
    const res = await fetch(`http://localhost:${API_PORT}/api/voice/healthz`, {
      method: 'GET',
    }).catch(() => null)
    checks.push({
      name: `API server (localhost:${API_PORT})`,
      ok: !!(res && res.status < 500),
      detail: res ? `HTTP ${res.status}` : 'unreachable',
    })
  } catch {
    checks.push({ name: `API server (localhost:${API_PORT})`, ok: false })
  }

  const ngrokUrl = await getNgrokUrl()
  checks.push({
    name: 'ngrok tunnel',
    ok: !!ngrokUrl,
    detail: ngrokUrl ?? 'not running — `voice-webhooks tunnel:start`',
  })

  console.log('\nvoice-webhooks doctor')
  console.log('─'.repeat(40))
  for (const c of checks) {
    const tag = c.ok ? '✓' : '✗'
    console.log(`${tag}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
  }
  console.log()
  const anyFailed = checks.some((c) => !c.ok)
  if (anyFailed) process.exitCode = 1
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

async function main() {
  await loadEnvLocal()

  const [, , cmd, ...args] = process.argv
  switch (cmd) {
    case 'tunnel:start': {
      const url = await ensureNgrok()
      console.log(url)
      break
    }
    case 'tunnel:url': {
      const url = await getNgrokUrl()
      if (!url) {
        console.error('No ngrok tunnel running.')
        process.exit(1)
      }
      console.log(url)
      break
    }

    case 'el:list': {
      const hooks = await elList()
      if (hooks.length === 0) console.log('(none)')
      for (const h of hooks) {
        console.log(
          `${h.webhook_id}\t${h.name ?? ''}\t${(h.webhook_events ?? []).join(',') || '-'}\t${h.webhook_url ?? ''}`,
        )
      }
      break
    }
    case 'el:create': {
      const publicUrl = args[0] ?? (await getNgrokUrl())
      if (!publicUrl) {
        console.error('Usage: el:create <publicUrl>   (or start a tunnel first)')
        process.exit(1)
      }
      const hook = await elCreate(publicUrl)
      console.log(JSON.stringify(hook, null, 2))
      break
    }
    case 'el:delete': {
      const id = args[0]
      if (!id) {
        console.error('Usage: el:delete <webhookId>')
        process.exit(1)
      }
      await elDelete(id)
      console.log(`Deleted ${id}`)
      break
    }

    case 'twilio:list-numbers': {
      const nums = await twListNumbers()
      if (nums.length === 0) console.log('(none)')
      for (const n of nums) {
        console.log(
          `${n.sid}\t${n.phone_number}\t${n.friendly_name}\n  voiceUrl:       ${n.voice_url || '(none)'}\n  statusCallback: ${n.status_callback || '(none)'}`,
        )
      }
      break
    }
    case 'twilio:update-callbacks': {
      const publicUrl = args[0]
      const filterProject = args[1]
      if (!publicUrl) {
        console.error(
          'Usage: twilio:update-callbacks <publicUrl> [projectId]\n' +
            '  Rewrites every (or just one project\'s) Twilio number status callback\n' +
            '  to point at <publicUrl>/api/voice/twilio/status/<projectId>.',
        )
        process.exit(1)
      }
      // We need the projectId for each number. Pull from VoiceProjectConfig.
      // We don't have Prisma here — hit the API usage endpoint? Simpler: let
      // the user pass the projectId explicitly, or update them all to a
      // placeholder that the status handler can reject loudly.
      if (!filterProject) {
        console.error(
          'For this script we require an explicit projectId so the URL is correct.\n' +
            'Pass it as the second arg: twilio:update-callbacks <publicUrl> <projectId>.',
        )
        process.exit(1)
      }
      const nums = await twListNumbers()
      const statusCallback =
        publicUrl.replace(/\/$/, '') + `/api/voice/twilio/status/${filterProject}`
      for (const n of nums) {
        const updated = await twUpdateNumberCallback(n.sid, { statusCallback })
        console.log(`${n.sid} (${n.phone_number}) → statusCallback=${updated.status_callback}`)
      }
      break
    }

    case 'test:elevenlabs': {
      const local = args[0] ?? `http://localhost:${API_PORT}`
      const projectId = args[1]
      await testElevenLabs(local, projectId)
      break
    }
    case 'test:twilio': {
      const local = args[0] ?? `http://localhost:${API_PORT}`
      const projectId = args[1]
      if (!projectId) {
        console.error('Usage: test:twilio <localApiUrl> <projectId>')
        process.exit(1)
      }
      await testTwilio(local, projectId)
      break
    }

    case 'setup': {
      console.log('1/3  Starting ngrok tunnel…')
      const url = await ensureNgrok()
      console.log()
      console.log('2/3  Registering ElevenLabs post_call_transcription webhook…')
      const hook = await elCreate(url)
      console.log(`   → ${hook.webhook_id}`)
      console.log()
      console.log('3/3  Summary')
      console.log(`   Public URL:        ${url}`)
      console.log(`   EL webhook URL:    ${hook.webhook_url}`)
      console.log(`   EL webhook ID:     ${hook.webhook_id}`)
      console.log(
        `   Twilio status URL: ${url}/api/voice/twilio/status/<projectId>  (set per-number when provisioning)`,
      )
      console.log()
      console.log(
        'Next: restart the API server so it picks up ELEVENLABS_WEBHOOK_SECRET,',
      )
      console.log(
        'then provision a Twilio number via Project → Channels → Phone to exercise the full flow.',
      )
      break
    }

    case 'status': {
      await doctor()
      break
    }
    case 'doctor': {
      await doctor()
      break
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h': {
      console.log(`
voice-webhooks — Twilio + ElevenLabs webhook manager

Commands:
  setup                                     One-shot: tunnel + EL webhook + write secret
  tunnel:start                              Start (or reuse) an ngrok tunnel → :${API_PORT}
  tunnel:url                                Print the live ngrok URL
  el:list                                   List ElevenLabs workspace webhooks
  el:create [publicUrl]                     Create post_call_transcription webhook (writes ELEVENLABS_WEBHOOK_SECRET)
  el:delete <webhookId>                     Delete a webhook
  twilio:list-numbers                       List IncomingPhoneNumbers on the account
  twilio:update-callbacks <publicUrl> <projectId>
                                            Rewrite statusCallback for every number to hit the local tunnel
  test:elevenlabs [localApiUrl] [projectId] Fire a signed synthetic post_call payload
  test:twilio     [localApiUrl] <projectId> Fire a signed synthetic statusCallback payload
  status | doctor                           Print env + tunnel + API server health summary

Reads secrets from .env.local automatically.
`)
      break
    }

    default: {
      console.error(`Unknown command: ${cmd}\n(Try 'help'.)`)
      process.exit(1)
    }
  }
}

main().catch((err) => {
  console.error(err?.message ?? err)
  process.exit(1)
})
