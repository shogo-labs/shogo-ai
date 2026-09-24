// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction: a scheduled email digest paged through Gmail and the
 * no-progress breaker aborted the turn after five successful fetches, because
 * the email bodies contained words like "error", "FAILED", "unable", or
 * numbers like 404 / 500 / 420. Successful data payloads must count as
 * progress no matter what their content says; real tool failures still trip.
 */
import { describe, test, expect } from 'bun:test'
import { LoopDetector } from '../loop-detector'

function gmailPage(snippets: string[], pageToken: string): string {
  return JSON.stringify({
    messages: snippets.map((body, i) => ({
      messageId: `${pageToken}-${i}`,
      labelIds: ['UNREAD', 'INBOX'],
      messageTimestamp: '2026-09-23T18:26:58Z',
      preview: { body, subject: `Thread ${i}` },
    })),
    nextPageToken: `${pageToken}-next`,
  })
}

const PAGES = [
  gmailPage(['Hey, following up on the contract.', 'Also the error on build, for changing the workspace'], 'p1'),
  gmailPage(['BACKEND-NJR - ValidationError: 1 validation error for AgentDifficultyLevelResponse'], 'p2'),
  gmailPage(['Pages are not being indexed due to the following new reason: Soft 404'], 'p3'),
  gmailPage(['A new stage, new speakers, and 500+ companies already on board.'], 'p4'),
  gmailPage(['Web ci-eks-stage FAILED before odin-staging deploy completed'], 'p5'),
  gmailPage(['Incident updated: Mobile users unable to see Work Mode', 'Meeting ID: 420 858 669'], 'p6'),
]

describe('LoopDetector — successful payloads whose content mentions errors', () => {
  test('paging through JSON email results is never flagged as no-progress', () => {
    const d = new LoopDetector()
    d.recordAndCheck('connect', { name: 'gmail' }, { ok: true })

    for (const [i, page] of PAGES.entries()) {
      const result = d.recordAndCheck(
        'GMAIL_FETCH_EMAILS',
        { query: 'newer_than:1d', max_results: 25, page_token: i ? `p${i}-next` : undefined },
        page,
      )
      expect(result.loopDetected).toBe(false)
    }
  })

  test('long plain-text output mentioning errors past its head is progress', () => {
    const d = new LoopDetector()
    const log = `Fetched 120 alert emails for the digest.\n${'.'.repeat(400)}\nSentry: 500 Internal Server Error, deploy FAILED, host unreachable`

    for (let i = 0; i < 6; i++) {
      const result = d.recordAndCheck('read_alerts', { page: i }, `${log} (page ${i})`)
      expect(result.loopDetected).toBe(false)
    }
  })

  test('structured and leading-text tool failures still trip the breaker', () => {
    const d = new LoopDetector()
    const failures: Array<[string, unknown]> = [
      ['exec', { error: '{"error":"Tool exec not found"}' }],
      ['execute', '{"error":"Tool execute not found"}'],
      ['GMAIL_FETCH_EMAILS', '{"successful":false,"data":null}'],
      ['http_get', 'Error: connect ECONNREFUSED 127.0.0.1:9000'],
      ['http_get', { status: 503, body: 'Service Unavailable' }],
    ]

    let last
    for (const [i, [name, output]] of failures.entries()) {
      last = d.recordAndCheck(name, { attempt: i }, output)
    }

    expect(last?.loopDetected).toBe(true)
    expect(last?.reason).toBe('no_progress')
  })
})
