// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end smoke test for cloud AI proxy capture, run INSIDE an api pod
 * (it reuses the pod's DB, proxy-token secret and bucket credentials, so no
 * secret ever leaves the cluster). Drive it with ./run.sh, not directly.
 *
 * Phases (argv[2]):
 *   setup       upsert dedicated smoke workspaces (enabled / default+pro /
 *               default+enterprise) with plan grants
 *   traffic     real provider calls through the local proxy for every
 *               captured endpoint; asserts caller responses, proxy_turns,
 *               ai_analysis_turns and consent-by-plan
 *   killswitch  flips the enabled workspace to disabled, waits out the
 *               consent cache, asserts no capture, then restores it
 *   archive     reads today's archive partition and asserts records,
 *               blob dedup, and that no credentials were archived
 *   cleanup     deletes the smoke workspaces (cascades their proxy_turns)
 *
 * RUN (env) ties phases together; the model is picked from /ai/v1/models
 * unless SMOKE_ANTHROPIC_MODEL / SMOKE_OPENAI_MODEL are set.
 */
import { gunzipSync } from 'node:zlib'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '/app/apps/api/src/lib/prisma'
import { generateProxyToken } from '/app/apps/api/src/lib/ai-proxy-token'

const phase = process.argv[2] || 'traffic'
const BASE = `http://127.0.0.1:${process.env.PORT}/api`
const COOKIE_SECRET = 'cookie-secret-do-not-archive'
const SLUG_PREFIX = 'proxy-capture-smoke-'
const WORKSPACES = [
  { key: 'enabled', mode: 'enabled', plan: 'pro' },
  { key: 'default-pro', mode: 'default', plan: 'pro' },
  { key: 'default-ent', mode: 'default', plan: 'enterprise' },
] as const
type WorkspaceKey = (typeof WORKSPACES)[number]['key']

const results: Array<{ name: string; ok: boolean; detail?: unknown }> = []
const check = (name: string, ok: boolean, detail?: unknown) => results.push({ name, ok, detail })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const RUN = process.env.RUN || String(Date.now())
const sess = (name: string) => `pc-smoke-${RUN}-${name}`
const turnsFor = (session: string) => prisma.proxyTurn.findMany({ where: { chatSessionId: session } })

async function workspaceIds(): Promise<Record<WorkspaceKey, string>> {
  const rows = await prisma.workspace.findMany({ where: { slug: { startsWith: SLUG_PREFIX } }, select: { id: true, slug: true } })
  const ids = Object.fromEntries(rows.map((row) => [row.slug.slice(SLUG_PREFIX.length), row.id]))
  for (const ws of WORKSPACES) if (!ids[ws.key]) throw new Error(`missing smoke workspace ${SLUG_PREFIX}${ws.key}; run the setup phase`)
  return ids as Record<WorkspaceKey, string>
}

const token = (workspaceId: string) => generateProxyToken('proxy-capture-smoke', workspaceId, undefined, 30 * 60_000)

