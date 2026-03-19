# App Mode Disabled — Re-enablement Guide

**Disabled in commit:** `0f416de3` (search: "Disable app building mode across runtime")

To see exactly what changed, run:
```bash
git log --all --oneline --grep="Disable app building mode"
```

App building mode (`'app'` visual mode) has been temporarily disabled. This document
lists every change made and what to revert to turn it back on.

All disabled code is marked with the comment `APP_MODE_DISABLED` across the codebase.
Search for this marker to find every change point:

```bash
rg "APP_MODE_DISABLED" --type ts --type tsx
```

---

## 1. Agent Runtime — Allowed Modes

### `packages/agent-runtime/src/gateway.ts`

**Default `allowedModes`** (config defaults, ~line 345):
```typescript
// CURRENT (disabled):
allowedModes: ['canvas', 'none'],

// RESTORE TO:
allowedModes: ['canvas', 'app', 'none'],
```

**`getAllowedModes()` fallback** (~line 1906):
```typescript
// CURRENT (disabled):
return this.config.allowedModes || ['canvas', 'none']

// RESTORE TO:
return this.config.allowedModes || ['canvas', 'app', 'none']
```

---

## 2. Switch Mode Tool

### `packages/agent-runtime/src/gateway-tools.ts`

**`ModeSwitchHandler` interface** (~line 146-150):
- Add `'app'` back to all three type signatures:
  - `onModeSwitch: (mode: 'canvas' | 'app' | 'none', ...)`
  - `getAllowedModes: () => Array<'canvas' | 'app' | 'none'>`
  - `getActiveMode: () => 'canvas' | 'app' | 'none'`

**`createSwitchModeTool` function** (~line 152-163):
- Add `Type.Literal('app')` back to the mode union parameter
- Add `'app'` back to the type assertion
- Restore the tool description mentioning app mode:
  ```
  'Switch the visual output mode. Both canvas and app surface your agent work.
   "canvas" = your quick display panel (declarative agent dashboard).
   "app" = custom-coded agent interface via code_agent subagent (when canvas
   components are not enough). "none" = conversation only. Start with canvas;
   escalate to app when needed.'
  ```

---

## 3. Template Tools (template_list, template_copy)

### `packages/agent-runtime/src/gateway-tools.ts`

**Uncomment the template tools** (~line 583-670):
- Remove the `/* APP_MODE_DISABLED: ... */` block comment wrapper around
  `APP_TEMPLATE_METADATA`, `createTemplateListTool()`, and `createTemplateCopyTool()`

**Re-register the tools** in `createGatewayTools()` (~line 4265):
```typescript
// CURRENT (disabled):
// APP_MODE_DISABLED: createTemplateListTool(), createTemplateCopyTool(ctx),

// RESTORE TO:
createTemplateListTool(),
createTemplateCopyTool(ctx),
```

---

## 4. Code Agent Subagent

### `packages/agent-runtime/src/subagent.ts`

**Restore import** (~line 93):
```typescript
// CURRENT:
import { CODE_AGENT_CODING_GUIDE } from './code-agent-prompt'

// RESTORE TO:
import { CODE_AGENT_CODING_GUIDE, CODE_AGENT_ENVIRONMENT_GUIDE } from './code-agent-prompt'
```

**Restore `CODE_AGENT_SYSTEM_PROMPT`** (~line 95):
- Add back `template_list, template_copy` to the "Available Tools" list
- Re-include `${CODE_AGENT_ENVIRONMENT_GUIDE}` in the template literal
- Change description back to: "builds applications, writes scripts, and executes commands"

**Restore `code_agent` subagent config** (~line 189):
- Re-add `.app-template` file reading and context injection
- Re-add the "NO TEMPLATE SELECTED" warning when no template exists
- Re-add `'template_list', 'template_copy'` to `toolNames` array
- Change description back to: "Coding subagent that builds apps, writes scripts..."

**Restore canvas subagent prompt** (~line 156):
- Change back to: "If the user needs interactive elements (forms, buttons), suggest switching to app mode."

---

## 5. System Prompts

### `packages/agent-runtime/src/system-prompt.ts`

**`MODE_SWITCHING_GUIDE`** (~line 49):
- Restore the three-mode description (none, canvas, app)
- Restore the "Deciding between canvas and app" section
- Restore the "Canvas is right when" / "App is right when" examples

**`AGENT_OVERVIEW`** (~line 92):
- Restore "Build custom apps" capability bullet
- Restore "App" in the visual modes section
- Restore "Canvas and app mode both serve the same purpose..." text

### `packages/agent-runtime/src/code-agent-prompt.ts`

**Re-export** (~line 15):
```typescript
// CURRENT:
export { CODE_AGENT_CODING_GUIDE, CODE_AGENT_GENERAL_GUIDE }

// RESTORE TO:
export { CODE_AGENT_CODING_GUIDE, CODE_AGENT_ENVIRONMENT_GUIDE, CODE_AGENT_GENERAL_GUIDE, CODE_AGENT_APP_BUILDING_GUIDE }
```

### `packages/agent-runtime/src/gateway.ts` — Prompt Sections

**Restore app mode prompt block** (~line 1502):
- Re-add the `else if (activeMode === 'app')` block with the "App Mode — Custom Agent Interface" section

