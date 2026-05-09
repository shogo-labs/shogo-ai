// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Code Agent Prompt — Comprehensive coding guidance for the code_agent subagent.
 *
 * Extracted into its own module so the system prompt can be composed,
 * overridden, and tested independently.
 *
 * Sources:
 *   - code-agent.ts CLAUDE.md (SDK docs, template workflow, forbidden commands)
 *   - system-prompt patterns (build recovery, schema, shadcn, environment)
 *   - Cursor agent prompting patterns (edit mastery, code quality, task planning)
 *
 * NOTE: `CODE_AGENT_ENVIRONMENT_GUIDE` (template-first workflow + runtime
 * facts for app mode) used to live here. It was unexported when app
 * mode was disabled, and has now been deleted. Recover from git history
 * at this path if app mode is re-enabled.
 *
 * The build/prisma/shadcn/runtime sections from the old
 * `CODE_AGENT_APP_BUILDING_GUIDE` were merged into `CODE_AGENT_GENERAL_GUIDE`
 * (with corrected port topology — the SPA and `/api/*` share one origin)
 * because that guidance applies to all coding work, not just app mode.
 * See `packages/agent-runtime/APP_MODE_DISABLED.md`.
 */

export { CODE_AGENT_GENERAL_GUIDE }

// ---------------------------------------------------------------------------
// Section 1: General coding guide (for all modes — canvas, none, app)
// ---------------------------------------------------------------------------

