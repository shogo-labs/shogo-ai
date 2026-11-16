// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The guest's one answer to "is this runtime busy?", as `/pool/activity`
 * reports it (SHO-399).
 *
 * It lives here, away from `server.ts`, so the formula can be tested without
 * booting the runtime. Metal's lifecycle gates read the fields this produces —
 * and which fields feed it matters: `tasks` must be local work only, because a
 * card-watch mirror the API owns is not work this runtime is doing.
 */
export function guestBusy(work: { turns: number; tasks: number; liveStreams: number }): boolean {
  return work.turns + work.tasks + work.liveStreams > 0
}
