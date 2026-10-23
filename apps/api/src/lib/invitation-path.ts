// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one path an invitation resolves to.
 *
 * The invite email and the `invitation_pending` notification both point here,
 * so a change to the accept route lands in both places at once instead of the
 * two drifting apart (the mail kept working while the bell dead-ended).
 */

/** App-relative path of the accept page for `id`. */
export const INVITATION_ACCEPT_PATH = (id: string): string => `/invitations/${id}/accept`
