// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Generates `templates/issue-pipeline/shogo-system.yaml` from the per-module
 * folders under `templates/issue-pipeline/` (`intake/`, `analyst/`, ...
 * `retrospective/`) plus `findings.schema.json`.
 *
 * This lives under `src/` (not next to the template it generates) purely so
 * it can be a normal TypeScript module under this package's `rootDir` —
 * `tsc` requires every statically-imported file to live under `src`, and
 * `src/__tests__/issue-pipeline-template.test.ts` imports `renderManifestYaml`
 * to assert the checked-in YAML hasn't drifted from the module folders.
 *
 * The module folders are the source of truth for prompts/skills/schemas —
 * every file under `<module>/` becomes `projects[].files["<relative path>"]`
 * in the manifest, using the exact relative path a live project would have
 * on disk (`AGENTS.md`, `HEARTBEAT.md`, `.shogo/skills/<name>/SKILL.md`,
 * `prisma/schema.prisma`). The manifest itself is a derived, checked-in
 * artifact — regenerate it after editing any module folder:
 *
 *   bun run packages/agent-runtime/src/issue-pipeline-manifest-gen.ts
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify as stringifyYaml } from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(__dirname, '..', 'templates', 'issue-pipeline')

type AttachMode = 'readwrite' | 'readonly'

interface ModuleSpec {
  key: string
  name: string
  description: string
  techStackId?: string
  model: string
  heartbeat: boolean
  heartbeatInterval?: number
  /** Manifest keys this module attaches to (read-write or read-only), for on-disk file access. */
  attachments?: Array<{ project: string; mode: AttachMode }>
  /** When true, also inline findings.schema.json at this module's workspace root. */
  needsFindingsSchema?: boolean
}

// ---------------------------------------------------------------------------
// Topology — see docs/issue-pipeline/PLAN.md for the design this encodes.
// ---------------------------------------------------------------------------

const ANCHOR_KEY = 'harness'
const ANCHOR_NAME = 'Issue Pipeline — Harness'

