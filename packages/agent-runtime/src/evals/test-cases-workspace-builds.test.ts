// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the workspace-build graders and cases (SHO-195).
 *
 * No LLM, no runtime, no network: every assertion is a pure function of an
 * `EvalResult` we build by hand, so this suite is free and runs anywhere.
 */

import { describe, expect, test } from 'bun:test'
import type { AgentEval, EvalResult, ToolCallRecord } from './types'
import {
  WORKSPACE_BUILDS_EVALS,
  WORKSPACE_TOOL_MOCKS,
  CREATED_ID,
  PORTFOLIO_ID,
  builtInRoot,
  createdThenDelegated,
  isRootAppPath,
  normalizeToolPath,
  noProjectCreated,
  usedExistingProject,
  workspaceRootClean,
} from './test-cases-workspace-builds'
import { compileInstallBody } from './tool-mocks-runtime'
import { WORKSPACE_ROOT_APP_ENTRIES } from './runtime-checks'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function call(name: string, input: Record<string, unknown>, output: unknown = {}): ToolCallRecord {
  return { name, input, output }
}

function result(
  toolCalls: ToolCallRecord[],
  extra: Partial<EvalResult> = {},
  text = '',
): EvalResult {
  return {
    toolCalls,
    finalTurnToolCalls: toolCalls,
    responseText: text,
    allResponseText: text,
    ...extra,
  } as unknown as EvalResult
}

function cleanRoot(): EvalResult['runtimeChecks'] {
  return {
    workspaceRootClean: { ok: true, forbidden: [], modified: [], missing: [], entries: [] },
  } as unknown as EvalResult['runtimeChecks']
}

function dirtyRoot(): EvalResult['runtimeChecks'] {
  return {
    workspaceRootClean: {
      ok: false,
      forbidden: ['src', 'package.json'],
      modified: ['package.json'],
      missing: [],
      entries: ['src', 'package.json', 'prisma'],
    },
  } as unknown as EvalResult['runtimeChecks']
}

function scoreOf(ev: AgentEval, r: EvalResult): { score: number; failed: string[] } {
  let score = 0
  const failed: string[] = []
  for (const c of ev.validationCriteria) {
    if (c.validate(r)) score += c.points
    else failed.push(c.id)
  }
  return { score, failed }
}

const IDEAL_TEXT =
  'Each of those goes in its own project: the bakery landing page (React + Vite), ' +
  'the browser game, and the sales dashboard. The project agent owns the code there.'

/** SHO-221: what a Personal workspace should say to "build me an app". */
const TEAM_REDIRECT_TEXT =
  "I don't build apps in this Personal workspace — building happens in your Team workspace, " +
  'Acme. Open the workspace switcher in the sidebar and pick it; I can help you shape the spec here.'

// ---------------------------------------------------------------------------
// The staging regression: session 545d935e
// ---------------------------------------------------------------------------

