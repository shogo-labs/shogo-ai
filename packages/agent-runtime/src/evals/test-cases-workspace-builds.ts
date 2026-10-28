// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace-build evals (SHO-195, regression for SHO-194).
 *
 * In staging session `545d935e` a workspace chat was asked to build a
 * portfolio and built the whole app into the **workspace root**: it read the
 * leftover pool template's `src/App.tsx`, edited `prisma/schema.prisma` and
 * ran `bun add three` at the root, and never called `project_create`.
 *
 * SHO-194 fixed the two causes (the leftover pool pre-seed, and an `AGENTS.md`
 * that described the root as a Vite app). These evals keep the whole family
 * fixed:
 *
 *   - every case boots a real multi-project WORKSPACE runtime
 *     (`AgentEval.workspaceRuntime`), which no eval did before — every other
 *     suite runs the agent the way a single-project pod does;
 *   - `ws-build-trap-preseed` reproduces the staging trap exactly by seeding the
 *     runtime template into the root before the turn;
 *   - every case carries the same three load-bearing criteria — no app files in
 *     the root, a root that is still clean on disk, and the project a
 *     workspace build has to go through — each worth more than 30 points, so
 *     missing *any* one of them drops the case below the runner's 70% bar
 *     (three at 34/33/33). A case cannot pass by claiming success while the
 *     files landed in the root, and cannot pass by refusing to build at all.
 *
 * `project_create` / `project_call` / `project_list` / `mount_project` /
 * `goal_create` are mocked, so a case costs one model turn and spawns no real
 * project.
 *
 * The graders are pure functions of an `EvalResult` and are unit-tested with no
 * LLM in `test-cases-workspace-builds.test.ts`, including session
 * `545d935e`'s exact tool sequence.
 */

import type { AgentEval, EvalResult, ToolCallRecord, ValidationCriterion } from './types'
import type { ToolMockMap, ToolMockSpec } from './tool-mocks'
import { cliExecMock } from './tool-mocks'
import { usedTool, responseContains } from './eval-helpers'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Ids are UUID-shaped like the real runtime's project folders. */
export const PORTFOLIO_ID = '8f14e45f-ceea-467a-9d1e-1b7a6f3c9a01'
/** What `project_create` answers with — the project the agent then works in. */
export const CREATED_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

/**
 * Name the mocked create reports. Deliberately neutral: a mock that answered
 * `"Portfolio site"` to a request for a run tracker made the agent refuse to
 * touch the project it had just created ("that would change your portfolio"),
 * which failed the case for the wrong reason.
 */
const CREATED_NAME = 'New project'

const PORTFOLIO_FILES: Record<string, string> = {
  'package.json': '{\n  "name": "portfolio",\n  "private": true\n}\n',
  'index.html': '<!doctype html><html><body><div id="root"></div></body></html>\n',
  'src/App.tsx': 'export default function App() {\n  return <main>Portfolio</main>\n}\n',
}

const PORTFOLIO_CATALOG_ENTRY = {
  id: PORTFOLIO_ID,
  name: 'portfolio',
  description: 'My personal portfolio site',
  techStackId: 'vite-react',
  manifestKey: null,
  isCurrent: false,
  mounted: false,
  onDisk: true,
}

/**
 * A tool whose only mocked shape is the `project`-addressed one.
 *
 * Reaching another project runs the tool inside that project's runtime, which
 * an eval has no container for: unmocked, the API answers `401 Unauthorized`
 * and the turn reads as a broken session. A call with no `project` is the
 * agent's own work in this workspace, so it must fall through to the real tool.
 */
function remoteArm(response: any): ToolMockSpec {
  return {
    type: 'pattern',
    patterns: [{ match: { project: 're:.+' }, response }],
    default: '__passthrough',
  }
}

/**
 * Mocked workspace tools: no real project is created, nothing is billed.
 *
 * Both listing tools are mocked: the gateway exposes `list_projects` while the
 * workspace agent's own project tool is `project_list`, and an unmocked call
 * reaches the real API and comes back `401 Unauthorized` — which reads to the
 * agent as a broken session and derails the turn.
 */
