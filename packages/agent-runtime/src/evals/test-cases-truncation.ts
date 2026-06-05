// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Truncated Tool-Output Recovery Evals (P0 reproduction)
 *
 * Reproduces the Subliminal regression where a large integration payload (a
 * Google Doc) was truncated before the model saw it, and the agent answered
 * from the partial content without noticing the end was missing — confidently
 * omitting the document's actual conclusion.
 *
 * The GOOGLEDOCS_GET_DOCUMENT_BY_ID mock returns only the document opening
 * (with the concluding "FINAL DECISION" paragraph absent), while
 * GOOGLEDRIVE_DOWNLOAD_FILE returns the full export including the unique tail
 * sentence (TRUNCATED_DOCS_TAIL). The agent should detect the content is
 * incomplete and fall back to the Drive export.
 *
 * Pre-fix: agent answers from the truncated Docs payload, missing the tail (RED).
 * Post-fix (structured truncation signal in composio.ts + Docs→Drive guidance):
 * agent downloads the full file and reports HELIOTROPE-7 (GREEN).
 *
 * Track: --track truncation
 */

import type { AgentEval, EvalResult } from './types'
import { usedToolAnywhere, responseContains } from './eval-helpers'
import { TRUNCATED_DOCS_MOCKS, TRUNCATED_DOCS_TAIL } from './tool-mocks'

/** True if the response includes the unique codename only present in the full export. */
function includedTail(r: EvalResult): boolean {
  return r.responseText.includes('HELIOTROPE-7') || responseContains(r, TRUNCATED_DOCS_TAIL)
}

/** True if the agent fell back to a Drive download/export to get the full body. */
function usedDriveFallback(r: EvalResult): boolean {
  return usedToolAnywhere(r, 'GOOGLEDRIVE_DOWNLOAD_FILE') ||
    usedToolAnywhere(r, 'GOOGLEDRIVE_EXPORT_FILE')
}

/** True if the agent (incorrectly) claimed there was no stated decision. */
function claimedNoDecision(r: EvalResult): boolean {
  const t = r.responseText.toLowerCase()
  return /no (final |explicit |stated )?(decision|conclusion|recommendation)/.test(t) ||
    /(doc|document) (does not|doesn't|did not|didn't) (state|contain|include)/.test(t)
}

export const TRUNCATION_EVALS: AgentEval[] = [
  {
    id: 'truncation-docs-drive-fallback',
    name: 'Recover the full Google Doc after a truncated read',
    category: 'tool-system',
    level: 3,
    toolMocks: TRUNCATED_DOCS_MOCKS,
    input: [
      'Open my Google Doc "Architecture Review — Persistence Layer" (id: doc_helio_arch_review).',
      'I only care about one thing: what is the FINAL DECISION / recommendation at the end?',
      'Quote it back to me verbatim.',
    ].join('\n'),
    validationCriteria: [
      {
        id: 'read-the-doc',
        description: 'Agent attempted to read the document',
        points: 2,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'GOOGLEDOCS_GET_DOCUMENT_BY_ID'),
      },
      {
        id: 'used-drive-fallback',
        description: 'Agent fell back to a Drive download/export to get the full body',
        points: 5,
        phase: 'execution',
        validate: (r) => usedDriveFallback(r),
      },
      {
        id: 'reported-the-tail',
        description: 'Final answer includes the concluding decision (HELIOTROPE-7)',
        points: 6,
        phase: 'execution',
        validate: (r) => includedTail(r),
      },
      {
        id: 'did-not-fabricate-absence',
        description: 'Agent did not claim the doc states no decision',
        points: 2,
        phase: 'execution',
        validate: (r) => !claimedNoDecision(r),
      },
    ],
    antiPatterns: [
      'Answered from truncated content without noticing the missing tail',
    ],
    maxScore: 15,
  },
]
