// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { FastMCP } from "fastmcp"
import { registerTemplateList } from "./template.list"
import { registerTemplateCopy } from "./template.copy"

/**
 * Register template tools on a FastMCP server instance.
 *
 * Tools:
 * - template.list: List and search available starter templates
 * - template.copy: Copy a template to set up a project
 */
export function registerTemplateTools(server: FastMCP) {
  registerTemplateList(server)
  registerTemplateCopy(server)
}
