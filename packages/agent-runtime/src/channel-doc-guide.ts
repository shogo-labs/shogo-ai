// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The one wording for the channel doc.
 *
 * Two places tell an agent what a channel doc is for: the team-chat system
 * prompt (`TEAM_CHAT_GUIDE`) and the doc block every channel message carries
 * (`channelDocContext` in apps/api). They used to say different things — one
 * of them invited "long content" and `append` — and the doc refilled with card
 * narratives until it hit its 200,000-character limit (SHO-101). The sentences
 * live here so both read the same text, and a test asserts they do.
 *
 * Keep it short: it is injected into the prompt of every agent woken in a
 * channel (`DOC_CONTEXT_CHARS` only shows the doc's first 8,000 characters).
 */
export const CHANNEL_DOC_GUIDE_SENTENCES: readonly string[] = [
  'A channel doc holds durable, cross-card rules every agent in the channel must know: one line per decision, and only when it changes behaviour outside that card.',
  'A finding, a plan, a QA report, a "what I learned on <card>", or anything else specific to one card goes in that card\'s thread with `work_item_comment` (or a file under plans/), never in the channel doc, and a section that restates what a card thread already says is not wanted.',
  'Read it with `team_chat_doc_read`; settle a lasting rule with `team_chat_doc_update` and mention the change briefly in your reply.',
  'When the budget reads warn or critical, do not add a section: fold the new fact into an existing rule with mode "patch_section", or `archive_section` a superseded one first.',
]

export const CHANNEL_DOC_GUIDE = CHANNEL_DOC_GUIDE_SENTENCES.join(' ')