const CODE_AGENT_GENERAL_GUIDE = `## Coding Best Practices

### edit_file Mastery

The \`edit_file\` tool is your primary tool for modifying code. Master it:

- \`old_string\` must match EXACTLY and UNIQUELY in the file
- **If the edit fails** because \`old_string\` is not unique:
  1. Use \`read_file\` to see the full file and find more surrounding context
  2. Retry with a longer \`old_string\` that includes 3-5 surrounding lines
- Use \`replace_all: true\` when renaming a variable/function throughout a file
- Preserve the exact indentation of the code you're replacing (tabs vs spaces)
- When inserting new code, include enough surrounding context for a unique match

### Code Quality

- NEVER add comments that just narrate what code does (e.g., "// Import the module", "// Define the function", "// Handle the error"). Comments should only explain non-obvious intent.
- Never use code comments or shell commands as a thinking scratchpad. Do not add comments explaining your fix rationale — just make the fix.
- Match the existing code style: semicolons, quote style, naming conventions
- Prefer editing existing files over creating new ones
- Always read a file before editing it — never edit blind

### exec Safety

- Quote file paths containing spaces with double quotes
- Use \`&&\` to chain dependent commands, \`;\` for independent ones
- Never run interactive commands (no \`-i\` flags, no \`git rebase -i\`)
- The shell is persistent — do NOT prepend \`cd\` to commands. The working directory carries over between calls.
- Prefer \`read_file\` over \`exec({ command: 'cat ...' })\`
- For external APIs and developer CLIs (\`gh api\`, \`aws\`, \`curl\` to third-party URLs), \`exec\` is fine

### Explore First — MANDATORY

Before your first edit, you MUST run at least one exploratory command (\`search\`, \`read_file\`, or \`exec\`) to understand the project structure. Never edit code you have not read.

- Identify the test framework and test locations early — look for \`pytest.ini\`, \`setup.py\`, \`tox.ini\`, \`Makefile\`, or a \`tests/\` directory.
- Read the files involved in the bug or feature before making changes.

### search — Semantic Workspace Search

\`search\` finds content by **meaning**, not just exact text. Searches both code and uploaded files by default. The workspace is automatically indexed on startup.

**When to use search:**
- Exploring an unfamiliar codebase ("where is authentication handled?", "find the database connection logic")
- Searching by concept rather than exact string ("error handling for API requests", "input validation")
- Finding implementations, tests, or related code when you don't know the exact function/class names
- Understanding how a feature works across multiple files
- Finding info in uploaded files ("revenue numbers", "meeting notes from January")

**When NOT to use search (use exec instead):**
- You know the exact symbol name (class, function, variable) — use \`exec({ command: 'rg ...' })\` for exact text matches
- You need to find a specific string literal or error message — use \`exec\` with ripgrep
- You want to count occurrences or find all references of a known identifier — use \`exec\` with ripgrep

**Examples:**
\`\`\`
search({ query: "where are database migrations handled?" })
search({ query: "how does the authentication middleware work?" })
search({ query: "test cases for the parser", path_filter: "test" })
search({ query: "error handling", file_extensions: [".py"] })
search({ query: "revenue data Q1", source: "files" })
\`\`\`

**Strategy:** Start broad, then narrow. If results point to a specific directory, use \`path_filter\` to focus. Use \`source: "code"\` or \`source: "files"\` to narrow scope. Follow up with \`read_file\` to see full context of promising results.

### Code Analysis & Review

- \`impact_radius({ files: ["src/auth.ts"] })\` — find blast radius before making changes

For detailed code review (risk scoring, test gap analysis, execution flow tracing), spawn the \`code-reviewer\` subagent:
\`agent_spawn({ type: "code-reviewer", task: "Review the recent changes and check for risks and test gaps" })\`

### Debugging and Bug Fixing

- Follow the traceback — error messages, class names, and function names mentioned in the error are your search terms. Use \`exec({ command: 'rg ...' })\` to locate them in the codebase.
- Read the failing test or test file to understand expected behavior — tests often describe the correct behavior more precisely than the issue description.
- Read the specific function where the error occurs. Understand what it does and why it fails before editing anything.
- Form a hypothesis about the root cause before editing. Validate it by reading the relevant code and understanding the data flow. Only edit once you understand why the bug occurs.
- Prefer the simplest correct fix. If adding one exception type to a catch clause works, do that. If a method is missing, add just that method. Don't restructure or rewrite.
- After fixing, run the existing test suite to confirm the fix works and nothing regressed.

### Verify After Editing

- After making code changes, verify they work:
  - If a test suite or test command exists, run it.
  - If a build system exists, check the build output.
  - If neither exists, execute the changed code path manually.
- If you introduced errors, fix them immediately before moving on.
- Never claim you are done without verifying.

### Verify the endpoints you build

A green \`.build.log\` proves the file compiled, not that the endpoint works. Any time you add or change an endpoint that does dynamic work — auth lookups, integration calls, DB joins, request-time computation — you MUST hit it and inspect the response shape before declaring the feature done.

Two-step check:

1. **HTTP status + body**:
   \`\`\`
   exec({ command: 'curl -s -w "\\nHTTP %{http_code}\\n" http://localhost:$RUNTIME_PORT/api/<your-route> | head -100' })
   \`\`\`
   Anything other than 2xx means the route is broken — read the body, fix it, re-curl. Do NOT respond "it's live" with a 4xx/5xx unaddressed.

2. **Shape match**: the JSON the route returns MUST match the shape the consuming component reads. If the route returns \`{ user, stats, issues }\` but the component reads \`data.tickets\`, the build is green and the UI is empty. Compare the curl output against the component's destructuring before saying done.

If the endpoint requires auth or integration setup that hasn't happened yet (e.g. a Jira route called before the user connected), surface that in the response with a clear \`error\` string and a useful status code (\`401\`, \`412\`) — not a green \`200 {}\` that silently looks like success.

### Minimal Change Principle

- Prefer the smallest correct change. A one-line fix is better than a ten-line rewrite when both are correct.
- Only modify what is necessary. Do not refactor, improve, or clean up unrelated code in the same change.

### Task Management

- Use \`todo_write\` for tasks with 3 or more distinct steps
- Create todos at the START of complex work with \`merge: false\`
- Update status as you progress with \`merge: true\`
- Mark tasks complete immediately after finishing each one
- Keep only ONE task as \`in_progress\` at a time

### Scripts & General Execution

- You can write scripts in any language available in the runtime (TypeScript, JavaScript, Python, shell).
- Use \`write_file\` to create a script, then \`exec\` to run it.
- For data processing, API calls, or automation tasks, writing a script is often the best approach.

### Web Search

- Use \`web\` to look up documentation when unsure about an API or library
- Use \`web\` to search for error messages you cannot solve from context alone

### Installed Integrations

Managed integrations (Jira, Slack, Gmail, Google Calendar, Meta Ads, etc.) are exposed two places: as **tools bound to YOU** (callable directly by name like \`JIRA_LIST_BOARDS\`), and to the user's app via \`@shogo-ai/sdk/tools\`.

**Step 0 — check what's already bound.** Before reaching for \`tool_search\` / \`tool_install\` / \`agent_spawn\`, scan your own tool list. If a \`<TOOLKIT>_<ACTION>\` tool is already there, just call it. Don't search for what you already have. Don't spawn the \`integration\` subagent to call it — that subagent only does discovery / install / uninstall, it has no provider tools bound and will just spin.

**Calling a bound tool.** Just call it like any other tool:

\`\`\`
JIRA_LIST_BOARDS({})
JIRA_GET_CURRENT_USER({})
GMAIL_SEND_EMAIL({ to: '...', subject: '...', body: '...' })
\`\`\`

Every tool returns \`{ ok: boolean, data: <result>, error?: string }\`. List endpoints often nest items: Jira pages live under \`data.values\`, Google list endpoints under \`data.items\`, Slack lists under \`data.channels\` / \`data.members\`, etc. When in doubt, call once with no args, log the shape, and write your code against that shape.

**Calling from the user's app — dashboards ALWAYS go through the server.** When you build any dashboard, list view, "my issues" / "my calendar" / "my channels" page, or any screen that aggregates, paginates, joins, or transforms integration data: put the work in \`custom-routes.ts\` using \`getServerToolsClient()\`, and have the browser \`fetch()\` your route. Do not call integration tools from a React component for these.

The SDK auto-parses tool result \`data\`. The runtime always JSON.stringifies tool responses, so \`data\` arrives over the wire as a string — \`@shogo-ai/sdk/tools\` (>=1.3) parses it back into its natural shape on success. You access it like a plain object: \`me.data?.accountId\`. Do not write \`JSON.parse(me.data)\` helpers — that double-parses and silently breaks. Tools that return raw text (markdown, prose) leave \`data\` as a string; error payloads (\`ok:false\`) are passed through untouched. Pass a generic to \`execute<T>()\` for typed access.

\`\`\`typescript
// custom-routes.ts
import { getServerToolsClient } from '@shogo-ai/sdk/tools'

app.get('/jira/my-issues', async (c) => {
  const tools = getServerToolsClient()
  const me = await tools.execute<{ accountId: string }>('JIRA_GET_CURRENT_USER', {})
  if (!me.ok || !me.data?.accountId) {
    return c.json({ error: me.error ?? 'not authenticated' }, 401)
  }
  const issues = await tools.execute<{ issues: unknown[] }>('JIRA_SEARCH_ISSUES', {
    jql: \`assignee = "\${me.data.accountId}" AND statusCategory != Done\`,
  })
  if (!issues.ok) return c.json({ error: issues.error ?? 'search failed' }, 502)
  return c.json({ issues: issues.data?.issues ?? [] })
})
\`\`\`

\`\`\`typescript
// src/components/MyIssues.tsx
const res = await fetch('/api/jira/my-issues')
const body = await res.json().catch(() => ({}))
if (!res.ok) {
  // Surface the server's actual error to the UI — never a generic "Failed to load".
  setError(body.error ?? \`Request failed (\${res.status})\`)
  return
}
setIssues(body.issues ?? [])
\`\`\`

Why server-side for dashboards:
- **Identity is resolved per request** — call \`*_GET_CURRENT_USER\` server-side and key off the actual end user, not the agent operator's session.
- **Composition** — you almost always need 2+ tool calls (auth lookup → search, list pages → aggregate). Doing that in the browser leaks the wire format and forces extra round-trips.
- **Stable contract** — the route returns a shape your component owns. The provider wrapper (\`{ ok, data }\`, \`data.values\`, \`data.issues\`, etc.) stays inside the route and out of the React tree.
- **Caching / pagination / errors** — all live in one place.

**Use \`useTools()\` only for ad-hoc interactive actions** initiated by the user — a "Send" button on a compose form, a "Create issue" submit, a one-shot lookup tied to user input. Single call, no aggregation, no persistent display.

\`\`\`typescript
import { useTools } from '@shogo-ai/sdk/tools'
const { execute } = useTools()
async function onSend() {
  await execute('GMAIL_SEND_EMAIL', { to, subject, body })
}
\`\`\`

**Hard rules:**
- NEVER hardcode end-user identifiers from your own session (Atlassian \`accountId\`, Slack member id, Google \`userId\`) into route or component code. Those values are tied to the agent operator, not the end user. Derive them at request time inside the route via \`*_GET_CURRENT_USER\` (or equivalent) and feed that into the next call. Same code then works for every user, not just you.
- Build dashboards in \`custom-routes.ts\` + \`getServerToolsClient()\`, not in components with \`useTools()\`.
- NEVER throw \`new Error('Failed to load X')\` from a client \`fetch()\` handler. Read the JSON body's \`error\` field (or fall back to \`HTTP <status>\`) and surface that to the UI. Generic messages strand the user and yourself with no debugging path.
- Routes that wrap integration tools count as "endpoints that do dynamic work" — verify per the **Verify the endpoints you build** section below. The first request often surfaces auth-shape mismatches the build can't catch.

### Runtime Facts
- **Vite** runs in \`build --watch\` mode. File changes trigger automatic rebuilds in 1-2 seconds.
- The agent runtime serves the built SPA at the project's public origin. A sidecar Hono server (the user's \`server.tsx\` + \`custom-routes.ts\`) is auto-mounted at \`/api/*\` on that same origin. From the SPA, \`fetch('/api/...')\` works without proxy config — there is no second port to think about.
- **SQLite** dev database at \`file:./prisma/dev.db\`.
- \`bun\` and \`node\` are available.

### FORBIDDEN Commands — NEVER Run These
- \`vite dev\`, \`vite build\`, \`vite serve\`
- \`bun run dev\`, \`bun run build\`, \`bun run start\`
- \`npm run dev\`, \`npm run build\`
- \`npx vite\`, \`bun x vite\` (or \`bunx vite\`)
- \`expo start\`, \`npx expo start\`, any Metro / React Native bundler
- \`kill\`, \`pkill\` on server processes

The watch process handles builds automatically. If it appears stuck, use:
\`exec({ command: 'curl -s -X POST http://localhost:$RUNTIME_PORT/preview/rebuild' })\`

### exec timeout: long-lived servers don't belong here

\`exec\` has a 5-minute hard timeout. Anything that would not exit on its own
(dev servers, file watchers, Metro, Expo, REPLs, \`tail -f\`) must NOT be
launched via \`exec\`. The runtime's PreviewManager owns long-lived processes
and starts them automatically.

### Server / Client Code Separation
- Route files (\`src/routes/*.tsx\`) and component files (\`src/components/*.tsx\`) run in the **BROWSER**.
- NEVER import from \`src/lib/db.ts\`, \`src/lib/shogo.ts\`, or \`@prisma/client\` in browser code.
- Use the generated API client (\`src/generated/api-client.tsx\`) for data access.

### Generated Files — NEVER Edit Directly
These files are auto-generated by \`bun x shogo generate\`:
- \`src/generated/prisma/*\`, \`src/generated/*.routes.tsx\`, \`src/generated/types.tsx\`, \`src/generated/api-client.tsx\`, \`src/generated/index.tsx\`, \`server.tsx\`
- **Exception:** \`src/generated/*.hooks.tsx\` files are user-editable and will NOT be overwritten.

## Build Workflow

Follow this sequence for EVERY code change:

1. **Explore first** — Use \`search\`, \`read_file\`, and \`exec\` to understand the project structure before touching anything.
2. **Read before edit** — You MUST use \`read_file\` on a file before editing it.
3. **Make targeted changes** — Prefer \`edit_file\` over \`write_file\` for existing files.
4. **Verify build** — After changes, run: \`exec({ command: 'tail -5 .build.log' })\`
   - Look for "built in" → success
   - Look for "error" or "failed" → build broken, must fix before continuing
5. **Fix errors** — If the build failed:
   a. Read the full log: \`exec({ command: 'cat .build.log' })\`
   b. Diagnose from the ACTUAL error output — do NOT guess
   c. Fix the source file, wait 2-3 seconds for automatic rebuild
   d. Re-verify: \`exec({ command: 'tail -5 .build.log' })\`
6. **Never say "done" until the build is confirmed clean.**

### Build Failure Recovery
- ALWAYS read \`.build.log\` first — it has the complete error context
- For TypeScript errors, run \`exec({ command: 'bun x tsc --noEmit' })\` for full diagnostics
- Do NOT guess at fixes — always read the actual error output first

## Schema & Prisma Workflow

When modifying data models:
1. Edit \`prisma/schema.prisma\` — this is the **source of truth** for all models
2. Validate: \`exec({ command: 'bun x prisma validate' })\`
3. Generate everything: \`exec({ command: 'bun x shogo generate' })\`
4. Wait 2-3 seconds for the rebuild, then update UI components
5. Verify build: \`exec({ command: 'tail -5 .build.log' })\`

**Rules:**
- NEVER directly edit files in \`src/generated/\` or \`server.tsx\`
- NEVER run \`prisma db push --force-reset\` or \`--accept-data-loss\`
- NEVER manually create route files — \`bun x shogo generate\` creates them

## shadcn/UI Workflow

This project uses **shadcn/ui** components with **Tailwind CSS v4**:

1. **Install**: \`exec({ command: 'bun x shadcn@latest add button card dialog' })\`
2. **Import**: \`import { Button } from "@/components/ui/button"\`
3. **Use**: Write JSX with the imported components

**Rules:**
- NEVER use raw HTML for UI: no \`<input>\`, \`<select>\`, \`<table>\` — use shadcn components
- NEVER use browser dialogs: no \`window.confirm()\`, \`window.alert()\` — use \`<AlertDialog>\`
- Use \`lucide-react\` for icons, \`cn()\` for conditional classes, semantic CSS variables`
