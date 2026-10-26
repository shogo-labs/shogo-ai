// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-108 QA — the workspace features that were still on a bare client.
 *
 * `createHttpClient()` carries no remote interceptor, so a screen that builds one
 * reads Shogo Cloud even while one of a paired computer's own workspaces is
 * open. The card's plan says every remaining hit is either converted to the
 * workspace client or listed with a reason; these two are neither, and both name
 * surfaces the machine serves:
 *
 *   - `AgentDefaultModelCard` — the agent profile and Settings → Models read
 *     *and write* `/api/workspaces/:id/agent-default-model`, which
 *     `apps/api/src/routes/workspace-agent.ts` mounts on the machine. A bare
 *     client edits the cloud workspace's agent instead of the one on screen.
 *   - `useIslandChatSession` — a tool approval posts to
 *     `/api/projects/:id/permission-response`, which
 *     `apps/api/src/routes/project-chat.ts` mounts on the machine.
 *
 * Each assertion is a file + the reason, so the day the caller is converted the
 * entry is deleted rather than the test weakened.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '../../../..')

function source(path: string): string {
  return readFileSync(join(REPO, path), 'utf-8')
}

/** A workspace feature that must reach the machine, and the call it makes. */
const MACHINE_SERVED_CALLS: Array<{ file: string; needle: string; why: string }> = [
  {
    file: 'apps/mobile/components/settings/AgentDefaultModelCard.tsx',
    needle: 'createHttpClient()',
    why: 'reads and writes /api/workspaces/:id/agent-default-model — the machine mounts it (workspace-agent.ts)',
  },
  {
    file: 'apps/mobile/components/island/useIslandChatSession.ts',
    needle: 'api.sendPermissionResponse(createHttpClient()',
    why: 'posts /api/projects/:id/permission-response — the machine mounts it (project-chat.ts)',
  },
]

describe('SHO-108 QA — no workspace feature is left on a bare client', () => {
  for (const entry of MACHINE_SERVED_CALLS) {
    test(`${entry.file} uses the workspace client`, () => {
      expect({ file: entry.file, bare: source(entry.file).includes(entry.needle), why: entry.why }).toEqual({
        file: entry.file,
        bare: false,
        why: entry.why,
      })
    })
  }
})
