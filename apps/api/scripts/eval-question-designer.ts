// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live eval of the question designer: runs the real model on the staging
 * fixtures and reports, per message, whether it picked the expected cards.
 * Needs the title model configured (same env as the API).
 *
 *   bun apps/api/scripts/eval-question-designer.ts
 */

import { looksLikeAsk, modelDesigner } from '../src/services/conversation-question-designer'
import { STAGING_FIXTURES, ONCALL_PROMPT } from '../src/__tests__/fixtures/staging-agent-asks'

const OPEN_ONCALL = { id: 'q_oncall', header: 'Alert destination', prompt: ONCALL_PROMPT }
/** Fixtures that only make sense with the platform-oncall question already open. */
const NEEDS_OPEN = new Set(['the same ask again from another agent', 'a later message says the ask is moot'])

let passed = 0
for (const fixture of STAGING_FIXTURES) {
  const text = fixture.text.replaceAll('{me}', '@Russell')
  const open = NEEDS_OPEN.has(fixture.name) ? [OPEN_ONCALL] : []
  if (!looksLikeAsk(text) && !open.length) {
    const ok = fixture.expect.length === 0
    passed += ok ? 1 : 0
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${fixture.name}  (skipped by the text check)`)
    continue
  }
  const started = Date.now()
  const design = await modelDesigner({
    agentName: 'DevOps',
    text,
    recipients: { names: ['Russell'], via: 'mention', anyone: false },
    open,
  }).catch((err) => {
    console.log(`ERROR ${fixture.name}: ${(err as Error).message}`)
    return null
  })
  const got = design?.questions.map((q) => q.interaction) ?? []
  const interactionsOk = JSON.stringify(got) === JSON.stringify(fixture.expect)
  const foldOk = !fixture.design.sameAs?.some(Boolean) || design?.sameAs.includes(OPEN_ONCALL.id)
  const mootOk = !fixture.design.moot?.length || design?.moot.includes(OPEN_ONCALL.id)
  const ok = !!design && interactionsOk && !!foldOk && !!mootOk
  passed += ok ? 1 : 0
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${fixture.name}  expected [${fixture.expect.join(', ')}] got [${got.join(', ')}]${foldOk ? '' : ' (missed the repeat)'}${mootOk ? '' : ' (missed moot)'}  ${Date.now() - started}ms`)
  if (!ok && design) console.log(`      ${JSON.stringify(design.questions.map((q) => ({ header: q.header, prompt: q.prompt })))}`)
}
console.log(`\n${passed}/${STAGING_FIXTURES.length} passed`)
process.exit(passed === STAGING_FIXTURES.length ? 0 : 1)