const MODULES: ModuleSpec[] = [
  {
    key: 'intake',
    name: 'Issue Pipeline — Intake',
    description: 'Front door: task-source adapters (GitHub/Jira/built-in), reproduction, and reply routing. Owns the actual repo checkout.',
    techStackId: 'react-app',
    model: 'claude-haiku-4-5',
    heartbeat: true,
    heartbeatInterval: 1800,
  },
  {
    key: 'analyst',
    name: 'Issue Pipeline — Analyst',
    description: 'Root-cause analysis and 5 solution options for a human to pick from.',
    model: 'claude-sonnet-4-6',
    heartbeat: false,
    attachments: [{ project: 'intake', mode: 'readonly' }],
  },
  {
    key: 'planner',
    name: 'Issue Pipeline — Planner',
    description: 'Turns the picked option into a concrete implementation plan with regression/integration tests.',
    model: 'claude-sonnet-4-6',
    heartbeat: false,
    attachments: [{ project: 'intake', mode: 'readonly' }],
  },
  {
    key: 'implementer',
    name: 'Issue Pipeline — Implementer',
    description: 'Executes the plan, loops with reviewers and Done Gate, opens the PR.',
    model: 'claude-sonnet-4-6',
    heartbeat: false,
    attachments: [{ project: 'intake', mode: 'readwrite' }],
  },
  {
    key: 'security',
    name: 'Issue Pipeline — Security',
    description: 'Fast, read-only security review — structured findings only.',
    model: 'claude-haiku-4-5',
    heartbeat: false,
    attachments: [{ project: 'intake', mode: 'readonly' }],
    needsFindingsSchema: true,
  },
  {
    key: 'scalability',
    name: 'Issue Pipeline — Scalability',
    description: 'Fast, read-only scalability review — structured findings only.',
    model: 'claude-haiku-4-5',
    heartbeat: false,
    attachments: [{ project: 'intake', mode: 'readonly' }],
    needsFindingsSchema: true,
  },
  {
    key: 'dry',
    name: 'Issue Pipeline — Dry',
    description: 'Fast, read-only DRY review — structured findings only.',
    model: 'claude-haiku-4-5',
    heartbeat: false,
    attachments: [{ project: 'intake', mode: 'readonly' }],
    needsFindingsSchema: true,
  },
  {
    key: 'done-gate',
    name: 'Issue Pipeline — Done Gate',
    description: 'Capable-model judge: is it done, and what is the verdict on every finding.',
    model: 'claude-sonnet-4-6',
    heartbeat: false,
    attachments: [{ project: 'intake', mode: 'readonly' }],
    needsFindingsSchema: true,
  },
  {
    key: 'retrospective',
    name: 'Issue Pipeline — Retrospective',
    description: 'Findings database and the in-the-wild prompt-evolution loop.',
    techStackId: 'react-app',
    model: 'claude-sonnet-4-6',
    heartbeat: true,
    heartbeatInterval: 3600,
    attachments: [
      { project: 'planner', mode: 'readwrite' },
      { project: 'implementer', mode: 'readwrite' },
      { project: 'security', mode: 'readwrite' },
      { project: 'scalability', mode: 'readwrite' },
      { project: 'dry', mode: 'readwrite' },
    ],
    needsFindingsSchema: true,
  },
]

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function collectFiles(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) {
      Object.assign(out, collectFiles(abs, base))
    } else if (st.isFile()) {
      const rel = relative(base, abs).split('\\').join('/')
      out[rel] = readFileSync(abs, 'utf-8')
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Build manifest object
// ---------------------------------------------------------------------------

export function buildManifest(): unknown {
  const findingsSchema = readFileSync(join(TEMPLATE_DIR, 'findings.schema.json'), 'utf-8')

  const projects = MODULES.map((m) => {
    const files = collectFiles(join(TEMPLATE_DIR, m.key))
    if (m.needsFindingsSchema) files['findings.schema.json'] = findingsSchema
    return {
      key: m.key,
      name: m.name,
      description: m.description,
      ...(m.techStackId ? { techStackId: m.techStackId } : {}),
      agent: {
        model: m.model,
        heartbeat: {
          enabled: m.heartbeat,
          ...(m.heartbeatInterval ? { interval: m.heartbeatInterval } : {}),
        },
      },
      attachments: m.attachments ?? [],
      files,
    }
  })

  // Anchor entry: attaches read-write to every module so `system_apply`
  // (run from the harness project) can write each module's files. The
  // harness's own AGENTS.md/HEARTBEAT.md ship via template.json/.shogo, not
  // through the manifest's `files` map.
  projects.push({
    key: ANCHOR_KEY,
    name: ANCHOR_NAME,
    description: 'Anchor project: owns shogo-system.yaml and runs system_apply. Does not analyse, plan, or write code.',
    agent: { model: 'claude-sonnet-4-6', heartbeat: { enabled: true, interval: 3600 } },
    attachments: MODULES.map((m) => ({ project: m.key, mode: 'readwrite' as AttachMode })),
    files: {},
  })

  return {
    version: 1,
    name: 'Issue Pipeline',
    description:
      'Self-assembling multi-agent pipeline: every incoming issue is reproduced, analysed into 5 options, planned, implemented, reviewed (security/scalability/DRY), gated, and shipped as a PR. See docs/issue-pipeline/PLAN.md.',
    anchor: ANCHOR_KEY,
    projects,
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export function renderManifestYaml(): string {
  const header = [
    '# GENERATED FILE — do not hand-edit.',
    '# Source of truth is the per-module folders next to this file',
    '# (intake/, analyst/, planner/, implementer/, security/, scalability/, dry/,',
    '# done-gate/, retrospective/) plus findings.schema.json.',
    '#',
    '# Regenerate with:',
    '#   bun run packages/agent-runtime/src/issue-pipeline-manifest-gen.ts',
    '',
  ].join('\n')
  const body = stringifyYaml(buildManifest(), { lineWidth: 0 })
  return `${header}\n${body}`
}

if (import.meta.main) {
  const outPath = join(TEMPLATE_DIR, 'shogo-system.yaml')
  writeFileSync(outPath, renderManifestYaml(), 'utf-8')
  console.log(`Wrote ${outPath}`)
}