describe('builtInRoot', () => {
  test('catches the exact tool sequence from staging session 545d935e', () => {
    // Reproduced from the session: the workspace agent read the leftover pool
    // template in the root, edited its schema, installed a dep at the root and
    // built the app there, never calling project_create.
    const r = result([
      call('read_file', { path: 'src/App.tsx' }),
      call('read_file', { path: 'package.json' }),
      call('edit_file', { path: 'prisma/schema.prisma' }),
      call('exec', { command: 'bun add three' }),
      call('write_file', { path: 'src/components/Hero.tsx' }),
    ])
    expect(builtInRoot(r)).toBe(true)
  })

  test('passes a run that builds inside a project folder', () => {
    const r = result([
      call('project_create', { name: 'Portfolio site' }, { ok: true, project: { id: CREATED_ID } }),
      call('write_file', { path: `${CREATED_ID}/src/App.tsx` }),
      call('write_file', { path: `${CREATED_ID}/package.json` }),
      call('exec', { command: `cd ${CREATED_ID} && bun add three` }),
      call('project_call', { project: CREATED_ID, prompt: 'build the site' }),
    ])
    expect(builtInRoot(r)).toBe(false)
  })

  test('flags every root app path shape', () => {
    for (const path of [
      'src/App.tsx',
      './src/App.tsx',
      'package.json',
      'vite.config.ts',
      'index.html',
      'prisma/schema.prisma',
      'server.tsx',
      'custom-routes.ts',
      'tailwind.config.js',
      'tsconfig.node.json',
      'src/',
    ]) {
      expect(isRootAppPath(path)).toBe(true)
    }
  })

  test('agrees with the runtime check about which root entries are app artifacts', () => {
    // `runtime-checks.ts` polices the disk, this grader polices the tool calls:
    // they must not disagree about what counts as an app at the root.
    for (const entry of WORKSPACE_ROOT_APP_ENTRIES) {
      expect(isRootAppPath(entry)).toBe(true)
    }
  })

  test('does not flag project folders, docs or data files', () => {
    for (const path of [
      `${PORTFOLIO_ID}/src/App.tsx`,
      `${CREATED_ID}/package.json`,
      'AGENTS.md',
      'WORKSPACE.md',
      'notes/today.md',
      'data/sales.csv',
    ]) {
      expect(isRootAppPath(path)).toBe(false)
    }
  })

  test('flags a shell write into the root', () => {
    expect(builtInRoot(result([call('exec', { command: "cat > src/App.tsx <<'EOF'\nx\nEOF" })]))).toBe(true)
    expect(builtInRoot(result([call('exec', { command: 'echo x | tee package.json' })]))).toBe(true)
  })

  test('flags an install/build command that never enters a project', () => {
    for (const command of ['bun add three', 'bun install', 'npm install three', 'npx vite build', 'prisma db push']) {
      expect(builtInRoot(result([call('exec', { command })]))).toBe(true)
    }
  })

  test('accepts the same commands run inside a project folder', () => {
    for (const command of [
      `cd ${CREATED_ID} && bun add three`,
      `cd ./${CREATED_ID}/ && npm install`,
      `cd "${CREATED_ID}" && npx vite build`,
      `cd /tmp/${CREATED_ID} && prisma db push`,
    ]) {
      expect(builtInRoot(result([call('exec', { command })]))).toBe(false)
    }
  })

  test('a relative cd inside a project stays in the project', () => {
    // From the green run: the agent made a scratch copy under
    // `<project>/.tmp/contact-test` and ran `bun add hono` there. That is a
    // project build, not a root build — a relative cd cannot leave the folder.
    const r = result([
      call('exec', {
        command: `cd ${CREATED_ID} && mkdir -p .tmp/contact-test && cd .tmp/contact-test && bun add hono`,
      }),
    ])
    expect(builtInRoot(r)).toBe(false)
  })

  test('a cd that pops out of the project is back in the root', () => {
    const r = result([
      call('exec', { command: `cd ${CREATED_ID} && cd .. && bun install` }),
      call('exec', { command: `cd ${CREATED_ID} && cd .tmp/x && cd ../.. && bun install` }),
    ])
    expect(builtInRoot(r)).toBe(true)
  })

  test('an edit that failed wrote nothing and is not a root build', () => {
    // `edit_file { path: 'src/App.tsx' }` resolves against the workspace root,
    // so on a root with no app it returns `File not found`. Nothing was
    // written; `workspaceRootClean` is the gate on the outcome.
    const failed = result([
      call('edit_file', { path: 'src/App.tsx' }, { error: 'File not found: src/App.tsx' }),
    ])
    expect(builtInRoot(failed)).toBe(false)

    const wrote = result([
      call('edit_file', { path: 'src/App.tsx' }, { ok: true, replacements: 1 }),
    ])
    expect(builtInRoot(wrote)).toBe(true)
  })

  test('a read that merely names prisma or vite is not a root build', () => {
    // From a real red run: this was flagged as "bun add at the root".
    for (const command of [
      "cd /tmp/eval-worker-0 && ls node_modules | rg -i '^(prisma|@prisma)'",
      'ls node_modules/@tailwindcss; ls node_modules/@vitejs',
      "timeout 120 bun x tsc --noEmit -p .tmp/tsconfig.portfolio.json",
      'git status && rg -n "prisma" WORKSPACE.md',
    ]) {
      expect(builtInRoot(result([call('exec', { command })]))).toBe(false)
    }
  })

  test('ignores harmless commands and reads', () => {
    const r = result([
      call('exec', { command: 'ls -la' }),
      call('exec', { command: 'git status' }),
      call('read_file', { path: 'src/App.tsx' }),
    ])
    expect(builtInRoot(r)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// project_create → project_call
// ---------------------------------------------------------------------------

describe('createdThenDelegated', () => {
  test('true when the call targets the project that was just created', () => {
    const r = result([
      call('project_create', { name: 'Portfolio site' }, { ok: true, project: { id: CREATED_ID } }),
      call('project_call', { project: CREATED_ID, prompt: 'build it' }, { ok: true }),
    ])
    expect(createdThenDelegated(r)).toBe(true)
  })

  test('reads the id out of a stringified tool result too', () => {
    const r = result([
      call('project_create', { name: 'Portfolio site' }, JSON.stringify({ id: CREATED_ID })),
      call('project_call', { project: CREATED_ID, prompt: 'build it' }),
    ])
    expect(createdThenDelegated(r)).toBe(true)
  })

  test('false when the create is missing', () => {
    expect(createdThenDelegated(result([call('project_call', { project: CREATED_ID })]))).toBe(false)
  })

  test('false when nothing is delegated', () => {
    const r = result([
      call('project_create', { name: 'Portfolio site' }, { ok: true, project: { id: CREATED_ID } }),
      call('write_file', { path: `${CREATED_ID}/AGENTS.md` }),
    ])
    expect(createdThenDelegated(r)).toBe(false)
  })

  test('false when the call names a different project', () => {
    const r = result([
      call('project_create', { name: 'Portfolio site' }, { ok: true, project: { id: CREATED_ID } }),
      call('project_call', { project: PORTFOLIO_ID }),
    ])
    expect(createdThenDelegated(r)).toBe(false)
  })

  test('false when the call comes before the create', () => {
    const r = result([
      call('project_call', { project: CREATED_ID }),
      call('project_create', { name: 'Portfolio site' }, { ok: true, project: { id: CREATED_ID } }),
    ])
    expect(createdThenDelegated(r)).toBe(false)
  })

  test('credits a good create after a rejected one', () => {
    const r = result([
      call('project_create', { project: 'run-tracker', message: 'placeholder' }, 'Validation failed: name is required'),
      call('project_create', { name: 'Run Tracker' }, { ok: true, project: { id: CREATED_ID } }),
      call('project_call', { project: CREATED_ID, message: 'build it' }, { ok: true }),
    ])
    expect(createdThenDelegated(r)).toBe(true)
  })
})

describe('usedExistingProject', () => {
  test('true when the agent calls the project the user already has', () => {
    expect(usedExistingProject(result([call('project_call', { project: PORTFOLIO_ID })]), PORTFOLIO_ID)).toBe(true)
  })

  test('true when the agent edits under the project folder', () => {
    expect(
      usedExistingProject(result([call('write_file', { path: `${PORTFOLIO_ID}/src/App.tsx` })]), PORTFOLIO_ID),
    ).toBe(true)
  })

  test('false when the agent creates a second project', () => {
    const r = result([
      call('project_call', { project: PORTFOLIO_ID }),
      call('project_create', { name: 'Portfolio 2' }, { ok: true, project: { id: CREATED_ID } }),
    ])
    expect(usedExistingProject(r, PORTFOLIO_ID)).toBe(false)
  })

  test('false when the agent only touches the root', () => {
    expect(usedExistingProject(result([call('write_file', { path: 'src/App.tsx' })]), PORTFOLIO_ID)).toBe(false)
  })

  test('true when a shell write happens inside the project', () => {
    const r = result([
      call('exec', { command: `cd ${PORTFOLIO_ID} && ls` }),
      call('exec', { command: "cat > src/App.tsx <<'EOF'\nx\nEOF" }),
    ])
    expect(usedExistingProject(r, PORTFOLIO_ID)).toBe(true)
  })

  test('false when a shell write happens in the root', () => {
    const r = result([call('exec', { command: "cat > src/App.tsx <<'EOF'\nx\nEOF" })])
    expect(usedExistingProject(r, PORTFOLIO_ID)).toBe(false)
  })
})

describe('workspaceRootClean', () => {
  test('follows the runtime check', () => {
    expect(workspaceRootClean(result([], { runtimeChecks: cleanRoot() }))).toBe(true)
    expect(workspaceRootClean(result([], { runtimeChecks: dirtyRoot() }))).toBe(false)
  })

  test('is false when the check did not run', () => {
    expect(workspaceRootClean(result([]))).toBe(false)
  })

  test('noProjectCreated is false once project_create is called', () => {
    expect(noProjectCreated(result([call('exec', { command: 'ls' })]))).toBe(true)
    expect(noProjectCreated(result([call('project_create', { name: 'x' })]))).toBe(false)
  })
})

describe('normalizeToolPath', () => {
  test('strips ./ and leading slashes', () => {
    expect(normalizeToolPath('./src/App.tsx')).toBe('src/App.tsx')
    expect(normalizeToolPath('/src/App.tsx')).toBe('src/App.tsx')
    expect(normalizeToolPath('  src\\App.tsx ')).toBe('src/App.tsx')
  })
})

// ---------------------------------------------------------------------------
// The case set
// ---------------------------------------------------------------------------

describe('WORKSPACE_BUILDS_EVALS', () => {
  test('has the 11 cases, all in the workspace-builds track, with unique ids', () => {
    expect(WORKSPACE_BUILDS_EVALS.length).toBe(11)
    const ids = WORKSPACE_BUILDS_EVALS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const ev of WORKSPACE_BUILDS_EVALS) {
      expect(ev.category).toBe('workspace-builds')
      expect(ev.maxScore).toBe(100)
      expect(ev.workspaceRuntime).toBeDefined()
      expect(ev.input.length).toBeGreaterThan(10)
    }
  })

  test('every case carries the three load-bearing criteria', () => {
    for (const ev of WORKSPACE_BUILDS_EVALS) {
      const ids = ev.validationCriteria.map((c) => c.id)
      expect(ids).toContain('no-root-build')
      expect(ids).toContain('workspace-root-clean')
      // Exactly three criteria, so each one decides pass/fail on its own.
      expect(ev.validationCriteria.length).toBe(3)
      for (const c of ev.validationCriteria) {
        // The runner passes a case at >= 70%: missing any single criterion has
        // to leave the case below that.
        expect(ev.maxScore - c.points).toBeLessThan(70)
      }
    }
  })

  test('criteria add up to exactly maxScore', () => {
    for (const ev of WORKSPACE_BUILDS_EVALS) {
      const total = ev.validationCriteria.reduce((n, c) => n + c.points, 0)
      expect(total).toBe(ev.maxScore)
    }
  })

  test('the trap case seeds the template into the root; the plain case does not', () => {
    const trap = WORKSPACE_BUILDS_EVALS.find((e) => e.id === 'ws-build-trap-preseed')!
    const plain = WORKSPACE_BUILDS_EVALS.find((e) => e.id === 'ws-build-portfolio-team')!
    expect(trap.workspaceRuntime?.poolPreseedAtRoot).toBe(true)
    expect(plain.workspaceRuntime?.poolPreseedAtRoot).toBeFalsy()
  })

  test('the build cases mock project_create so no real project is spawned', () => {
    for (const ev of WORKSPACE_BUILDS_EVALS) {
      expect(ev.toolMocks?.project_create).toBeDefined()
    }
  })

  test('every case mocks the workspace tools that would otherwise reach the API', () => {
    // Unmocked, these 401 inside an eval and the turn ends "I couldn't confirm
    // the result" instead of reporting a build (QA round 1), or the metal path
    // reads as a broken session (QA round 2).
    for (const ev of WORKSPACE_BUILDS_EVALS) {
      for (const tool of [
        'project_create',
        'project_call',
        'preview_project',
        'share_file',
        'mount_project',
        'unmount_project',
        'connect_project',
        'goal_create',
        'goal_log',
        'exec',
      ]) {
        expect(ev.toolMocks?.[tool]).toBeDefined()
      }
    }
  })

  test('a project-scoped tool answers, while a plain call still runs for real', async () => {
    // The mocks must not swallow the agent's own work: grading reads the files
    // a real call writes here, so only the `project` arm is answered.
    const { fns } = compileInstallBody(WORKSPACE_TOOL_MOCKS, { sleepFn: async () => {} })
    const plain = { command: 'ls', path: 'src/App.tsx', query: 'portfolio' }
    for (const tool of [
      'exec',
      'read_file',
      'write_file',
      'edit_file',
      'delete_file',
      'search',
      'exec_wait',
      'exec_list',
      'copy_to_project',
    ]) {
      expect(await fns[tool](plain)).toBe('__passthrough')
      expect(await fns[tool]({ ...plain, project: CREATED_ID })).not.toBe('__passthrough')
    }
    expect(await fns.connect_project({ project: PORTFOLIO_ID })).toMatchObject({
      ok: true,
      reachable: true,
      readOnly: false,
    })
  })

  test('the canvas case is the track\'s one capability axis', () => {
    // Every other case runs the staging shape, canvas off. A duplicate that
    // also ran canvas-off would test nothing (QA round 1).
    const canvasOn = WORKSPACE_BUILDS_EVALS.filter((e) => e.initialMode === 'canvas')
    expect(canvasOn.map((e) => e.id)).toEqual(['ws-build-canvas-on'])
    for (const ev of WORKSPACE_BUILDS_EVALS) {
      if (ev.id === 'ws-build-canvas-on') continue
      expect(ev.initialMode).toBe('none')
    }
  })
})

// ---------------------------------------------------------------------------
// Each case scores a good run and fails a root build
// ---------------------------------------------------------------------------

describe('case scoring', () => {
  /** A result that does the right thing for this particular case. */
  function idealFor(ev: AgentEval): EvalResult {
    const isExisting = ev.validationCriteria.some(
      (c) => c.id === 'used-existing-project' || c.id === 'same-project-followup',
    )
    const isBuild = ev.validationCriteria.some((c) => c.id === 'created-then-delegated')
    const isRedirect = ev.validationCriteria.some((c) => c.id === 'redirects-to-team-workspace')

    if (isRedirect) {
      // SHO-221: a Personal workspace builds nothing and points at the Team
      // workspace instead — no project tool is even available to call.
      return result([call('read_file', { path: 'AGENTS.md' })], { runtimeChecks: cleanRoot() }, TEAM_REDIRECT_TEXT)
    }
    if (!isBuild && !isExisting) {
      return result([call('write_file', { path: 'notes/today.md' })], { runtimeChecks: cleanRoot() }, IDEAL_TEXT)
    }
    if (isExisting) {
      return result(
        [call('project_call', { project: PORTFOLIO_ID, prompt: 'make the hero blue' })],
        { runtimeChecks: cleanRoot() },
        IDEAL_TEXT,
      )
    }
    return result(
      [
        call('project_create', { name: 'Bakery site' }, { ok: true, project: { id: CREATED_ID } }),
        call('project_call', { project: CREATED_ID, prompt: 'build the one-page site' }),
      ],
      { runtimeChecks: cleanRoot() },
      IDEAL_TEXT,
    )
  }

  for (const ev of WORKSPACE_BUILDS_EVALS) {
    test(`${ev.id}: a correct run passes`, () => {
      const { score, failed } = scoreOf(ev, idealFor(ev))
      expect(failed).toEqual([])
      expect(score).toBe(100)
    })

    test(`${ev.id}: building in the root fails`, () => {
      const good = idealFor(ev)
      const bad = result(
        [...good.toolCalls, call('write_file', { path: 'src/App.tsx' })],
        { runtimeChecks: dirtyRoot() },
        IDEAL_TEXT,
      )
      expect(scoreOf(ev, bad).score).toBeLessThan(70)
    })

    test(`${ev.id}: claiming success without the project work fails`, () => {
      // What staging session 545d935e (and the first red run here) actually
      // did: no project, and the app hand-built in the root.
      const handBuilt = result(
        [
          call('exec', { command: 'ls -la' }),
          call('write_file', { path: 'portfolio/index.html', content: '<html></html>' }),
        ],
        { runtimeChecks: dirtyRoot() },
        'I built your portfolio.',
      )
      expect(scoreOf(ev, handBuilt).score).toBeLessThan(70)
    })
  }

  test('ws-build-personal: delegating to a hidden builder project fails', () => {
    // The old behaviour (SHO-221): project_create + project_call from a
    // Personal workspace, which produced a project that never ran.
    const ev = WORKSPACE_BUILDS_EVALS.find((e) => e.id === 'ws-build-personal')!
    const delegated = result(
      [
        call('project_create', { name: 'Run tracker' }, { ok: true, project: { id: CREATED_ID } }),
        call('project_call', { project: CREATED_ID, prompt: 'build a run tracker app' }),
      ],
      { runtimeChecks: cleanRoot() },
      'Done — your app is being built.',
    )
    expect(scoreOf(ev, delegated).score).toBeLessThan(70)
  })
})

describe('the staging shape, end to end', () => {
  test('a root-only run of the plain portfolio case scores under the bar', () => {
    const ev = WORKSPACE_BUILDS_EVALS.find((e) => e.id === 'ws-build-portfolio-team')!
    // Reproduced from the first red run: the agent inspected the root, then
    // wrote `portfolio/index.html` beside it and never called project_create.
    const r = result(
      [
        call('exec', { command: 'pwd; ls -la' }),
        call('exec', { command: 'rg --files project' }),
        call('write_file', { path: 'portfolio/index.html', content: '<!doctype html><html></html>' }),
      ],
      { runtimeChecks: cleanRoot() },
      'Your portfolio is ready in portfolio/index.html.',
    )
    expect(builtInRoot(r)).toBe(true)
    expect(scoreOf(ev, r).score).toBeLessThan(70)
  })

  test('an app folder with a manifest counts as a root build', () => {
    expect(isRootAppPath('bakery/package.json')).toBe(true)
    expect(isRootAppPath('bakery/src/App.tsx')).toBe(true)
    expect(builtInRoot(result([call('write_file', { path: 'bakery/index.html' })]))).toBe(true)
  })

  test('a project-addressed write is not a root build (metal runtime)', () => {
    const r = result([call('write_file', { path: 'src/App.tsx', project: CREATED_ID })])
    expect(builtInRoot(r)).toBe(false)
  })

  test('replays the shell cwd: a heredoc after cd <project> writes in the project', () => {
    // From a green run: the agent cd'd into the project, then wrote App.tsx
    // through the shell. The shell keeps its cwd, so that write is the
    // project's — but a `write_file` in the same run is still root-relative.
    const r = result([
      call('exec', { command: `cd ${PORTFOLIO_ID} && ls` }),
      call('exec', { command: "cat > src/App.tsx <<'EOF'\nconst page = 1\nEOF" }),
      call('read_file', { path: 'src/App.tsx' }),
    ])
    expect(builtInRoot(r)).toBe(false)
  })

  test('a file tool still writes in the root even after the shell cd', () => {
    const r = result([
      call('exec', { command: `cd ${PORTFOLIO_ID} && ls` }),
      call('write_file', { path: 'src/App.tsx', content: 'x' }),
    ])
    expect(builtInRoot(r)).toBe(true)
  })

  test('cd .. leaves the project again', () => {
    const r = result([
      call('exec', { command: `cd ${PORTFOLIO_ID} && ls` }),
      call('exec', { command: "cd .. && cat > src/App.tsx <<'EOF'\nx\nEOF" }),
    ])
    expect(builtInRoot(r)).toBe(true)
  })

  test('root notes and memory are not app files', () => {
    for (const path of ['notes/today.md', 'memory/2026-10-24.md', 'AGENTS.md', 'data/sales.csv']) {
      expect(isRootAppPath(path)).toBe(false)
    }
  })
})
