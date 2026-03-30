// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prompt builder for the WebArena benchmark.
 *
 * WebArena tasks require autonomous web navigation using browser tools.
 * The agent uses Playwright MCP tools to interact with self-hosted web
 * environments (e-commerce, CMS, forums, GitLab, maps).
 */

export function buildWebArenaPrompt(opts: {
  taskId: number
  intent: string
  startUrl: string
  sites: Record<string, string>
}): string {
  const { taskId, intent, startUrl, sites } = opts

  const siteList = Object.entries(sites)
    .map(([name, url]) => `  - ${name}: ${url}`)
    .join('\n')

  return [
    `You are an autonomous web agent. Complete the following task by navigating websites using your browser tools.`,
    '',
    '## Task',
    '',
    intent,
    '',
    '## Available Websites',
    '',
    siteList,
    '',
    `## Starting URL`,
    '',
    startUrl,
    '',
    '## Instructions',
    '',
    '1. Start by navigating to the starting URL using `mcp_playwright_browser_navigate`.',
    '2. Use `mcp_playwright_browser_snapshot` to observe the current page state (accessibility tree).',
    '3. Interact with page elements using:',
    '   - `mcp_playwright_browser_click` — click buttons, links, menu items',
    '   - `mcp_playwright_browser_type` — fill in text fields, search boxes',
    '   - `mcp_playwright_browser_navigate` — go to a different URL',
    '4. After each action, take a snapshot to observe the result before proceeding.',
    '5. Complete the task step-by-step. Do not skip steps or make assumptions about page content.',
    '',
    '## Constraints',
    '',
    '- Use ONLY browser tools to interact with the websites. Do NOT use web_fetch or web_search.',
    '- Do NOT make up or assume any content — always read the page first.',
    '- If you need to log in, look for login links/forms on the page.',
    '- When the task is complete, state clearly what you accomplished.',
    '- If you cannot complete the task, explain what went wrong.',
    '',
    `Task ID: ${taskId}`,
  ].join('\n')
}
