// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Generates `templates/eng-pod/shogo-system.yaml` from the per-agent folders
 * under `templates/eng-pod/` (`builder/`, `reviewer/`, `coordinator/`).
 *
 * Same idea as `issue-pipeline-manifest-gen.ts`: the folders are the source of
 * truth for prompts and rules, every file under `<agent>/` becomes
 * `projects[].files["<relative path>"]`, and the checked-in YAML is a derived
 * artifact that a test keeps from drifting. The coordinator is the template
 * project itself (the anchor). It has attachments, so it runs in a merged root
 * whose own `AGENTS.md` wins over the project folder's; its prompt and skills
 * therefore go through the manifest too (system_apply writes the anchor's
 * files at that root), taken from the template's `.shogo/` folder.
 *
 * Regenerate after editing any agent folder:
 *
 *   bun run packages/agent-runtime/src/eng-pod-manifest-gen.ts
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify as stringifyYaml } from 'yaml'
import { collectFiles } from './issue-pipeline-manifest-gen'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(__dirname, '..', 'templates', 'eng-pod')

const MODEL = 'claude-sonnet-4-6'
const PROVIDER = 'anthropic'

export const COORDINATOR_KEY = 'coordinator'
export const BUILDER_KEY = 'builder'
export const REVIEWER_KEY = 'reviewer'

export const PROJECT_NAMES = {
  [COORDINATOR_KEY]: 'Engineering Team — Coordinator',
  [BUILDER_KEY]: 'Engineering Team — Builder',
  [REVIEWER_KEY]: 'Engineering Team — Reviewer',
}

/**
 * `#eng` is where the team works, one thread per piece of work. The
 * coordinator watches it (`auto`: it answers only what is its to triage), the
 * builder and reviewer run when tagged, and the reviewer is isolated so it
 * judges from the hand-off and the card alone. `@maintainers` approve merges.
 */
const TEAM_CHANNELS = [
  {
    name: 'eng',
    topic: 'Report a bug or ask for a change. One thread per piece of work, one status card per thread.',
    members: [
      { project: COORDINATOR_KEY, agentTrigger: 'auto' },
      { project: BUILDER_KEY, agentTrigger: 'mention' },
      { project: REVIEWER_KEY, agentTrigger: 'mention', contextMode: 'isolated' },
      { group: 'maintainers' },
    ],
  },
]

/** The anchor's prompt and skills, as paths relative to the project root. */
function coordinatorFiles(): Record<string, string> {
  const shogo = collectFiles(join(TEMPLATE_DIR, '.shogo'))
  const out: Record<string, string> = { 'AGENTS.md': shogo['AGENTS.md']! }
  for (const [rel, content] of Object.entries(shogo)) if (rel.startsWith('skills/')) out[`.shogo/${rel}`] = content
  return { ...out, ...collectFiles(join(TEMPLATE_DIR, 'coordinator')) }
}

export function buildManifest(): unknown {
  // A fresh object per project keeps the YAML free of anchors and aliases.
  const agent = () => ({ model: MODEL, provider: PROVIDER, heartbeat: { enabled: false } })
  return {
    version: 1,
    name: 'Engineering Team',
    description:
      'A coordinator, a builder and an isolated reviewer who work bugs and requests from #eng to a merged pull request, with one status card per thread and a person approving the merge.',
    anchor: COORDINATOR_KEY,
    projects: [
      {
        key: BUILDER_KEY,
        name: PROJECT_NAMES[BUILDER_KEY],
        description: 'Fixes the bug, shows it working in a live preview, opens the pull request and asks for the merge.',
        techStackId: 'react-app',
        agent: agent(),
        attachments: [],
        files: collectFiles(join(TEMPLATE_DIR, 'builder')),
      },
      {
        key: REVIEWER_KEY,
        name: PROJECT_NAMES[REVIEWER_KEY],
        description: 'Judges the pull request against the acceptance criteria from the hand-off alone, without the discussion.',
        agent: agent(),
        attachments: [{ project: BUILDER_KEY, mode: 'readonly' }],
        files: collectFiles(join(TEMPLATE_DIR, 'reviewer')),
      },
      {
        key: COORDINATOR_KEY,
        name: PROJECT_NAMES[COORDINATOR_KEY],
        description: 'Turns reports in #eng into tickets and one task card per thread, and hands the work to the builder.',
        agent: agent(),
        attachments: [
          { project: BUILDER_KEY, mode: 'readwrite' },
          { project: REVIEWER_KEY, mode: 'readwrite' },
        ],
        files: coordinatorFiles(),
      },
    ],
    teamChannels: TEAM_CHANNELS,
  }
}

export function renderManifestYaml(): string {
  const header = [
    '# GENERATED FILE — do not hand-edit.',
    '# Source of truth is the per-agent folders next to this file',
    '# (builder/, reviewer/, coordinator/, and .shogo/ for the coordinator prompt).',
    '#',
    '# Regenerate with:',
    '#   bun run packages/agent-runtime/src/eng-pod-manifest-gen.ts',
    '',
  ].join('\n')
  return `${header}\n${stringifyYaml(buildManifest(), { lineWidth: 0 })}`
}

if (import.meta.main) {
  const outPath = join(TEMPLATE_DIR, 'shogo-system.yaml')
  writeFileSync(outPath, renderManifestYaml(), 'utf-8')
  console.log(`Wrote ${outPath}`)
}
