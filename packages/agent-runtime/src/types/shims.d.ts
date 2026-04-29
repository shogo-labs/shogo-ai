// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown"
  type Plugin = (service: TurndownService) => void
  export const gfm: Plugin
  export const tables: Plugin
  export const strikethrough: Plugin
  export const taskListItems: Plugin
}