async function call(path: string, workspaceId: string, session: string, body: unknown, extra: Record<string, string> = {}, anthropic = false) {
  const proxyToken = await token(workspaceId)
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-chat-session-id': session,
      Cookie: `session=${COOKIE_SECRET}`,
      ...(anthropic ? { 'x-api-key': proxyToken, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${proxyToken}` }),
      ...extra,
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

async function pickModels(workspaceId: string): Promise<{ anthropic: string; openai: string }> {
  const res = await fetch(`${BASE}/ai/v1/models`, { headers: { Authorization: `Bearer ${await token(workspaceId)}` } })
  const models: any[] = ((await res.json()) as any).data || []
  const pick = (provider: string) =>
    models.find((model) => (model.owned_by ?? model.provider) === provider && !/live/i.test(`${model.name} ${model.id}`))?.id
  const anthropic = process.env.SMOKE_ANTHROPIC_MODEL || pick('anthropic')
  const openai = process.env.SMOKE_OPENAI_MODEL || pick('openai')
  if (!anthropic || !openai) throw new Error(`could not pick models from /ai/v1/models: ${JSON.stringify(models.map((m) => m.id))}`)
  return { anthropic, openai }
}

if (phase === 'setup') {
  for (const spec of WORKSPACES) {
    const slug = `${SLUG_PREFIX}${spec.key}`
    const ws = await prisma.workspace.upsert({
      where: { slug },
      create: { name: `Proxy Capture Smoke (${spec.key})`, slug, trainingDataMode: spec.mode, homeRegion: process.env.REGION_ID || null },
      update: { trainingDataMode: spec.mode },
    })
    const grant = await prisma.workspaceGrant.findFirst({ where: { workspaceId: ws.id, note: 'proxy-capture-smoke' } })
    if (!grant) {
      await prisma.workspaceGrant.create({ data: { workspaceId: ws.id, planId: spec.plan, monthlyIncludedUsd: 5, note: 'proxy-capture-smoke' } })
    }
    check(`workspace ready: ${slug}`, true, ws.id)
  }
}

if (phase === 'traffic') {
  const ids = await workspaceIds()
  const { anthropic, openai } = await pickModels(ids.enabled)
  const prompt = (name: string) => `capture-smoke ${RUN} ${name}: reply with exactly the word pong`
  const msg = (name: string) => [{ role: 'user', content: prompt(name) }]
  const calls = {
    chatNonStream: await call('/ai/v1/chat/completions', ids.enabled, sess('chat-nonstream'), { model: anthropic, messages: msg('chat-nonstream'), max_tokens: 20 }),
    chatStream: await call('/ai/v1/chat/completions', ids.enabled, sess('chat-stream'), { model: openai, messages: msg('chat-stream'), stream: true, stream_options: { include_usage: true } }),
    responsesStream: await call('/ai/v1/responses', ids.enabled, sess('responses-stream'), { model: openai, input: prompt('responses-stream'), stream: true, reasoning: { effort: 'low', summary: 'auto' } }),
    anthropicStream: await call('/ai/anthropic/v1/messages', ids.enabled, sess('anthropic-stream'), {
      model: anthropic,
      max_tokens: 200,
      stream: true,
      system: 'You are a capture smoke-test assistant. Use the lookup tool when asked about weather.',
      tools: [{ name: 'lookup_weather', description: 'Look up weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      messages: [{ role: 'user', content: `capture-smoke ${RUN} anthropic-stream: what is the weather in Paris? use the tool.` }],
    }, {}, true),
    desktop: await call('/ai/v1/chat/completions', ids.enabled, sess('desktop'), { model: anthropic, messages: msg('desktop'), max_tokens: 20 }, { 'x-shogo-client': 'desktop' }),
    defaultPro: await call('/ai/v1/chat/completions', ids['default-pro'], sess('default-pro'), { model: anthropic, messages: msg('default-pro'), max_tokens: 20 }),
    defaultEnt: await call('/ai/v1/chat/completions', ids['default-ent'], sess('default-ent'), { model: anthropic, messages: msg('default-ent'), max_tokens: 20 }),
  }

  for (const [name, res] of Object.entries(calls)) check(`caller gets 200: ${name}`, res.status === 200, res.status === 200 ? undefined : res.text.slice(0, 400))
  check('streamed chat body intact for caller', calls.chatStream.text.includes('data:') && calls.chatStream.text.includes('[DONE]'))
  check('anthropic stream returned tool_use to caller', calls.anthropicStream.text.includes('tool_use'))

  await sleep(4000)
  const expectRow = async (name: string, source: string, extra?: (row: any) => boolean) => {
    const rows = await turnsFor(sess(name))
    const row = rows[0]
    check(
      `proxy_turns row: ${name}`,
      rows.length === 1 && row.source === source && !!row.userText?.includes(RUN) && !!row.assistantText && row.inputTokens > 0 && row.outputTokens > 0 && (!extra || extra(row)),
      row && { source: row.source, model: row.resolvedModel, in: row.inputTokens, out: row.outputTokens, reasoning: row.reasoningTokens, tools: row.toolNames, user: row.userText?.slice(0, 60), assistant: row.assistantText?.slice(0, 60) },
    )
  }
  await expectRow('chat-nonstream', 'cloud_runtime')
  await expectRow('chat-stream', 'cloud_runtime')
  await expectRow('responses-stream', 'cloud_runtime')
  await expectRow('anthropic-stream', 'cloud_runtime', (row) => row.toolNames.includes('lookup_weather') && row.assistantText.includes('[tool call: lookup_weather]'))
  await expectRow('desktop', 'desktop_proxy')
  await expectRow('default-pro', 'cloud_runtime')
  const enterprise = await turnsFor(sess('default-ent'))
  check('enterprise default mode NOT captured', enterprise.length === 0, enterprise.length)

  const view: any[] = await prisma.$queryRawUnsafe(
    `select source, "workspaceId", model, "llmCalls" from ai_analysis_turns where "chatSessionId" like $1`,
    `pc-smoke-${RUN}-%`,
  )
  check('ai_analysis_turns exposes proxy rows', view.length === 6 && view.every((row) => row.source !== 'cloud_chat'), view.length)
  console.log(`RUN=${RUN}`)
}

if (phase === 'killswitch') {
  const ids = await workspaceIds()
  const { anthropic } = await pickModels(ids.enabled)
  await prisma.workspace.update({ where: { id: ids.enabled }, data: { trainingDataMode: 'disabled' } })
  try {
    console.log('set disabled; waiting 65s for the consent cache TTL')
    await sleep(65_000)
    const res = await call('/ai/v1/chat/completions', ids.enabled, sess('disabled'), { model: anthropic, messages: [{ role: 'user', content: `capture-smoke ${RUN} disabled: reply pong` }], max_tokens: 20 })
    await sleep(4000)
    check('kill switch: caller still gets 200', res.status === 200, res.status)
    check('kill switch: no proxy_turns row', (await turnsFor(sess('disabled'))).length === 0)
  } finally {
    await prisma.workspace.update({ where: { id: ids.enabled }, data: { trainingDataMode: 'enabled' } })
  }
}

if (phase === 'archive') {
  const s3 = new S3Client({ region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT, forcePathStyle: true })
  const Bucket = process.env.S3_LLM_CAPTURES_BUCKET!
  const day = new Date().toISOString().slice(0, 10)
  const keys: string[] = []
  let continuationToken: string | undefined
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: `v1/region=${process.env.REGION_ID}/date=${day}/`, ContinuationToken: continuationToken }))
    keys.push(...(page.Contents || []).map((object) => object.Key!).filter((key) => key.endsWith('.jsonl.gz')))
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)

  const records: any[] = []
  const blobRefs = new Set<string>()
  let matchedRaw = ''
  for (const Key of keys) {
    const object = await s3.send(new GetObjectCommand({ Bucket, Key }))
    const raw = gunzipSync(Buffer.from(await object.Body!.transformToByteArray())).toString('utf8')
    if (!raw.includes(`pc-smoke-${RUN}-`)) continue
    matchedRaw += raw
    for (const line of raw.split('\n').filter(Boolean)) {
      const record = JSON.parse(line)
      if (!String(record.chatSessionId || '').startsWith(`pc-smoke-${RUN}-`)) continue
      records.push(record)
      for (const ref of JSON.stringify(record.request).match(/v1\/blobs\/[0-9a-f]{64}\.json\.gz/g) || []) blobRefs.add(ref)
    }
  }
  const missingBlobs: string[] = []
  for (const ref of blobRefs) {
    try {
      await s3.send(new GetObjectCommand({ Bucket, Key: ref }))
    } catch {
      missingBlobs.push(ref)
    }
  }
  const summary = records.map((record) => `${record.chatSessionId.slice(`pc-smoke-${RUN}-`.length)}:${record.endpoint}:${record.source}:${record.httpStatus}`)
  check('archive has one record per captured call (6)', records.length === 6, summary)
  check('archive excludes enterprise + disabled sessions', !records.some((record) => /default-ent|disabled/.test(record.chatSessionId)))
  check('archive records carry request + response bodies', records.length > 0 && records.every((record) => record.request && record.response))
  check('system prompts/tools deduped and every referenced blob exists', blobRefs.size > 0 && missingBlobs.length === 0, { refs: blobRefs.size, missingBlobs })
  const toolCalls = records.flatMap((record) => record.response?.tool_calls || [])
  check('streamed tool-call arguments are valid JSON objects', toolCalls.length > 0 && toolCalls.every((call) => {
    try { return typeof JSON.parse(call.arguments) === 'object' } catch { return false }
  }), toolCalls)
  const headerNames = records.flatMap((record) => Object.keys(record.requestHeaders || {}).map((name) => name.toLowerCase()))
  check('no auth/cookie/api-key headers archived', !headerNames.some((name) => /authorization|cookie|api-key/.test(name)), [...new Set(headerNames)])
  const jwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  check('no proxy token or cookie value in archive', !matchedRaw.includes(jwtHeader) && !matchedRaw.includes('Bearer ') && !matchedRaw.includes(COOKIE_SECRET))
  const providerKeys = [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY].filter(Boolean) as string[]
  check('no provider API keys in archive', !providerKeys.some((key) => matchedRaw.includes(key)))
}

if (phase === 'cleanup') {
  const deleted = await prisma.workspace.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } })
  check('smoke workspaces deleted', true, deleted.count)
}

for (const result of results) {
  const detail = result.detail !== undefined && (!result.ok || process.env.VERBOSE) ? `  ${JSON.stringify(result.detail)}` : ''
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${detail}`)
}
console.log(`${results.filter((result) => result.ok).length}/${results.length} passed`)
process.exit(results.every((result) => result.ok) ? 0 : 1)
