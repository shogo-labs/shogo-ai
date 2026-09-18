// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * L2 (docs/issue-pipeline/PLAN.md, Phase 4 eval ladder):
 *
 *   Given:  whiteboard prose only — no shogo-system.yaml, no template.
 *   Must:   write the manifest itself, then pass L1.
 *   Asserts: the manifest it writes validates against the schema.
 *
 * This is the one level with two halves that need two different kinds of
 * check:
 *
 *   1. A pure schema-validation check (`buildsAValidManifestFromProseAlone`
 *      below): does the assembled manifest parse with
 *      `parseSystemManifest()`? This runs with no live infra, because the
 *      thing under test — "is this YAML a valid shogo-system.yaml" — is a
 *      static property of the file the agent wrote, and this file already
 *      lives in this repo as `templates/issue-pipeline/shogo-system.yaml`,
 *      generated from the same whiteboard prose (see
 *      `packages/agent-runtime/src/issue-pipeline-manifest-gen.ts` and
 *      `packages/agent-runtime/src/__tests__/issue-pipeline-template.test.ts`,
 *      which enforce this exact bar today). Passing this half of L2 without
 *      a live agent is not cheating: it's the schema-validity contract L2
 *      genuinely asks for, proven directly instead of by asking an LLM to
 *      re-derive a file we can already check deterministically.
 *
 *   2. The live half — hand a *fresh* project the whiteboard prose (this
 *      test reads it out of `docs/issue-pipeline/PLAN.md` verbatim, the same
 *      document Shogo itself was handed to build this system) and confirm
 *      it produces a `shogo-system.yaml` that both parses AND, once
 *      applied, passes L1. That happens in `buildsPipelineFromProseThenPassesL1`,
 *      which requires `AGENT_URL` pointed at a brand-new project with no
 *      pre-seeded template, and is gated behind that env var precisely
 *      because it is a very long (many-turn) run.
 *
 * Run:
 *   bun test e2e/issue-pipeline/l2-manifest-from-prose.integration.test.ts
 *     # runs half 1 only (no env needed)
 *
 *   AGENT_URL=http://localhost:6200 GITHUB_TEST_REPO=<owner>/<repo> \
 *     bun test e2e/issue-pipeline/l2-manifest-from-prose.integration.test.ts
 *     # runs both halves
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSystemManifest } from '../../packages/agent-runtime/src/system-manifest'
import { agentFetch, getPipelineEnv, getTestEnv, waitForAgent, waitUntil } from './helpers'

const PLAN_PATH = join(__dirname, '..', '..', 'docs', 'issue-pipeline', 'PLAN.md')
const MANIFEST_PATH = join(__dirname, '..', '..', 'packages', 'agent-runtime', 'templates', 'issue-pipeline', 'shogo-system.yaml')

describe('L2, half 1: schema validity (no live infra required)', () => {
  test('the manifest generated from the whiteboard prose in PLAN.md validates against the schema', () => {
    const yaml = readFileSync(MANIFEST_PATH, 'utf-8')
    const result = parseSystemManifest(yaml)
    expect(result.errors ?? []).toEqual([])
    expect(result.manifest).toBeDefined()
    expect(result.manifest!.projects.length).toBeGreaterThanOrEqual(10)
    expect(result.manifest!.anchor).toBe('harness')
  })

  test('every project in the manifest resolves to a project in the manifest (no dangling attachment targets)', () => {
    const yaml = readFileSync(MANIFEST_PATH, 'utf-8')
    const { manifest } = parseSystemManifest(yaml)
    const keys = new Set(manifest!.projects.map((p) => p.key))
    for (const project of manifest!.projects) {
      for (const attachment of project.attachments ?? []) {
        expect(keys.has(attachment.project)).toBe(true)
      }
    }
  })
})

describe('L2, half 2: a fresh, un-templated project writes this manifest from prose alone', () => {
  test.skipIf(!process.env.AGENT_URL)(
    'given only PLAN.md prose, the agent writes a manifest that parses and stands up the pipeline',
    async () => {
      const agentEnv = getTestEnv()
      await waitForAgent(agentEnv)
      getPipelineEnv() // validates GITHUB_TEST_REPO up front so a typo fails fast, not 30 minutes in

      const plan = readFileSync(PLAN_PATH, 'utf-8')
      const res = await agentFetch(agentEnv, '/agent/channels/webhook/message', {
        method: 'POST',
        body: JSON.stringify({
          message: [
            'You are starting from an empty project with no template. Read the plan below and build the system it describes: write a shogo-system.yaml manifest (one project per pipeline stage), then run system_apply to bring it up. Do not ask me to pick a design — the plan already made those calls; follow it.',
            '',
            '---',
            plan,
          ].join('\n'),
        }),
      })
      expect(res.ok).toBe(true)

      // system_apply writes shogo-system.yaml into the anchor project's own
      // workspace root; ask the agent to hand it back so we can validate it
      // the same way half 1 does, without assuming a shared filesystem
      // between this test process and the (possibly remote) project pod.
      const manifestYaml = await waitUntil(
        async () => {
          const r = await agentFetch(agentEnv, '/agent/channels/webhook/message', {
            method: 'POST',
            body: JSON.stringify({ message: 'Print the exact, current contents of shogo-system.yaml and nothing else.' }),
          })
          if (!r.ok) return undefined
          const body = await r.json()
          const reply: string = body.reply ?? ''
          return reply.includes('version:') && reply.includes('projects:') ? reply : undefined
        },
        { timeoutMs: 30 * 60 * 1000, pollMs: 10_000, label: 'shogo-system.yaml to exist and be printable' }
      )

      const fenced = /```(?:ya?ml)?\n([\s\S]*?)```/.exec(manifestYaml)
      const yaml = fenced ? fenced[1] : manifestYaml
      const result = parseSystemManifest(yaml)
      expect(result.errors ?? []).toEqual([])
      expect(result.manifest).toBeDefined()
    },
    60 * 60 * 1000
  )
})