export const WORKSPACE_TOOL_MOCKS: ToolMockMap = {
  project_create: {
    type: 'static',
    response: {
      ok: true,
      project: { id: CREATED_ID, name: CREATED_NAME, workspaceId: 'eval-workspace' },
      attachment: { projectId: CREATED_ID, mode: 'readwrite' },
      // Not mounted on purpose: an eval workspace cannot conjure a second
      // project's folder, and a mock that claimed one sent the agent looking
      // for a directory that does not exist instead of delegating.
      mounted: false,
      note:
        `The project exists. Its files are not mounted in this workspace — hand the build to it ` +
        `with project_call (project: "${CREATED_ID}"), whose runtime writes and previews them.`,
    },
  },
  project_call: {
    type: 'static',
    response: {
      ok: true,
      project: { id: CREATED_ID, name: CREATED_NAME },
      runId: 'eval-run-1',
      reply:
        `Done — the one-page site is built in the ${CREATED_NAME} project ` +
        `(${CREATED_ID}) and its preview is live there.`,
    },
  },
  project_list: {
    type: 'static',
    response: {
      workspaceId: 'eval-workspace',
      currentProjectId: null,
      projects: [PORTFOLIO_CATALOG_ENTRY],
    },
  },
  list_projects: {
    type: 'static',
    response: {
      workspaceId: 'eval-workspace',
      currentProjectId: null,
      projects: [PORTFOLIO_CATALOG_ENTRY],
    },
  },
  mount_project: {
    type: 'static',
    response: { ok: true, mounted: true, projectId: PORTFOLIO_ID, mode: 'readwrite' },
  },
  // Reaching a project remotely: `connect_project` wakes the other runtime and
  // lists the tools that take a `project` parameter. An eval has no other
  // runtime to wake, so unmocked it answers 401 and the metal path reads as a
  // broken session. No id is echoed back — the agent already has the one it
  // passed, and a fixed id would misdescribe the project it actually named.
  connect_project: {
    type: 'static',
    response: {
      ok: true,
      reachable: true,
      readOnly: false,
      tools: ['exec', 'exec_wait', 'exec_list', 'read_file', 'write_file', 'edit_file', 'delete_file', 'search'],
      note: 'Pass `project: "<id>"` to those tools to run them inside it.',
    },
  },
  // The same tools called with `project` route to that project's runtime, which
  // an eval has no container for either. Only the project-scoped form is
  // mocked: a plain `exec` has no `project` param and falls through to the real
  // tool, so grading still sees the files the agent writes here. Built on
  // cliExecMock so the gh/CLI safety patterns every eval carries still win.
  exec: cliExecMock({
    patterns: [
      {
        match: { project: 're:.+' },
        response: { ok: true, exitCode: 0, stdout: '', stderr: '', cwd: '/' },
      },
    ],
  }),
  // The rest of the remote allowlist. Each one, addressed to a project, runs in
  // that project's own runtime — the last 401 source in this track, hit by
  // `read_file { project }` in metal and in the unmounted-portfolio case. Only
  // the `project` arm is answered; without it the call is the agent's own work
  // in this workspace and falls through to the real tool.
  read_file: remoteArm({ ok: true, content: '', bytes: 0 }),
  write_file: remoteArm({ ok: true, bytes: 0 }),
  edit_file: remoteArm({ ok: true, replacements: 1 }),
  delete_file: remoteArm({ ok: true, deleted: true }),
  search: remoteArm({ ok: true, results: [] }),
  exec_wait: remoteArm({ ok: true, status: 'completed', exitCode: 0, stdout: '' }),
  exec_list: remoteArm({ ok: true, tasks: [] }),
  copy_to_project: remoteArm({ ok: true, copied: [] }),
  // `preview_project` and `share_file` reach the API for a running-project URL
  // and a signed link. Unmocked they answer 401 inside an eval, and the turn
  // ends with "I couldn't confirm the result" instead of "built" — a mock the
  // agent cannot tell from the real thing, so the turn is graded on its build
  // behaviour rather than on an auth error it can never fix.
  preview_project: {
    type: 'static',
    response: {
      ok: true,
      status: 'running',
      url: `https://preview.eval.shogo.test/p/${CREATED_ID}/`,
      builtAt: 'eval',
    },
  },
  share_file: {
    type: 'static',
    response: {
      ok: true,
      url: 'https://files.eval.shogo.test/f/eval-link',
      filename: 'index.html',
      size: 1024,
      expiresAt: '2026-11-01T00:00:00.000Z',
      path: 'index.html',
      linkPath: 'index.html',
    },
  },
  goal_create: {
    type: 'static',
    response: { ok: true, goal: { id: 'eval-goal-1', status: 'active', steps: [] } },
  },
  // A personal workspace may answer a build request by filing a goal, and a
  // team workspace may tidy the catalog afterwards. Both reach the API, which
  // an eval sandbox has no identity for, so both answer here (QA round 2:
  // real trials lost a turn each to `goal_log` and `unmount_project` 401s).
  goal_log: {
    type: 'static',
    response: { ok: true, goal: { id: 'eval-goal-1', status: 'active', steps: [] } },
  },
  goal_update: {
    type: 'static',
    response: { ok: true, goal: { id: 'eval-goal-1', status: 'active', steps: [] } },
  },
  unmount_project: {
    type: 'static',
    response: { ok: true, unmounted: true },
  },
}

