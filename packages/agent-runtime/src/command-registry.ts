// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shell commands are one source of background tasks; the bookkeeping lives in
 * `TaskRegistry`. This module keeps the older import path working.
 */

export {
  TaskRegistry as CommandRegistry,
  UI_VISIBLE_AFTER_MS,
  type CommandEntry,
  type RunningProcess,
  type RunningProcessSnapshot,
} from './task-registry'