**Restore app mode in none-mode prompt** (~line 1519):
- Re-add the "App" description in the "Visual Modes Available" section
- Restore examples: "Build a custom control panel" → app, "multi-page interface" → app

**Restore app building guide injection** (~line 1547):
```typescript
// CURRENT:
// APP_MODE_DISABLED: CODE_AGENT_APP_BUILDING_GUIDE no longer injected

// RESTORE TO:
if (activeMode === 'app') {
  parts.push(CODE_AGENT_APP_BUILDING_GUIDE)
}
```

**Restore import** (~line 40):
```typescript
// CURRENT:
import { CODE_AGENT_GENERAL_GUIDE } from './code-agent-prompt'

// RESTORE TO:
import { CODE_AGENT_GENERAL_GUIDE, CODE_AGENT_APP_BUILDING_GUIDE } from './code-agent-prompt'
```

**Restore app template context injection** (~line 1415):
- Un-comment the `.app-template` file reading block that injects "App Template Context"
- Re-add the `!existsSync(appTemplatePath)` guard on the agent template context block

**Restore agent template prompt** (~line 1449):
- Add back: "You work through canvas mode — not app mode."

### `packages/agent-runtime/src/canvas-prompt.ts`

**Restore app mode escalation text** (~line 22):
```
// CURRENT:
Canvas is a declarative, view-only display panel...

// RESTORE TO:
**When canvas components are not enough** — the user needs interactive elements
(buttons, forms), multi-page flows, or specialized visualizations — switch to
**app** mode with `switch_mode("app")` and delegate to the code_agent via
`task({ subagent_type: 'code_agent', prompt: '...' })`. The app connects back
to you via `@shogo-ai/sdk/agent`.
```

**Restore canvas rules** (~line 260):
- Add back: "If the user needs interactive elements, switch to app mode."

---

## 6. UI — Home Page

### `apps/mobile/app/(app)/index.tsx`

- Restore `AppTemplateGalleryCard` import
- Restore `AppTemplateSummary` type import from `../../lib/api`
- Restore `homeAppTemplates` state and `templateMode` state
- Restore `api.getAppTemplates(http)` in `fetchTemplates()`
- Restore `pending_app_template` deep-link `useEffect`
- Restore `handleAppTemplatePress` callback
- Restore the Agents/Apps tab switcher UI and the app templates grid

---

## 7. UI — Templates Page

### `apps/mobile/app/(app)/templates.tsx`

- Restore `AppTemplateGalleryCard` import and `AppTemplateSummary` type
- Restore `APP_FILTER_TABS` constant
- Restore `appTemplates` state and `templateMode` state
- Restore `api.getAppTemplates(http)` in `fetchTemplates()`
- Restore `handleAppTemplatePress` callback
- Restore the Agents/Apps mode toggle UI
- Restore the app template grid rendering
- Restore dynamic header text and filter tabs based on `templateMode`

---

## 8. UI — Project Layout

### `apps/mobile/app/(app)/projects/[id]/_layout.tsx`

- Restore `capturedAppTemplateName` state from params
- Restore the `apply-template` fetch `useEffect` that calls
  `POST /api/projects/:projectId/apply-template`

---

## 9. API Server

### `apps/api/src/server.ts`

**`GET /api/templates`** (~line 1117):
- Restore the `loadTemplates()` call and full template listing

**`POST /api/projects/:projectId/apply-template`** (~line 1135):
- Restore the full implementation: auth check, template copy, preview restart,
  production pod proxy with retry/verify logic

---

## 10. Domain Store

### `packages/domain-stores/src/domain-actions.ts`

**`createProject`** (~line 97):
```typescript
// CURRENT:
const settings = undefined

// RESTORE TO:
const settings = _type === 'APP'
  ? { activeMode: 'app', canvasEnabled: false }
  : undefined
```

---

## 11. Dockerfile — Template Build Stage

### `packages/agent-runtime/Dockerfile.base`

The entire Stage 1 (`template-deps`) was removed. This stage:
1. Copied `packages/sdk/examples` into the build
2. Installed dependencies for each template (`bun install`)
3. Built each template (`prisma generate` + `vite build`)
4. Archived each into `.tar.gz` files with `pigz`

And the final `COPY --from=template-deps` line that placed archives into
`./packages/sdk/templates` was also removed.

**To restore:**
- Re-add the full `FROM oven/bun:1.3-alpine AS template-deps` stage (see git history)
- Re-add: `COPY --chown=appuser:appgroup --from=template-deps /templates/archives ./packages/sdk/templates`
- Update the header comment to mention "pre-built template archives"

---

## Notes

- The `VisualMode` type (`'canvas' | 'app' | 'none'`) was intentionally kept unchanged
  in `packages/sdk/src/agent/types.ts` and `packages/agent-runtime/src/gateway.ts`
  to avoid breaking existing project configs that may have `activeMode: 'app'` persisted.
- The `app-template-card.tsx` component file was not deleted, only its imports were
  commented out.
- The `packages/sdk/examples/` template directories were not modified.
- The `packages/project-runtime/` template copy/list endpoints were not modified
  (they run inside pods and are only called by the now-disabled flows).
- Eval test cases referencing app mode were not modified — they will need updating
  if evals are re-run.