/** A team workspace with no projects — the staging shape. */
const TEAM_EMPTY = { kind: 'team' as const }

const TEAM_WITH_PORTFOLIO_MOUNTED = {
  kind: 'team' as const,
  projects: [{ id: PORTFOLIO_ID, name: 'portfolio', mounted: true, files: PORTFOLIO_FILES }],
}

const TEAM_WITH_PORTFOLIO_UNMOUNTED = {
  kind: 'team' as const,
  projects: [{ id: PORTFOLIO_ID, name: 'portfolio', mounted: false }],
}

// ---------------------------------------------------------------------------
// Graders
// ---------------------------------------------------------------------------

/** Directory names that only ever belong to an app, never to a workspace root. */
const ROOT_DIR = /^(src|prisma|public|components|dist)(\/|$)/i
/** Files that are an app's entry points and manifests. */
const ROOT_FILE = /^(package\.json|vite\.config\.[jt]s|index\.html|server\.tsx?|custom-routes\.tsx?|tsconfig(\.[\w-]+)*\.json|tailwind\.config\.\w+)$/i
/** Source extensions: written outside a project folder, these are app code in the root. */
const APP_SOURCE = /\.(tsx|jsx|html|css)$/i
/**
 * Root scaffolding a workspace agent legitimately writes. A workspace root is
 * allowed to hold its own notes, memory and skills — `notes/today.md` is a
 * normal answer to "write my notes down", not a root build.
 */
const ROOT_SCAFFOLD = /^(AGENTS\.md|WORKSPACE\.md|MEMORY\.md|TOOLS\.md|HEARTBEAT\.md|STACK\.md|README\.md|\.shogo\/|memory\/|notes\/|data\/|files\/|skills\/|\.tmp\/|\.git\/)/i

/**
 * `cd <dir>` — the way a command moves into a project folder. Not global: it is
 * used with `.match()` to read the capture group, which a `g` flag turns into a
 * list of whole matches instead.
 */
