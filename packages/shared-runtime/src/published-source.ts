// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Object key (under the published subdomain, in the published-data bucket)
 * holding the source a server-backed publish shipped.
 *
 * The API pulls it from the editing runtime at publish time and writes it
 * before the published service rolls; the published pod hydrates from it
 * first. Dependency-free so the API can import it without the S3 client.
 */
export const PUBLISHED_SOURCE_KEY = 'source.tar.gz'
