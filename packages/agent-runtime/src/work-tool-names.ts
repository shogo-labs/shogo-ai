// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tool names behind the work capabilities (team chat, boards, board
 * management, problems). Kept import-free so `gateway-tools` can build its
 * capability groups without importing the tool modules that import it.
 */

export const CHANNEL_TOOL_NAMES = [
  'team_chat_list',
  'team_chat_read',
  'team_chat_post',
  'team_chat_update',
  'team_chat_search',
  'team_chat_dm',
  'team_chat_add_member',
  'fetch_chat_files',
  'team_chat_doc_read',
  'team_chat_doc_update',
  'team_directory',
  'member_activity',
  'team_chat_question_secret',
  'agent_runs_list',
  'agent_run_stop',
] as const

/** Working cards: `boardsEnabled`. */
export const BOARD_TOOL_NAMES = [
  'board_list',
  'board_summary',
  'board_health',
  'work_item_list',
  'work_item_create',
  'work_item_get',
  'work_item_update',
  'work_item_move',
  'work_item_comment',
  'work_item_bulk_update',
  'work_item_history',
  'work_item_link',
] as const

/** Board structure: `boardAdminEnabled`. */
export const BOARD_ADMIN_TOOL_NAMES = [
  'board_create',
  'board_update',
  'board_archive',
  'board_reorder',
  'column_create',
  'column_update',
  'column_delete',
  'work_template_list',
  'work_template_add',
] as const

/** Problem cards: `problemsEnabled`. */
export const PROBLEM_TOOL_NAMES = ['problem_report', 'problem_occurrences'] as const