const CD_TARGET = /\bcd\s+["']?([^\s"';&|)]+)/i
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * A segment that *starts* a package-manager or build command. Anchored on
 * purpose: an earlier version matched the verb anywhere in the line and
 * flagged `ls node_modules | rg -i '^(prisma|@prisma)'` — a read — as a root
 * build. The `npx` / `bun x` arms name the binaries that install or build;
 * a bare `bun x tsc --noEmit` is a typecheck, not a build.
 */
const BUILD_SEGMENT =
  /^(?:bun\s+(?:add|install|i)\b|npm\s+(?:i|install|add)\b|pnpm\s+(?:i|install|add)\b|yarn\s+(?:add|install)\b|(?:npx|bunx)\s+(?:vite|prisma|shadcn|tailwindcss)\b|bun\s+x\s+(?:vite|prisma|shadcn|tailwindcss)\b|vite\s+build|prisma\s+(?:db|generate|migrate))/i

/**
 * True when a shell command installs or builds **outside** a project folder.
 *
 * Walks the command segment by segment so a `cd <uuid>/ …` anywhere in the
 * chain covers the commands after it, and a read that merely mentions
 * `prisma` is not mistaken for an install.
 */
export function buildCommandOutsideProject(command: string, startsInProject: string | null = null): boolean {
  const { rootBuild } = walkCommand(command, startsInProject)
  return rootBuild
}

/**
 * Replay one shell command.
 *
 * The runtime's shell keeps its working directory between `exec` calls, so
 * whether a later `cat > src/App.tsx` lands in the root or in a project depends
 * on an earlier call's `cd`. `builtInRoot` threads that state through the run;
 * this function replays a single command and reports both what it wrote/build at
 * the root and where the shell should be afterwards.
 */
export function walkCommand(
  command: string,
  startsInProject: string | null,
): { rootWrite: string | null; rootBuild: boolean; endsIn: string | null; wrote: boolean } {
  const segments = command
    .split(/&&|\|\||;|\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
  let inProject = startsInProject
  /** Levels below the current project folder (or below the root, when none). */
  let depth = 0
  let rootWrite: string | null = null
  let rootBuild = false
  let wrote = false

  for (const raw of segments) {
    const segment = raw.replace(/^(?:time|timeout\s+\d+)\s+/i, '')
    if (/^cd\s/i.test(segment)) {
      const target = segment.match(CD_TARGET)?.[1] ?? ''
      const parts = normalizeToolPath(target)
        .split('/')
        .filter((part) => part && part !== '.')
      const project = parts.find((part) => UUID_SEGMENT.test(part))
      if (project) {
        inProject = project
        depth = parts.length - parts.indexOf(project) - 1
      } else if (target.startsWith('/')) {
        // An absolute path with no project folder in it is the workspace root.
        inProject = null
        depth = 0
      } else {
        // A relative `cd` moves within where the shell already is:
        // `cd .tmp/x` from a project is still that project, and only a `..`
        // that pops past the project folder is back in the root.
        for (const part of parts) {
          if (part !== '..') {
            depth += 1
            continue
          }
          depth -= 1
          if (depth < 0) {
            inProject = null
            depth = 0
          }
        }
      }
      continue
    }
    // Writes that bypass write_file entirely (`cat > src/App.tsx`), judged
    // against the directory the shell is actually in.
    const redirect = /(?:>|>>|tee\s+(?:-a\s+)?)\s*["']?([^\s"'|;&]+)/g
    for (const m of segment.matchAll(redirect)) {
      const target = m[1]
      wrote = true
      const absolute = target.startsWith('/')
      if (!absolute && !inProject && isRootAppPath(target) && !rootWrite) rootWrite = normalizeToolPath(target)
    }
    if (!inProject && BUILD_SEGMENT.test(segment)) rootBuild = true
  }

  return { rootWrite, rootBuild, endsIn: inProject, wrote }
}

/** Strip the leading `./` and any absolute workspace prefix from a tool path. */
export function normalizeToolPath(path: string): string {
  let p = path.trim().replace(/\\/g, '/')
  p = p.replace(/^\.\//, '').replace(/^\/+/, '')
  return p
}

/** True when a path's first segment is a project folder (`<uuid>/…`). */
export function inProjectFolder(path: string): boolean {
  return UUID_SEGMENT.test(normalizeToolPath(path).split('/')[0] ?? '')
}

/**
 * True when a repo-relative path names an app artifact in the workspace root.
 * Project folders, root scaffolding, and paths written with an explicit
 * `project` argument (metal runtimes address project files that way) are not.
 */
export function isRootAppPath(path: string): boolean {
  const p = normalizeToolPath(path)
  if (!p) return false
  if (inProjectFolder(p)) return false
  if (ROOT_DIR.test(p) || ROOT_FILE.test(p)) return true
  if (ROOT_SCAFFOLD.test(p)) return false
  // An app nested one level down in the root (`bakery/package.json`) is still
  // a root build: workspaces have real projects, not folders of files.
  const base = p.split('/').pop() ?? ''
  if (ROOT_FILE.test(base)) return true
  return APP_SOURCE.test(p)
}

/** A tool call that came back an error wrote nothing. */
function callFailed(call: ToolCallRecord): boolean {
  const output: any = call.output
  if (!output || typeof output !== 'object') return false
  if (output.ok === false) return true
  return typeof output.error === 'string' && output.error.length > 0
}

/** App-code paths a file tool wrote into the workspace root. `exec` is handled by `builtInRoot`. */
function rootPathsForCall(call: ToolCallRecord): string[] {
  // `write_file { path: 'src/App.tsx', project: '<id>' }` writes into that
  // project, not the root — the metal runtime's addressing.
  const explicitProject = call.input?.project
  if (typeof explicitProject === 'string' && explicitProject.trim()) return []

  if (call.name !== 'write_file' && call.name !== 'edit_file') return []
  // `edit_file { path: 'src/App.tsx' }` on a root that has no such file comes
  // back `File not found` and writes nothing, so it is not a root build. The
  // disk check (`workspaceRootClean`) is what proves the outcome either way.
  if (callFailed(call)) return []
  const raw = call.input?.path
  if (typeof raw === 'string' && isRootAppPath(raw)) return [normalizeToolPath(raw)]
  return []
}

/**
 * True when the run built an app in the workspace root. This is the grader the
 * whole card exists for: it returns **true on a violation**, so every case
 * fails when it is true.
 *
 * Fails on a `write_file` / `edit_file` of app code in the root (`src/...`,
 * `package.json`, `vite.config.ts`, or a stray `.tsx` / `.html` folder), on a
 * shell write or install doing the same, and it replays the shell's working
 * directory across the run because the runtime's shell keeps it: after
 * `cd <uuid>`, a `cat > src/App.tsx` writes inside the project, while
 * `write_file` stays root-relative either way.
 */
export function builtInRoot(result: EvalResult): boolean {
  let shellIn: string | null = null
  for (const call of result.toolCalls) {
    if (call.name === 'exec') {
      const command = typeof call.input?.command === 'string' ? call.input.command : ''
      if (!command) continue
      const step = walkCommand(command, shellIn)
      if (step.rootWrite || step.rootBuild) return true
      shellIn = step.endsIn
      continue
    }
    if (rootPathsForCall(call).length > 0) return true
  }
  return false
}

/** The id (`project.create`) the agent was given, read back from the tool output. */
function createdProjectId(create: ToolCallRecord): string | null {
  const output = create.output as any
  const id =
    output?.project?.id ??
    output?.id ??
    (typeof output === 'string' ? output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] : null)
  if (typeof id === 'string' && id.length > 0) return id
  const serialized = JSON.stringify(output ?? '')
  return serialized.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null
}

function callTargetsProject(call: ToolCallRecord, id: string): boolean {
  if (call.name !== 'project_call' && call.name !== 'mount_project' && call.name !== 'connect_project') return false
  const serialized = JSON.stringify(call.input ?? {}).toLowerCase()
  return serialized.includes(id.toLowerCase())
}

/**
 * True when the agent created a project and then delegated the work to that
 * same project. The order matters: a `project_call` before the create cannot
 * be the same project.
 *
 * Every create is considered, not just the first: a rejected attempt (wrong
 * arguments, so no id comes back) followed by a good one still delegated, and
 * grading the failed attempt alone scored a correct run 0.
 */
export function createdThenDelegated(result: EvalResult): boolean {
  const calls = result.toolCalls
  for (let createIndex = 0; createIndex < calls.length; createIndex++) {
    if (calls[createIndex].name !== 'project_create') continue
    const id = createdProjectId(calls[createIndex])
    if (!id) continue
    if (calls.some((call, i) => i > createIndex && callTargetsProject(call, id))) return true
  }
  return false
}

/**
 * True when the agent worked in the project the user already has — called it,
 * mounted it, or edited under `<id>/` — and did not create another one.
 */
export function usedExistingProject(result: EvalResult, projectId: string): boolean {
  if (result.toolCalls.some((c) => c.name === 'project_create')) return false
  let shellIn: string | null = null
  for (const call of result.toolCalls) {
    if (callTargetsProject(call, projectId)) return true
    const explicitProject = call.input?.project
    if (typeof explicitProject === 'string' && explicitProject.toLowerCase().includes(projectId)) return true
    if (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'read_file') {
      const path = typeof call.input?.path === 'string' ? normalizeToolPath(call.input.path) : ''
      if (path.startsWith(`${projectId}/`)) return true
      continue
    }
    if (call.name === 'exec') {
      const command = typeof call.input?.command === 'string' ? call.input.command : ''
      if (!command) continue
      const step = walkCommand(command, shellIn)
      shellIn = step.endsIn
      // A shell write made from inside the project is a change to it, the same
      // as a `write_file` under `<id>/`.
      if (step.wrote && (step.endsIn === projectId || shellIn === projectId)) return true
    }
  }
  return false
}

/** Guards against overcorrecting: not every message should create a project. */
export function noProjectCreated(result: EvalResult): boolean {
  return !result.toolCalls.some((c) => c.name === 'project_create')
}

/** The workspace-root runtime check passed (seeded template unmodified, no app at the root). */
export function workspaceRootClean(result: EvalResult): boolean {
  return result.runtimeChecks?.workspaceRootClean?.ok === true
}

// ---------------------------------------------------------------------------
// Shared criteria
//
// Every case is exactly three criteria at 34 / 33 / 33. The runner passes a
// case at >= 70%, so all three are load-bearing: missing any one of them
// leaves at most 67 points. That is deliberate — an earlier 40 + 35 + 15 + 10
// split let a run that never created a project (it wrote `portfolio/index.html`
// in the root instead) score 85 and "pass".
// ---------------------------------------------------------------------------

const NO_ROOT_BUILD: ValidationCriterion = {
  id: 'no-root-build',
  description: 'Writes no app files (src/, package.json, a stray .tsx/.html) anywhere outside a project folder',
  phase: 'execution',
  points: 34,
  validate: (r) => !builtInRoot(r),
}

const ROOT_STILL_CLEAN: ValidationCriterion = {
  id: 'workspace-root-clean',
  description: 'The workspace root still holds no app of its own after the run, and any seeded template is untouched',
  phase: 'execution',
  points: 33,
  validate: workspaceRootClean,
}

function createsAndDelegates(): ValidationCriterion {
  return {
    id: 'created-then-delegated',
    description: 'Calls project_create, then project_call (or mount) on the project it just created',
    phase: 'execution',
    points: 33,
    validate: createdThenDelegated,
  }
}

function worksInExistingProject(projectId: string): ValidationCriterion {
  return {
    id: 'used-existing-project',
    description: 'Works in the project the user already has, and creates no new one',
    phase: 'execution',
    points: 33,
    validate: (r) => usedExistingProject(r, projectId),
  }
}

/**
 * SHO-221 — a Personal workspace doesn't build. The agent must not reach for a
 * project at all, and must tell the user that building happens in their Team
 * workspace. The text check is loose on purpose (the exact wording is the
 * model's); the tool-call check is the load-bearing half.
 */
function redirectsToTeamWorkspace(): ValidationCriterion {
  return {
    id: 'redirects-to-team-workspace',
    description: 'Calls no project_* tool and says building happens in the Team workspace',
    phase: 'execution',
    points: 33,
    validate: (r) =>
      noProjectCreated(r) &&
      !r.toolCalls.some((c) => c.name.startsWith('project_') || c.name === 'connect_project' || c.name === 'copy_to_project') &&
      /team workspace/i.test(r.allResponseText),
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const WORKSPACE_BUILDS_EVALS: AgentEval[] = [
  {
    id: 'ws-build-portfolio-team',
    name: 'Builds a portfolio in a project, not in the workspace root',
    category: 'workspace-builds',
    level: 2,
    input: 'build me a one-page portfolio site',
    initialMode: 'none',
    workspaceRuntime: TEAM_EMPTY,
    toolMocks: WORKSPACE_TOOL_MOCKS,
    maxScore: 100,
    validationCriteria: [NO_ROOT_BUILD, ROOT_STILL_CLEAN, createsAndDelegates()],
  },
  {
    id: 'ws-build-trap-preseed',
    name: 'A pool-booted root that held the starter app still builds in a project',
    category: 'workspace-builds',
    level: 3,
    // The staging sequence, end to end: the warm pool pre-seeds its Vite app
    // into the root, the root boots as a workspace with that app in it, and the
    // platform clears the pre-seed at assign. This case seeds it and calls the
    // platform's own assign-time cleanup (`discardPoolPreseedAtAssign`), then
    // asks for a portfolio. On a runtime whose cleanup cannot describe a root
    // that already held last boot's pre-seed, the app survives and the agent
    // builds in it — the bug in session 545d935e.
    input: 'build me a one-page portfolio site',
    initialMode: 'none',
    workspaceRuntime: { ...TEAM_EMPTY, poolPreseedAtRoot: true },
    toolMocks: WORKSPACE_TOOL_MOCKS,
    maxScore: 100,
    validationCriteria: [NO_ROOT_BUILD, ROOT_STILL_CLEAN, createsAndDelegates()],
  },
  {
    id: 'ws-build-personal',
    name: 'Personal workspace: says building happens in the Team workspace, and builds nothing',
    category: 'workspace-builds',
    level: 2,
    input: 'make me a little app to track my runs',
    initialMode: 'none',
    workspaceRuntime: { kind: 'personal' },
    toolMocks: WORKSPACE_TOOL_MOCKS,
    maxScore: 100,
    validationCriteria: [NO_ROOT_BUILD, ROOT_STILL_CLEAN, redirectsToTeamWorkspace()],
  },
  {
    id: 'ws-build-phrasings',
    name: 'A non-technical build ask still goes through a project',
    category: 'workspace-builds',
    level: 3,
    // The ask names three things but only asks for the first now, so a project
    // has to be created — while still checking the agent plans the other two
    // somewhere rather than hand-building all three in the root.
    input:
      'I need three things eventually: a quick landing page for my bakery, a small browser game, ' +
      'and a dashboard for my sales CSV. Start with the bakery landing page.',
    initialMode: 'none',
    workspaceRuntime: TEAM_EMPTY,
    toolMocks: WORKSPACE_TOOL_MOCKS,
    maxScore: 100,
    validationCriteria: [NO_ROOT_BUILD, ROOT_STILL_CLEAN, createsAndDelegates()],
  },
  {
    id: 'ws-build-canvas-on',
    name: 'Builds in a project with the canvas capability on (the default surface)',
    category: 'workspace-builds',
    level: 2,
    // The capability axis. Every other case in the track boots with the canvas
    // off (`initialMode: 'none'`), which is the staging shape; this one boots
    // with it on, the default for a team workspace, where the agent has a
    // preview surface of its own to fall back on. A canvas must not become
    // "there is somewhere to build right here — use the root".
    input: 'build me a one-page portfolio site',
    initialMode: 'canvas',
    workspaceRuntime: TEAM_EMPTY,
    toolMocks: WORKSPACE_TOOL_MOCKS,
    maxScore: 100,
    validationCriteria: [NO_ROOT_BUILD, ROOT_STILL_CLEAN, createsAndDelegates()],
  },
  {
    id: 'ws-build-metal',
    name: 'Builds in a project on a metal (remote-project) workspace runtime',
    category: 'workspace-builds',
    level: 3,
    input: 'build me a one-page portfolio site',
    initialMode: 'none',
    workspaceRuntime: { ...TEAM_EMPTY, metal: true },
    toolMocks: WORKSPACE_TOOL_MOCKS,
    maxScore: 100,
    validationCriteria: [NO_ROOT_BUILD, ROOT_STILL_CLEAN, createsAndDelegates()],
  },
  {
    id: 'ws-build-existing-mounted',
    name: 'Adds a contact form to the mounted portfolio project',
    category: 'workspace-builds',
    level: 2,
    input: 'add a contact form to my portfolio',
    initialMode: 'none',
    workspaceRuntime: TEAM_WITH_PORTFOLIO_MOUNTED,
    toolMocks: WORKSPACE_TOOL_MOCKS,
    maxScore: 100,
    validationCriteria: [
      NO_ROOT_BUILD,
      ROOT_STILL_CLEAN,
      worksInExistingProject(PORTFOLIO_ID),
    ],
  },
  {
    id: 'ws-build-existing-unmounted',
    name: 'Reaches the unmounted portfolio project instead of a new one',
    category: 'workspace-builds',
    level: 3,
    input: 'add a contact form to my portfolio',
    initialMode: 'none',
    workspaceRuntime: TEAM_WITH_PORTFOLIO_UNMOUNTED,
    toolMocks: WORKSPACE_TOOL_MOCKS,
    maxScore: 100,
    validationCriteria: [
      NO_ROOT_BUILD,
      ROOT_STILL_CLEAN,
      worksInExistingProject(PORTFOLIO_ID),
    ],
  },
  {
    id: 'ws-build-followup',
    name: 'A follow-up change goes back to the same project',
    category: 'workspace-builds',
    level: 3,
    input: 'make the hero blue',
    initialMode: 'none',
    workspaceRuntime: TEAM_WITH_PORTFOLIO_MOUNTED,
    toolMocks: WORKSPACE_TOOL_MOCKS,
    conversationHistory: [
      { role: 'user', content: 'build me a one-page portfolio site' },
      {
        role: 'assistant',
        content:
          `I created the **portfolio** project (${PORTFOLIO_ID}) and asked its agent to build the one-page site. ` +
          `It is live in the preview there, and its files are mounted at \`${PORTFOLIO_ID}/\` — a ` +
          '`project_call` to that id is how a change reaches it.',
      },
    ],
    maxScore: 100,
    validationCriteria: [
      NO_ROOT_BUILD,
      ROOT_STILL_CLEAN,
      worksInExistingProject(PORTFOLIO_ID),
    ],
  },
  {
    id: 'ws-nonbuild-notes',
    name: 'Writing notes does not create a project',
    category: 'workspace-builds',
    level: 1,
    // The content is in the message on purpose: "write my notes from today"
    // alone left the agent asking which notes, and asking is not the behaviour
    // under test.
    input:
      'Write my notes from today into a file: standup at 10 with Ana, ship the landing page Friday, ' +
      'call the bank about the transfer.',
    initialMode: 'none',
    workspaceRuntime: TEAM_EMPTY,
    toolMocks: WORKSPACE_TOOL_MOCKS,
    maxScore: 100,
    validationCriteria: [
      NO_ROOT_BUILD,
      ROOT_STILL_CLEAN,
      {
        id: 'no-create-and-writes',
        description: 'Writes the notes into a root file (notes/… is fine) without creating a project',
        phase: 'execution',
        points: 33,
        validate: (r) =>
          noProjectCreated(r) && (usedTool(r, 'write_file') || usedTool(r, 'edit_file')),
      },
    ],
  },
  {
    id: 'ws-nonbuild-question',
    name: 'A stack question does not create a project or touch the root',
    category: 'workspace-builds',
    level: 1,
    input: 'what stack would you use for a portfolio?',
    initialMode: 'none',
    workspaceRuntime: TEAM_EMPTY,
    toolMocks: WORKSPACE_TOOL_MOCKS,
    maxScore: 100,
    validationCriteria: [
      NO_ROOT_BUILD,
      ROOT_STILL_CLEAN,
      {
        id: 'answers-without-creating',
        description: 'Answers with a stack recommendation and creates no project',
        phase: 'execution',
        points: 33,
        validate: (r) =>
          noProjectCreated(r) &&
          (responseContains(r, 'react') ||
            responseContains(r, 'vite') ||
            responseContains(r, 'next') ||
            responseContains(r, 'tailwind')),
      },
    ],
  },
]

export default WORKSPACE_BUILDS_EVALS
