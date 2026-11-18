// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Size limits for `copy_to_project`, shared by the agent runtime (which packs
 * and imports the archive) and the API (which forwards it and whose Redis
 * tunnel relay reassembles it). One module so the three can never drift: a
 * cap raised here moves the API check and the relay with it (SHO-410).
 */

/** Compressed archive cap. Base64 adds a third on the wire. */
export const TRANSFER_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024

/** The same cap as base64 characters, which is what the wire carries. */
export const TRANSFER_MAX_ARCHIVE_BASE64_CHARS = Math.ceil((TRANSFER_MAX_ARCHIVE_BYTES * 4) / 3) + 4
