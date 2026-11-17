// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The `error` a queued row carries while somebody is editing it.
 *
 * An edited row is parked as `failed` so the turn-end drain skips it — the
 * dispatcher only ever claims `pending` rows — and `error` is the one spare
 * field that parks it without a schema change. It is a marker, not a message:
 * the dock renders it as "Editing", never as a dispatch failure.
 */
export const EDITING_QUEUED_MESSAGE_ERROR = "__shogo_editing__"

/** True when a queued row is being edited rather than sitting ready to send. */
export function isEditingQueuedError(error: string | null | undefined): boolean {
  return error === EDITING_QUEUED_MESSAGE_ERROR
}
