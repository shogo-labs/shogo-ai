/**
 * Tests for `isPublicChannelIngressPath` — webhook ingress paths that are
 * reachable without a Shogo session. Covers all acceptance criteria from
 * SHO-462 §4: near misses, path traversal, and that only /incoming and
 * /outbox/<one-segment> pass, while /health, /activity, /test stay gated.
 */
import { describe, test, expect } from 'bun:test'
import { isPublicChannelIngressPath } from '../middleware/api-auth-gate'

const PRJ = '/api/projects/abc123/agent-proxy'

describe('isPublicChannelIngressPath — webhook (SHO-462)', () => {
  // ── Public paths ──────────────────────────────────────────────────────────
  test('webhook /incoming is public', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/incoming`)).toBe(true)
  })

  test('webhook /outbox/<correlationId> is public', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/outbox/webhook-1748-1`)).toBe(true)
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/outbox/abc`)).toBe(true)
    // complex correlation id with hyphens and underscores
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/outbox/webhook-1748000000-42`)).toBe(true)
  })

  // ── Gated paths that must NOT be public ──────────────────────────────────
  test('webhook /health is NOT public', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/health`)).toBe(false)
  })

  test('webhook /activity is NOT public', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/activity`)).toBe(false)
  })

  test('webhook /test is NOT public', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/test`)).toBe(false)
  })

  // ── Near misses / path traversal ─────────────────────────────────────────
  test('/incomingx suffix is NOT public', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/incomingx`)).toBe(false)
  })

  test('/incoming/ trailing slash is NOT public', () => {
    // Not in the allow list as a bare prefix — only exact match
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/incoming/extra`)).toBe(false)
  })

  test('/outbox/ with no segment is NOT public', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/outbox/`)).toBe(false)
  })

  test('/outbox/a/b (two segments) is NOT public', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/outbox/a/b`)).toBe(false)
  })

  test('/outbox/.. dotdot is NOT public', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/outbox/..`)).toBe(false)
  })

  test('/outbox/%2f percent-encoded slash is NOT public', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/outbox/a%2fb`)).toBe(false)
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/webhook/outbox/a%2Fb`)).toBe(false)
  })

  // ── WhatsApp still works (regression guard) ───────────────────────────────
  test('WhatsApp canonical path still passes', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/agent/channels/whatsapp/webhook`)).toBe(true)
  })

  test('WhatsApp legacy alias still passes', () => {
    expect(isPublicChannelIngressPath(`${PRJ}/webhooks/whatsapp`)).toBe(true)
  })

  // ── Missing project-id prefix ─────────────────────────────────────────────
  test('missing agent-proxy prefix returns false', () => {
    expect(isPublicChannelIngressPath('/agent/channels/webhook/incoming')).toBe(false)
  })
})
